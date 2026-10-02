import type { Deps } from '../../context';
import { AppError, badRequest, tooLarge } from '../../lib/errors';
import { expandIcs, IcsError, parseIcs, zonedToUtc } from './ics';
import { assertSafeOutboundUrl } from './netguard';
import { accessTokenFor, connectorError } from './oauth';
import { connectorSettings, openSecret, sha256Hex } from './secrets';

// Calendar connectors are READ-ONLY. They list events for a range; nothing is written to the provider.
// Every provider call goes through deps.http.fetch (kind 'connector'); responses are mapped to a minimal shape
// (title, times, organizer, attendees). Event bodies/descriptions are not stored.

export interface CalendarRange {
  from: Date;
  to: Date;
}

export interface CalendarPerson {
  name: string | null;
  email: string | null;
}

export interface CalendarEvent {
  /** Provider-prefixed id, stored as meetings.calendar_event_id (unique per workspace ⇒ re-import never duplicates). */
  key: string;
  /** Provider-prefixed recurrence id (series.calendar_recurring_id) for recurring instances. */
  seriesKey: string | null;
  recurrence: string | null;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  timezone: string | null;
  organizer: CalendarPerson | null;
  attendees: CalendarPerson[];
  flags: string[];
}

export interface CalendarListResult {
  events: CalendarEvent[];
  calendarName?: string | null;
  truncated?: boolean;
}

export interface CalendarConnector {
  readonly provider: 'google_calendar' | 'microsoft_calendar' | 'ics';
  listEvents(range: CalendarRange): Promise<CalendarListResult>;
}

export interface ConnectorRow {
  id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  provider: string;
  status: string;
  scopes: string[];
  secret_ciphertext: string | null;
  config: Record<string, any>;
  display_name: string | null;
}

export const CALENDAR_PROVIDERS = ['google_calendar', 'microsoft_calendar', 'ics'] as const;

const MAX_KEY = 300;
/** Keeps calendar ids within the meetings.calendar_event_id limits (long ids are hashed, still deterministic). */
export function calendarKey(prefix: string, id: string): string {
  const k = `${prefix}:${id}`;
  return k.length <= MAX_KEY ? k : `${prefix}:h:${sha256Hex(id).slice(0, 48)}`;
}

const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;
function person(name: unknown, email: unknown): CalendarPerson | null {
  const e = typeof email === 'string' && EMAIL_RE.test(email.trim()) ? email.trim().toLowerCase().slice(0, 254) : null;
  const n = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;
  if (!e && !n) return null;
  return { name: n, email: e };
}

function allDayRange(startDate: string, endDate: string | null, tz: string) {
  const [y, m, d] = startDate.split('-').map(Number);
  const start = zonedToUtc(y, m, d, 0, 0, 0, tz);
  let end: number | null = null;
  if (endDate) {
    const [y2, m2, d2] = endDate.split('-').map(Number);
    end = zonedToUtc(y2, m2, d2, 0, 0, 0, tz);
  }
  return { start: new Date(start).toISOString(), end: end ? new Date(end).toISOString() : null };
}

async function readJson(res: Response, provider: string): Promise<any> {
  if (res.status === 401) throw connectorError(409, 'reauth_required', `${provider} rejected the stored credentials. Please reconnect.`);
  if (res.status === 403) throw connectorError(502, 'provider_forbidden', `${provider} denied access (scope or API not enabled)`);
  if (!res.ok) throw connectorError(502, 'provider_error', `${provider} returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw connectorError(502, 'provider_error', `${provider} returned an invalid response`);
  }
}

const MAX_PAGES = 8;

/** Google Calendar API v3 events.list (scope calendar.events.readonly), singleEvents=true expands recurrences. */
export class GoogleCalendarConnector implements CalendarConnector {
  readonly provider = 'google_calendar' as const;
  constructor(
    private deps: Deps,
    private row: ConnectorRow,
    private userTz: string,
  ) {}

  async listEvents(range: CalendarRange): Promise<CalendarListResult> {
    const calendarId = typeof this.row.config.calendarId === 'string' && this.row.config.calendarId ? this.row.config.calendarId : 'primary';
    const events: CalendarEvent[] = [];
    let calendarName: string | null = null;
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const token = await accessTokenFor(this.deps, this.row.org_id, this.row);
      const q = new URLSearchParams({
        timeMin: range.from.toISOString(),
        timeMax: range.to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        fields: 'summary,nextPageToken,items(id,status,summary,start,end,organizer(email,displayName),attendees(email,displayName,resource),recurringEventId)',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.deps.http.fetch({
        orgId: this.row.org_id,
        kind: 'connector',
        provider: 'google_calendar',
        purpose: 'calendar.events.list',
        url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`,
        init: { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual' },
      });
      const j = await readJson(res, 'Google Calendar');
      calendarName ??= typeof j.summary === 'string' ? j.summary.slice(0, 200) : null;
      for (const it of Array.isArray(j.items) ? j.items : []) {
        if (!it?.id || it.status === 'cancelled') continue;
        const allDay = !!it.start?.date && !it.start?.dateTime;
        let start: string;
        let end: string | null;
        if (allDay) ({ start, end } = allDayRange(it.start.date, it.end?.date ?? null, this.userTz));
        else {
          const s = Date.parse(it.start?.dateTime);
          if (Number.isNaN(s)) continue;
          start = new Date(s).toISOString();
          const e = Date.parse(it.end?.dateTime);
          end = Number.isNaN(e) ? null : new Date(e).toISOString();
        }
        events.push({
          key: calendarKey('google', String(it.id)),
          seriesKey: it.recurringEventId ? calendarKey('google', String(it.recurringEventId)) : null,
          recurrence: it.recurringEventId ? 'recurring' : null,
          title: typeof it.summary === 'string' && it.summary.trim() ? it.summary.trim().slice(0, 300) : '(無題)',
          start,
          end,
          allDay,
          startDate: allDay ? it.start.date : null,
          endDate: allDay ? (it.end?.date ?? null) : null,
          timezone: allDay ? null : (it.start?.timeZone ?? null),
          organizer: person(it.organizer?.displayName, it.organizer?.email),
          attendees: (Array.isArray(it.attendees) ? it.attendees : [])
            .filter((a: any) => !a?.resource)
            .map((a: any) => person(a?.displayName, a?.email))
            .filter(Boolean)
            .slice(0, 200) as CalendarPerson[],
          flags: allDay ? ['all_day'] : [],
        });
      }
      pageToken = typeof j.nextPageToken === 'string' ? j.nextPageToken : undefined;
    } while (pageToken && ++pages < MAX_PAGES);
    return { events, calendarName, truncated: !!pageToken };
  }
}

/** Microsoft Graph /me/calendarView (delegated Calendars.ReadBasic + offline_access). Times requested in UTC. */
export class MicrosoftCalendarConnector implements CalendarConnector {
  readonly provider = 'microsoft_calendar' as const;
  constructor(
    private deps: Deps,
    private row: ConnectorRow,
    private userTz: string,
  ) {}

  async listEvents(range: CalendarRange): Promise<CalendarListResult> {
    const q = new URLSearchParams({
      startDateTime: range.from.toISOString(),
      endDateTime: range.to.toISOString(),
      $top: '100',
      $orderby: 'start/dateTime',
      $select: 'id,subject,start,end,isAllDay,isCancelled,organizer,attendees,seriesMasterId,type',
    });
    let url: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?${q.toString()}`;
    const events: CalendarEvent[] = [];
    let pages = 0;
    while (url && pages++ < MAX_PAGES) {
      const next: URL = new URL(url);
      // nextLink must stay on Graph (never follow a provider-supplied URL to another host)
      if (next.protocol !== 'https:' || next.hostname !== 'graph.microsoft.com') throw connectorError(502, 'provider_error', 'Unexpected pagination link');
      const token = await accessTokenFor(this.deps, this.row.org_id, this.row);
      const res = await this.deps.http.fetch({
        orgId: this.row.org_id,
        kind: 'connector',
        provider: 'microsoft_calendar',
        purpose: 'calendar.calendarView',
        url: next.toString(),
        init: { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json', prefer: 'outlook.timezone="UTC"' }, redirect: 'manual' },
      });
      const j = await readJson(res, 'Microsoft Graph');
      for (const it of Array.isArray(j.value) ? j.value : []) {
        if (!it?.id || it.isCancelled) continue;
        const utc = (v: any) => {
          if (!v?.dateTime) return Number.NaN;
          const s = String(v.dateTime);
          return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(/\.\d+$/, '')}Z`);
        };
        const allDay = !!it.isAllDay;
        let start: string;
        let end: string | null;
        let startDate: string | null = null;
        let endDate: string | null = null;
        if (allDay) {
          startDate = String(it.start?.dateTime ?? '').slice(0, 10);
          endDate = it.end?.dateTime ? String(it.end.dateTime).slice(0, 10) : null;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) continue;
          ({ start, end } = allDayRange(startDate, endDate, this.userTz));
        } else {
          const s = utc(it.start);
          if (Number.isNaN(s)) continue;
          start = new Date(s).toISOString();
          const e = utc(it.end);
          end = Number.isNaN(e) ? null : new Date(e).toISOString();
        }
        events.push({
          key: calendarKey('ms', String(it.id)),
          seriesKey: it.seriesMasterId ? calendarKey('ms', String(it.seriesMasterId)) : null,
          recurrence: it.seriesMasterId ? 'recurring' : null,
          title: typeof it.subject === 'string' && it.subject.trim() ? it.subject.trim().slice(0, 300) : '(無題)',
          start,
          end,
          allDay,
          startDate,
          endDate,
          timezone: null,
          organizer: person(it.organizer?.emailAddress?.name, it.organizer?.emailAddress?.address),
          attendees: (Array.isArray(it.attendees) ? it.attendees : [])
            .filter((a: any) => a?.type !== 'resource')
            .map((a: any) => person(a?.emailAddress?.name, a?.emailAddress?.address))
            .filter(Boolean)
            .slice(0, 200) as CalendarPerson[],
          flags: allDay ? ['all_day'] : [],
        });
      }
      url = typeof j['@odata.nextLink'] === 'string' ? j['@odata.nextLink'] : null;
    }
    return { events, truncated: !!url };
  }
}

/** Maps parsed ICS occurrences to calendar events (key prefix `ics:`; recurring instances share seriesKey = UID). */
export function icsToEvents(text: string, range: CalendarRange, userTz: string, maxBytes: number): CalendarListResult {
  let parsed;
  try {
    parsed = parseIcs(text, { maxBytes });
  } catch (e) {
    if (e instanceof IcsError) {
      if (e.code === 'too_large') throw tooLarge('ICS file is too large');
      throw badRequest(e.code === 'not_ics' ? 'Not a valid iCalendar (.ics) file' : 'ICS contains too many events', { code: e.code });
    }
    throw e;
  }
  const { occurrences, truncated } = expandIcs(parsed, range, userTz);
  return {
    calendarName: parsed.calendarName,
    truncated,
    events: occurrences.map((o) => ({
      key: calendarKey('ics', o.key),
      seriesKey: o.seriesKey ? calendarKey('ics', o.seriesKey) : null,
      recurrence: o.recurrence,
      title: o.title,
      start: o.start,
      end: o.end,
      allDay: o.allDay,
      startDate: o.startDate,
      endDate: o.endDate,
      timezone: o.timezone,
      organizer: o.organizer,
      attendees: o.attendees.slice(0, 200),
      flags: o.flags,
    })),
  };
}

/** Fetches an ICS subscription URL (SSRF-guarded, redirects re-validated manually, size-limited). */
export async function fetchIcs(deps: Deps, orgId: string, rawUrl: string): Promise<string> {
  const settings = connectorSettings(deps);
  let url = rawUrl.replace(/^webcals?:\/\//i, 'https://');
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertSafeOutboundUrl(url, settings);
    let res: Response;
    try {
      res = await deps.http.fetch({
        orgId,
        kind: 'connector',
        provider: 'ics',
        purpose: 'calendar.ics_fetch',
        url: u.toString(),
        init: { method: 'GET', headers: { accept: 'text/calendar, text/plain;q=0.5' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) },
      });
    } catch {
      throw connectorError(502, 'connector_unreachable', 'ICS URL could not be fetched');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw connectorError(502, 'provider_error', 'ICS redirect without location');
      url = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw connectorError(502, 'provider_error', `ICS URL returned HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > settings.icsMaxBytes) throw tooLarge('ICS file is too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > settings.icsMaxBytes) throw tooLarge('ICS file is too large');
    return buf.toString('utf8');
  }
  throw connectorError(502, 'provider_error', 'Too many redirects');
}

/** ICS subscription connector (URL stored encrypted). Upload-only ICS connectors have no URL and are not refreshed. */
export class IcsCalendarConnector implements CalendarConnector {
  readonly provider = 'ics' as const;
  constructor(
    private deps: Deps,
    private row: ConnectorRow,
    private userTz: string,
  ) {}

  async listEvents(range: CalendarRange): Promise<CalendarListResult> {
    const secret = openSecret<{ url?: string }>(this.deps, this.row.secret_ciphertext);
    if (!secret?.url) throw new AppError(409, 'not_refreshable', 'This ICS connector was created from an uploaded file; upload the file again to refresh');
    const text = await fetchIcs(this.deps, this.row.org_id, secret.url);
    return icsToEvents(text, range, this.userTz, connectorSettings(this.deps).icsMaxBytes);
  }
}

export function calendarConnectorFor(deps: Deps, row: ConnectorRow, userTz: string): CalendarConnector {
  switch (row.provider) {
    case 'google_calendar':
      return new GoogleCalendarConnector(deps, row, userTz);
    case 'microsoft_calendar':
      return new MicrosoftCalendarConnector(deps, row, userTz);
    case 'ics':
      return new IcsCalendarConnector(deps, row, userTz);
    default:
      throw badRequest('Not a calendar connector');
  }
}
