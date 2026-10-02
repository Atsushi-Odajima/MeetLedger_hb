// RFC 5545 subset parser for calendar import (no external dependencies).
// Supported: VEVENT UID / DTSTART / DTEND / DURATION (UTC "Z", TZID=<IANA or common Windows name>, floating, VALUE=DATE all-day),
// SUMMARY, DESCRIPTION, LOCATION, STATUS, ORGANIZER, ATTENDEE (CN + mailto), RRULE FREQ=DAILY|WEEKLY with INTERVAL / COUNT /
// UNTIL / BYDAY (weekly), EXDATE, RECURRENCE-ID overrides, line unfolding, TEXT unescaping, size limits.
// Unsupported recurrence rules (MONTHLY, YEARLY, BYMONTHDAY, BYSETPOS, ordinal BYDAY, RDATE...) yield only the first
// instance with flag `rrule_unsupported` — never silently invented occurrences.

export class IcsError extends Error {
  constructor(
    public code: 'too_large' | 'not_ics' | 'too_many_events',
    message: string,
  ) {
    super(message);
  }
}

export interface IcsDateValue {
  kind: 'date' | 'utc' | 'zoned' | 'floating';
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Resolved IANA zone (kind 'zoned'). */
  tzid?: string;
}

export interface IcsPerson {
  name: string | null;
  email: string | null;
}

export interface IcsRrule {
  freq: string;
  interval: number;
  count?: number;
  until?: IcsDateValue;
  /** 0 = Sunday … 6 = Saturday */
  byDay?: number[];
  unsupported?: string;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  status: string | null;
  organizer: IcsPerson | null;
  attendees: IcsPerson[];
  start: IcsDateValue;
  end: IcsDateValue | null;
  durationMs: number | null;
  rrule: IcsRrule | null;
  exdates: IcsDateValue[];
  recurrenceId: IcsDateValue | null;
  warnings: string[];
}

export interface IcsParseResult {
  events: IcsEvent[];
  calendarName: string | null;
  warnings: string[];
}

export interface IcsOccurrence {
  uid: string;
  /** Stable per-occurrence key: UID for single events, UID::<original start> for recurring instances. */
  key: string;
  /** UID when the event belongs to a recurring series. */
  seriesKey: string | null;
  recurrence: 'daily' | 'weekly' | null;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  timezone: string | null;
  organizer: IcsPerson | null;
  attendees: IcsPerson[];
  location: string | null;
  flags: string[];
}

export interface IcsLimits {
  maxBytes?: number;
  maxEvents?: number;
}

// ------------------------------------------------------------------ time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = fmt(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock time in an IANA zone to a UTC epoch (DST aware). */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): number {
  if (tz === 'UTC' || tz === 'Etc/UTC') return Date.UTC(y, m - 1, d, h, mi, s);
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz);
  return t;
}

/** Common Windows (Outlook / Exchange) zone names → IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'e. europe standard time': 'Europe/Chisinau',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
};

export function resolveTimeZone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const tz = raw.replace(/^"|"$/g, '').trim();
  if (!tz) return null;
  if (isValidTimeZone(tz) && tz.length < 64) return tz;
  const win = WINDOWS_ZONES[tz.toLowerCase()];
  if (win) return win;
  // e.g. "/mozilla.org/20050126_1/Asia/Tokyo" or "(UTC+09:00) Osaka, Sapporo, Tokyo"
  const segs = tz.split('/').filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    if (segs.length >= n) {
      const cand = segs.slice(-n).join('/');
      if (/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(cand) && isValidTimeZone(cand)) return cand;
    }
  }
  if (/tokyo|osaka|sapporo/i.test(tz)) return 'Asia/Tokyo';
  return null;
}

// ------------------------------------------------------------------ content lines

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (c === sep && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseContentLine(line: string): ContentLine | null {
  let q = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = splitOutsideQuotes(line.slice(0, colon), ';');
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseDateValue(value: string, params: Record<string, string>, calendarTz: string | null, warnings: string[]): IcsDateValue | null {
  const v = value.trim();
  const dm = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dm || params.VALUE === 'DATE') {
    const m2 = dm ?? v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m2) return null;
    return { kind: 'date', y: +m2[1], m: +m2[2], d: +m2[3], h: 0, mi: 0, s: 0 };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const base = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  if (m[7]) return { kind: 'utc', ...base };
  if (params.TZID) {
    const tz = resolveTimeZone(params.TZID);
    if (tz) return { kind: 'zoned', tzid: tz, ...base };
    warnings.push('unknown_tzid');
    return { kind: 'floating', ...base };
  }
  if (calendarTz) return { kind: 'zoned', tzid: calendarTz, ...base };
  return { kind: 'floating', ...base };
}

function parseDuration(v: string): number | null {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

function parsePerson(cl: ContentLine): IcsPerson {
  const raw = cl.value.trim().replace(/^mailto:/i, '');
  const email = EMAIL_RE.test(raw) ? raw.toLowerCase().slice(0, 254) : null;
  const cn = cl.params.CN ? unescapeText(cl.params.CN).trim().slice(0, 100) : null;
  return { name: cn || null, email };
}

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(v: string, calendarTz: string | null, warnings: string[]): IcsRrule {
  const parts: Record<string, string> = {};
  for (const p of v.split(';')) {
    const eq = p.indexOf('=');
    if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).toUpperCase();
  }
  const r: IcsRrule = { freq: parts.FREQ ?? '', interval: Math.min(1000, Math.max(1, Number.parseInt(parts.INTERVAL ?? '1', 10) || 1)) };
  if (parts.COUNT) r.count = Math.min(10000, Math.max(1, Number.parseInt(parts.COUNT, 10) || 1));
  if (parts.UNTIL) r.until = parseDateValue(parts.UNTIL, {}, calendarTz, warnings) ?? undefined;
  if (!['DAILY', 'WEEKLY'].includes(r.freq)) r.unsupported = `FREQ=${r.freq || '?'}`;
  for (const k of ['BYMONTH', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS', 'BYHOUR', 'BYMINUTE', 'BYSECOND']) if (parts[k]) r.unsupported = k;
  if (parts.BYDAY) {
    const days: number[] = [];
    for (const d of parts.BYDAY.split(',')) {
      const code = d.trim();
      if (!(code in DAY_CODES)) {
        r.unsupported = 'BYDAY ordinal';
        break;
      }
      days.push(DAY_CODES[code]);
    }
    if (r.freq === 'DAILY' && days.length) r.unsupported = 'DAILY+BYDAY';
    r.byDay = [...new Set(days)];
  }
  return r;
}

// ------------------------------------------------------------------ parse

export function parseIcs(text: string, limits: IcsLimits = {}): IcsParseResult {
  const maxBytes = limits.maxBytes ?? 2_000_000;
  const maxEvents = limits.maxEvents ?? 5000;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new IcsError('too_large', `ICS exceeds ${maxBytes} bytes`);
  const unfolded = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  if (!/^BEGIN:VCALENDAR/im.test(unfolded)) throw new IcsError('not_ics', 'Not an iCalendar file');
  const lines = unfolded.split('\n');
  const warnings: string[] = [];
  const events: IcsEvent[] = [];
  let calendarName: string | null = null;
  let calendarTz: string | null = null;
  const stack: string[] = [];
  let cur: ContentLine[] | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cl = parseContentLine(line);
    if (!cl) continue;
    if (cl.name === 'BEGIN') {
      const comp = cl.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') cur = [];
      continue;
    }
    if (cl.name === 'END') {
      const comp = cl.value.trim().toUpperCase();
      // tolerate malformed nesting: pop until the matching component
      while (stack.length && stack[stack.length - 1] !== comp) stack.pop();
      stack.pop();
      if (comp === 'VEVENT' && cur) {
        const ev = buildEvent(cur, calendarTz);
        if (ev) {
          events.push(ev);
          warnings.push(...ev.warnings);
          if (events.length > maxEvents) throw new IcsError('too_many_events', `ICS contains more than ${maxEvents} events`);
        } else warnings.push('event_without_dtstart');
        cur = null;
      }
      continue;
    }
    if (stack.length === 1 && stack[0] === 'VCALENDAR') {
      if (cl.name === 'X-WR-CALNAME') calendarName = unescapeText(cl.value).slice(0, 200);
      if (cl.name === 'X-WR-TIMEZONE') calendarTz = resolveTimeZone(cl.value);
      continue;
    }
    // Only direct VEVENT properties (VALARM etc. nested inside are ignored).
    if (cur && stack.length === 2 && stack[1] === 'VEVENT') cur.push(cl);
  }
  return { events, calendarName, warnings: [...new Set(warnings)] };
}

function buildEvent(props: ContentLine[], calendarTz: string | null): IcsEvent | null {
  const warnings: string[] = [];
  const get = (n: string) => props.find((p) => p.name === n);
  const dtstart = get('DTSTART');
  if (!dtstart) return null;
  const start = parseDateValue(dtstart.value, dtstart.params, calendarTz, warnings);
  if (!start) return null;
  const dtend = get('DTEND');
  const end = dtend ? parseDateValue(dtend.value, dtend.params, calendarTz, warnings) : null;
  const dur = get('DURATION');
  const rr = get('RRULE');
  const rid = get('RECURRENCE-ID');
  const exdates: IcsDateValue[] = [];
  for (const ex of props.filter((p) => p.name === 'EXDATE')) {
    for (const v of ex.value.split(',')) {
      const d = parseDateValue(v, ex.params, calendarTz, warnings);
      if (d) exdates.push(d);
    }
  }
  if (props.some((p) => p.name === 'RDATE')) warnings.push('rdate_ignored');
  const summary = get('SUMMARY');
  const uidLine = get('UID');
  const uid = uidLine?.value.trim() || `nouid-${start.y}${start.m}${start.d}${start.h}${start.mi}-${(summary?.value ?? '').slice(0, 40)}`;
  if (!uidLine) warnings.push('missing_uid');
  return {
    uid: uid.slice(0, 500),
    summary: summary ? unescapeText(summary.value).trim().slice(0, 300) || '(無題)' : '(無題)',
    description: get('DESCRIPTION') ? unescapeText(get('DESCRIPTION')!.value).slice(0, 10000) : null,
    location: get('LOCATION') ? unescapeText(get('LOCATION')!.value).slice(0, 300) : null,
    status: get('STATUS')?.value.trim().toUpperCase() ?? null,
    organizer: get('ORGANIZER') ? parsePerson(get('ORGANIZER')!) : null,
    attendees: props.filter((p) => p.name === 'ATTENDEE').slice(0, 500).map(parsePerson),
    start,
    end,
    durationMs: dur ? parseDuration(dur.value) : null,
    rrule: rr ? parseRrule(rr.value, calendarTz, warnings) : null,
    exdates,
    recurrenceId: rid ? parseDateValue(rid.value, rid.params, calendarTz, warnings) : null,
    warnings,
  };
}

// ------------------------------------------------------------------ expansion

const DAY = 86_400_000;

function civil(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}
function civilParts(ms: number) {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const dateStr = (p: { y: number; m: number; d: number }) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const compactUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function expansionZone(v: IcsDateValue, defaultTz: string): string {
  if (v.kind === 'utc') return 'UTC';
  if (v.kind === 'zoned' && v.tzid) return v.tzid;
  return defaultTz;
}

export function dateValueToUtc(v: IcsDateValue, defaultTz: string): number {
  if (v.kind === 'utc') return Date.UTC(v.y, v.m - 1, v.d, v.h, v.mi, v.s);
  return zonedToUtc(v.y, v.m, v.d, v.h, v.mi, v.s, expansionZone(v, defaultTz));
}

interface RawOcc {
  /** original (rule-generated) start; identifies the instance */
  originalStart: number;
  ev: IcsEvent;
  start: number;
  end: number | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  zone: string;
}

function durationOf(ev: IcsEvent, defaultTz: string): { ms: number | null; days: number } {
  if (ev.start.kind === 'date') {
    if (ev.end && ev.end.kind === 'date') return { ms: null, days: Math.max(1, Math.round((civil(ev.end.y, ev.end.m, ev.end.d) - civil(ev.start.y, ev.start.m, ev.start.d)) / DAY)) };
    if (ev.durationMs) return { ms: null, days: Math.max(1, Math.round(ev.durationMs / DAY)) };
    return { ms: null, days: 1 };
  }
  if (ev.end) return { ms: Math.max(0, dateValueToUtc(ev.end, defaultTz) - dateValueToUtc(ev.start, defaultTz)), days: 0 };
  if (ev.durationMs != null) return { ms: Math.max(0, ev.durationMs), days: 0 };
  return { ms: null, days: 0 };
}

function makeOcc(ev: IcsEvent, y: number, m: number, d: number, defaultTz: string, dur: { ms: number | null; days: number }): RawOcc {
  const s = ev.start;
  const zone = expansionZone(s, defaultTz);
  if (s.kind === 'date') {
    const start = zonedToUtc(y, m, d, 0, 0, 0, defaultTz);
    const endCivil = civilParts(civil(y, m, d) + dur.days * DAY);
    return {
      originalStart: start,
      ev,
      start,
      end: zonedToUtc(endCivil.y, endCivil.m, endCivil.d, 0, 0, 0, defaultTz),
      allDay: true,
      startDate: dateStr({ y, m, d }),
      endDate: dateStr(endCivil),
      zone: defaultTz,
    };
  }
  const start = s.kind === 'utc' ? Date.UTC(y, m - 1, d, s.h, s.mi, s.s) : zonedToUtc(y, m, d, s.h, s.mi, s.s, zone);
  return { originalStart: start, ev, start, end: dur.ms != null ? start + dur.ms : null, allDay: false, startDate: null, endDate: null, zone };
}

function untilMs(until: IcsDateValue, ev: IcsEvent, defaultTz: string): number {
  if (until.kind === 'date') {
    const z = expansionZone(ev.start, defaultTz);
    return zonedToUtc(until.y, until.m, until.d, 23, 59, 59, z);
  }
  if (until.kind === 'utc') return Date.UTC(until.y, until.m - 1, until.d, until.h, until.mi, until.s);
  return zonedToUtc(until.y, until.m, until.d, until.h, until.mi, until.s, expansionZone(ev.start, defaultTz));
}

/** Generates rule occurrences (original starts) up to rangeEnd. Pure civil-date arithmetic in the event's zone (DST safe). */
function generate(ev: IcsEvent, rangeEnd: number, defaultTz: string, dur: { ms: number | null; days: number }): RawOcc[] {
  const r = ev.rrule!;
  const out: RawOcc[] = [];
  const s = ev.start;
  const base = civil(s.y, s.m, s.d);
  const until = r.until ? untilMs(r.until, ev, defaultTz) : Number.POSITIVE_INFINITY;
  const maxCount = r.count ?? Number.POSITIVE_INFINITY;
  let emitted = 0;
  let guard = 0;
  const emit = (dayMs: number): boolean => {
    const p = civilParts(dayMs);
    const occ = makeOcc(ev, p.y, p.m, p.d, defaultTz, dur);
    if (occ.originalStart > until) return false;
    if (occ.originalStart >= rangeEnd) return false;
    emitted++;
    out.push(occ);
    return emitted < maxCount;
  };
  if (r.freq === 'DAILY') {
    for (let k = 0; guard++ < 100_000; k++) if (!emit(base + k * r.interval * DAY)) break;
    return out;
  }
  // WEEKLY (WKST=MO)
  const startDow = civilParts(base).dow;
  const days = (r.byDay?.length ? r.byDay : [startDow]).map((d) => (d + 6) % 7).sort((a, b) => a - b);
  const weekStart = base - ((startDow + 6) % 7) * DAY;
  outer: for (let w = 0; guard++ < 100_000; w += r.interval) {
    for (const off of days) {
      const day = weekStart + (w * 7 + off) * DAY;
      if (day < base) continue;
      if (!emit(day)) break outer;
    }
  }
  return out;
}

/**
 * Expands parsed events into concrete occurrences overlapping [from, to).
 * `defaultTz` is used for floating times and all-day dates (the importing user's time zone).
 */
export function expandIcs(parsed: IcsParseResult, range: { from: Date; to: Date }, defaultTz: string, maxOccurrences = 2000): { occurrences: IcsOccurrence[]; truncated: boolean } {
  const from = range.from.getTime();
  const to = range.to.getTime();
  const byUid = new Map<string, { master: IcsEvent | null; overrides: IcsEvent[] }>();
  for (const ev of parsed.events) {
    const g = byUid.get(ev.uid) ?? { master: null, overrides: [] };
    if (ev.recurrenceId) g.overrides.push(ev);
    else if (!g.master) g.master = ev;
    byUid.set(ev.uid, g);
  }
  const result: IcsOccurrence[] = [];
  const keyFor = (uid: string, recurring: boolean, occ: RawOcc) => (recurring ? `${uid}::${occ.allDay ? occ.startDate!.replace(/-/g, '') : compactUtc(occ.originalStart)}` : uid);

  for (const [uid, g] of byUid) {
    const master = g.master;
    const recurring = !!master?.rrule && !master.rrule.unsupported;
    const recurrence: IcsOccurrence['recurrence'] = recurring ? (master!.rrule!.freq === 'DAILY' ? 'daily' : 'weekly') : null;
    const overrideByStart = new Map<number, IcsEvent>();
    for (const o of g.overrides) overrideByStart.set(dateValueToUtc(o.recurrenceId!, defaultTz), o);
    const consumed = new Set<IcsEvent>();
    const raws: RawOcc[] = [];
    if (master) {
      const dur = durationOf(master, defaultTz);
      if (recurring) {
        const exStarts = new Set(master.exdates.map((x) => (x.kind === 'date' ? `d:${dateStr(x)}` : `t:${dateValueToUtc(x, defaultTz)}`)));
        for (const occ of generate(master, to, defaultTz, dur)) {
          if (exStarts.has(occ.allDay ? `d:${occ.startDate}` : `t:${occ.originalStart}`)) continue;
          const ov = overrideByStart.get(occ.originalStart);
          if (ov) {
            consumed.add(ov);
            if (ov.status === 'CANCELLED') continue;
            const od = durationOf(ov, defaultTz);
            const moved = makeOcc(ov, ov.start.y, ov.start.m, ov.start.d, defaultTz, od);
            raws.push({ ...moved, originalStart: occ.originalStart });
            continue;
          }
          raws.push(occ);
        }
      } else if (master.status !== 'CANCELLED') {
        raws.push(makeOcc(master, master.start.y, master.start.m, master.start.d, defaultTz, dur));
      }
    }
    // Overrides whose original slot was not generated in range (moved into range) or whose master is missing.
    for (const ov of g.overrides) {
      if (consumed.has(ov) || ov.status === 'CANCELLED') continue;
      const occ = makeOcc(ov, ov.start.y, ov.start.m, ov.start.d, defaultTz, durationOf(ov, defaultTz));
      raws.push({ ...occ, originalStart: dateValueToUtc(ov.recurrenceId!, defaultTz) });
    }
    for (const occ of raws) {
      const endEff = occ.end ?? occ.start;
      if (!(occ.start < to && (endEff > from || occ.start >= from))) continue;
      const isInstance = recurring || occ.ev.recurrenceId != null;
      const flags = [...new Set([...occ.ev.warnings, ...(master?.rrule?.unsupported ? ['rrule_unsupported'] : []), ...(occ.allDay ? ['all_day'] : [])])];
      result.push({
        uid,
        key: keyFor(uid, isInstance, occ),
        seriesKey: recurring ? uid : null,
        recurrence,
        title: occ.ev.summary,
        start: new Date(occ.start).toISOString(),
        end: occ.end != null ? new Date(occ.end).toISOString() : null,
        allDay: occ.allDay,
        startDate: occ.startDate,
        endDate: occ.endDate,
        timezone: occ.allDay ? null : occ.zone,
        organizer: occ.ev.organizer,
        attendees: occ.ev.attendees,
        location: occ.ev.location,
        flags,
      });
    }
  }
  result.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
  return { occurrences: result.slice(0, maxOccurrences), truncated: result.length > maxOccurrences };
}
