// Scope hints for cross-meeting ask: relative dates, people, projects/clients, intent (entity types / status).
// Hints can only NARROW retrieval (they are AND-ed with the ACL predicate in SQL); nothing in the question can widen it.
import { normalizeText } from '@meetledger/shared';
import { extractKeywords, norm } from './text';

// ------------------------------------------------------------------ time zone helpers (no external libs)

export function safeTz(tz: string | null | undefined): string {
  if (!tz) return 'Asia/Tokyo';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Tokyo';
  }
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function tzParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD.indexOf(p.weekday) };
}

function offsetMs(d: Date, tz: string): number {
  const p = tzParts(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight y-m-d in `tz` (month/day overflow allowed, like Date.UTC). */
export function zonedStart(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(new Date(guess), tz);
  const o2 = offsetMs(new Date(t), tz);
  t = guess - o2;
  return new Date(t);
}

/** YYYY-MM-DD of an instant in `tz`. */
export function localDate(d: Date | string | null | undefined, tz: string): string | null {
  if (!d) return null;
  const p = tzParts(new Date(d), tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export interface DateRange {
  from: Date;
  to: Date;
  label: string;
}

type RangeFn = (p: ReturnType<typeof tzParts>, tz: string) => [Date, Date];
const month = (k: number): RangeFn => (p, tz) => [zonedStart(p.y, p.m + k, 1, tz), zonedStart(p.y, p.m + k + 1, 1, tz)];
const day = (k: number): RangeFn => (p, tz) => [zonedStart(p.y, p.m, p.d + k, tz), zonedStart(p.y, p.m, p.d + k + 1, tz)];
const year = (k: number): RangeFn => (p, tz) => [zonedStart(p.y + k, 1, 1, tz), zonedStart(p.y + k + 1, 1, 1, tz)];
const week = (k: number): RangeFn => (p, tz) => {
  const monday = p.d - ((p.wd + 6) % 7); // weeks start on Monday
  return [zonedStart(p.y, p.m, monday + 7 * k, tz), zonedStart(p.y, p.m, monday + 7 * (k + 1), tz)];
};

const RELATIVE: { re: RegExp; label: string; range: RangeFn }[] = [
  { re: /先々月|two months ago/giu, label: '先々月', range: month(-2) },
  { re: /先月|前月|last month|previous month/giu, label: '先月', range: month(-1) },
  { re: /今月|this month/giu, label: '今月', range: month(0) },
  { re: /先々週/giu, label: '先々週', range: week(-2) },
  { re: /先週|前週|last week|previous week/giu, label: '先週', range: week(-1) },
  { re: /今週|this week/giu, label: '今週', range: week(0) },
  { re: /一昨日|おととい|day before yesterday/giu, label: '一昨日', range: day(-2) },
  { re: /昨日|きのう|yesterday/giu, label: '昨日', range: day(-1) },
  { re: /今日|本日|きょう|today/giu, label: '今日', range: day(0) },
  { re: /一昨年|おととし/giu, label: '一昨年', range: year(-2) },
  { re: /去年|昨年|last year/giu, label: '去年', range: year(-1) },
  { re: /今年|本年|this year/giu, label: '今年', range: year(0) },
];

/** First relative date expression found (in the user's time zone). Returns the stripped text too. */
export function parseRelativeDate(text: string, now: Date, tz: string): { range: DateRange | null; rest: string } {
  for (const r of RELATIVE) {
    r.re.lastIndex = 0;
    if (r.re.test(text)) {
      r.re.lastIndex = 0;
      const [from, to] = r.range(tzParts(now, tz), tz);
      return { range: { from, to, label: r.label }, rest: text.replace(r.re, ' ') };
    }
  }
  return { range: null, rest: text };
}

// ------------------------------------------------------------------ intent

export type AskItemType = 'decision' | 'commitment' | 'question' | 'action';

/** Japanese alternatives match anywhere; Latin words only on word boundaries ("done" must not match "abandoned"). */
const kw = (ja: string, en: string) => new RegExp(`${ja ? `${ja}|` : ''}(?<![a-z])(?:${en})(?![a-z])`, 'giu');

const INTENTS: { re: RegExp; type: AskItemType }[] = [
  { re: kw('決め|決ま|決定事項|決定|合意', 'decided|decide|decisions?|agreed|agree'), type: 'decision' },
  { re: kw('約束|コミットメント|コミット', 'commitments?|promised|promises?'), type: 'commitment' },
  { re: kw('質問|疑問|未解決の?問題', 'open questions?|questions?'), type: 'question' },
  { re: kw('宿題|タスク|アクションアイテム|アクション', 'todos?|to-dos?|action items?|actions?|tasks?'), type: 'action' },
];
const STATUS_OPEN = kw('未完了|未対応|未解決|未達|残って|残り|まだ|オープン', 'outstanding|unfinished|pending|open|not done');
const STATUS_DONE = kw('完了済み?|完了した|対応済み?|済んだ|終わった', 'completed|done|finished');
const ALL_RE = /全部|全て|すべて|一覧|ぜんぶ|\ball\b|everything/iu;

export function parseIntent(text: string): { types: AskItemType[]; status: 'open' | 'done' | null; wantsAll: boolean; rest: string } {
  let rest = text;
  let status: 'open' | 'done' | null = null;
  if (STATUS_OPEN.test(rest)) status = 'open';
  STATUS_OPEN.lastIndex = 0;
  rest = rest.replace(STATUS_OPEN, ' ');
  if (!status && STATUS_DONE.test(rest)) status = 'done';
  STATUS_DONE.lastIndex = 0;
  rest = rest.replace(STATUS_DONE, ' ');
  const types: AskItemType[] = [];
  for (const i of INTENTS) {
    i.re.lastIndex = 0;
    if (i.re.test(rest)) types.push(i.type);
    i.re.lastIndex = 0;
    rest = rest.replace(i.re, ' ');
  }
  const wantsAll = ALL_RE.test(text);
  return { types, status, wantsAll, rest };
}

// ------------------------------------------------------------------ people / projects / organizations

const HONORIFIC = '(?:さん|様|さま|氏|くん|君|ちゃん|先生|部長|課長|社長|専務|常務|係長|主任|殿)';
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex that matches `s` with optional whitespace between characters. */
const looseRe = (s: string, suffix = '') => new RegExp(Array.from(s).map(escRe).join('\\s*') + suffix, 'giu');
const isLatin = (s: string) => /^[\p{Script=Latin}\p{N}_]+$/u.test(s);

function boundaryOk(hay: string, at: number, len: number): boolean {
  const before = hay[at - 1] ?? '';
  const after = hay[at + len] ?? '';
  return !/[\p{Script=Latin}\p{N}]/u.test(before) && !/[\p{Script=Latin}\p{N}]/u.test(after);
}

function containsKey(qSpaceless: string, key: string): boolean {
  if (!key) return false;
  let from = 0;
  for (;;) {
    const at = qSpaceless.indexOf(key, from);
    if (at < 0) return false;
    if (!isLatin(key) || boundaryOk(qSpaceless, at, key.length)) return true;
    from = at + 1;
  }
}

export interface PersonRef {
  id: string;
  name: string;
  organization?: string | null;
}
export interface ProjectRef {
  id: string;
  name: string;
  client_name?: string | null;
}

/** More part-only (family/given name) matches than this is too ambiguous to use as a filter. */
export const MAX_PERSON_MATCHES = 20;

/**
 * People mentioned by full name, or by family/given name followed by an honorific (田中さん) or as a Latin word.
 * Full-name matches win over part matches; an ambiguous part (> MAX_PERSON_MATCHES people) is not used as a filter.
 */
export function matchPeople(question: string, people: PersonRef[]): { matched: PersonRef[]; strip: RegExp[] } {
  const qn = normalizeText(question);
  const qs = norm(question);
  const full: { p: PersonRef; re: RegExp }[] = [];
  const part: { p: PersonRef; re: RegExp }[] = [];
  for (const p of people) {
    const fullKey = norm(p.name);
    if (!fullKey) continue;
    if (Array.from(fullKey).length >= 2 && containsKey(qs, fullKey)) {
      full.push({ p, re: looseRe(fullKey, `${HONORIFIC}?`) });
      continue;
    }
    const parts = normalizeText(p.name)
      .split(/[\s　・･]+/)
      .filter(Boolean);
    const keys = new Set<string>();
    for (const x of parts) if (Array.from(x).length >= 2) keys.add(x);
    const chars = Array.from(fullKey);
    if (parts.length === 1 && !isLatin(fullKey) && chars.length >= 3) {
      keys.add(chars.slice(0, 2).join(''));
      if (chars.length >= 4) keys.add(chars.slice(0, 3).join(''));
    }
    for (const k of keys) {
      if (!qs.includes(k)) continue; // cheap prefilter: regexes are only compiled for names that occur at all
      if (isLatin(k)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(k)}(?![\\p{L}\\p{N}])`, 'giu');
        if (k.length >= 3 && re.test(qn)) {
          re.lastIndex = 0;
          part.push({ p, re });
          break;
        }
      } else {
        const re = looseRe(k, HONORIFIC);
        if (re.test(qn)) {
          re.lastIndex = 0;
          part.push({ p, re });
          break;
        }
      }
    }
  }
  const chosen = full.length ? full : part.length <= MAX_PERSON_MATCHES ? part : [];
  return { matched: chosen.map((x) => x.p), strip: chosen.map((x) => x.re) };
}

/** Projects / clients mentioned by name or client name. */
export function matchProjects(question: string, projects: ProjectRef[]): { matched: ProjectRef[]; names: string[]; strip: RegExp[] } {
  const qs = norm(question);
  const matched: ProjectRef[] = [];
  const names: string[] = [];
  const strip: RegExp[] = [];
  for (const p of projects) {
    let hit = false;
    for (const raw of [p.name, p.client_name]) {
      if (!raw) continue;
      const key = norm(raw);
      if (Array.from(key).length < 2) continue;
      if (containsKey(qs, key)) {
        hit = true;
        names.push(raw);
        strip.push(looseRe(key));
      }
    }
    if (hit) matched.push(p);
  }
  return { matched, names: [...new Set(names)], strip };
}

/** Organizations (people.organization) mentioned in the question, e.g. a client company name. */
export function matchOrganizations(question: string, people: PersonRef[]): { names: string[]; personIds: string[]; strip: RegExp[] } {
  const qs = norm(question);
  const byOrg = new Map<string, string[]>();
  for (const p of people) {
    if (!p.organization) continue;
    const key = norm(p.organization);
    if (Array.from(key).length < 2) continue;
    if (!byOrg.has(p.organization)) byOrg.set(p.organization, []);
    byOrg.get(p.organization)!.push(p.id);
  }
  const names: string[] = [];
  const personIds: string[] = [];
  const strip: RegExp[] = [];
  for (const [org, ids] of byOrg) {
    const key = norm(org);
    if (containsKey(qs, key)) {
      names.push(org);
      personIds.push(...ids);
      strip.push(looseRe(key));
    }
  }
  return { names, personIds, strip };
}

export interface AskHints {
  persons: PersonRef[];
  projects: ProjectRef[];
  topicNames: string[];
  orgPersonIds: string[];
  dateRange: DateRange | null;
  types: AskItemType[];
  status: 'open' | 'done' | null;
  wantsAll: boolean;
  keywords: string[];
}

/** Parses all hints. Everything returned refers to rows of the caller's workspace only (lists are pre-filtered). */
export function parseAskHints(question: string, now: Date, tz: string, people: PersonRef[], projects: ProjectRef[]): AskHints {
  const q = question.normalize('NFKC');
  const pm = matchPeople(q, people);
  const prj = matchProjects(q, projects);
  const org = matchOrganizations(q, people);
  let rest = normalizeText(q);
  for (const re of [...prj.strip, ...org.strip, ...pm.strip]) rest = rest.replace(re, ' ');
  const d = parseRelativeDate(rest, now, tz);
  const it = parseIntent(d.rest);
  return {
    persons: pm.matched,
    projects: prj.matched,
    topicNames: [...prj.names, ...org.names.filter((n) => !prj.names.includes(n))],
    orgPersonIds: [...new Set(org.personIds)],
    dateRange: d.range,
    types: it.types,
    status: it.status,
    wantsAll: it.wantsAll,
    keywords: extractKeywords(it.rest),
  };
}
