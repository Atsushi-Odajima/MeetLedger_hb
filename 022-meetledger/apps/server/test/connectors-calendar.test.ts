import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, withSystem } from '../src/db/pool';
import { decryptString, deriveKey } from '../src/lib/crypto';
import { expandIcs, parseIcs } from '../src/modules/connectors/ics';
import { createTestEnv, type Client, type TestEnv } from './helpers';
import { fakeDns, json, routeResponder } from './connectors-helpers';

const CRLF = '\r\n';
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'X-WR-CALNAME:Team calendar',
  'BEGIN:VEVENT',
  'UID:weekly-standup@example.com',
  'DTSTART;TZID=Asia/Tokyo:20261005T100000',
  'DTEND;TZID=Asia/Tokyo:20261005T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
  'EXDATE;TZID=Asia/Tokyo:20261019T100000',
  'SUMMARY:Weekly standup',
  'ORGANIZER;CN="Sato, Hanako":mailto:hanako@example.com',
  'ATTENDEE;CN=Ken;ROLE=REQ-PARTICIPANT:mailto:ken@example.com',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:client-kickoff@example.com',
  'DTSTART:20261006T050000Z',
  'DTEND:20261006T060000Z',
  'SUMMARY:Client kickoff\\, Acme',
  'DESCRIPTION:Agenda:\\n1. Scope\\n2. Timeline',
  'ATTENDEE;CN="Very Long',
  '  Name";PARTSTAT=ACCEPTED:mailto:LONG@Example.com',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:offsite@example.com',
  'DTSTART;VALUE=DATE:20261009',
  'DTEND;VALUE=DATE:20261010',
  'SUMMARY:Offsite',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:ny-sync@example.com',
  'DTSTART;TZID=America/New_York:20261007T090000',
  'DURATION:PT45M',
  'SUMMARY:NY sync',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:daily@example.com',
  'DTSTART;TZID="Tokyo Standard Time":20261001T090000',
  'DTEND;TZID="Tokyo Standard Time":20261001T091500',
  'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261007T000000Z',
  'SUMMARY:朝会',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancelled@example.com',
  'DTSTART:20261008T050000Z',
  'STATUS:CANCELLED',
  'SUMMARY:Cancelled',
  'END:VEVENT',
  'END:VCALENDAR',
].join(CRLF);

describe('ICS parser (RFC 5545 subset)', () => {
  const parsed = parseIcs(ICS);
  const range = { from: new Date('2026-09-30T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };
  const occ = expandIcs(parsed, range, 'Asia/Tokyo').occurrences;
  const byTitle = (t: string) => occ.filter((o) => o.title === t);

  it('unfolds lines, unescapes TEXT, parses ORGANIZER/ATTENDEE CN + mailto, ignores VALARM properties', () => {
    expect(parsed.calendarName).toBe('Team calendar');
    const kickoff = parsed.events.find((e) => e.uid === 'client-kickoff@example.com')!;
    expect(kickoff.summary).toBe('Client kickoff, Acme');
    expect(kickoff.description).toBe('Agenda:\n1. Scope\n2. Timeline');
    expect(kickoff.attendees).toEqual([{ name: 'Very Long Name', email: 'long@example.com' }]);
    const standup = parsed.events.find((e) => e.uid === 'weekly-standup@example.com')!;
    expect(standup.organizer).toEqual({ name: 'Sato, Hanako', email: 'hanako@example.com' });
    expect(standup.description).toBeNull(); // DESCRIPTION inside VALARM is not the event's
  });

  it('TZID (IANA + Windows name), UTC, DURATION and all-day are converted correctly', () => {
    expect(byTitle('Client kickoff, Acme')[0]).toMatchObject({ start: '2026-10-06T05:00:00.000Z', end: '2026-10-06T06:00:00.000Z', allDay: false });
    // 09:00 EDT = 13:00Z, 45 min
    expect(byTitle('NY sync')[0]).toMatchObject({ start: '2026-10-07T13:00:00.000Z', end: '2026-10-07T13:45:00.000Z', timezone: 'America/New_York' });
    // all-day in the importing user's zone (Asia/Tokyo)
    expect(byTitle('Offsite')[0]).toMatchObject({ allDay: true, startDate: '2026-10-09', endDate: '2026-10-10', start: '2026-10-08T15:00:00.000Z' });
    expect(byTitle('朝会')[0].timezone).toBe('Asia/Tokyo');
  });

  it('RRULE WEEKLY with COUNT + EXDATE and DAILY with INTERVAL + UNTIL expand into the range; cancelled events are skipped', () => {
    const standups = byTitle('Weekly standup').map((o) => o.start);
    // COUNT=4 → 10/5, 10/12, 10/19 (EXDATE), 10/26 ; 10:00 JST = 01:00Z
    expect(standups).toEqual(['2026-10-05T01:00:00.000Z', '2026-10-12T01:00:00.000Z', '2026-10-26T01:00:00.000Z']);
    expect(new Set(byTitle('Weekly standup').map((o) => o.seriesKey))).toEqual(new Set(['weekly-standup@example.com']));
    expect(new Set(byTitle('Weekly standup').map((o) => o.key)).size).toBe(3);
    // every 2 days from 10/1 09:00 JST (00:00Z) until 10/7 00:00Z inclusive → 10/1, 10/3, 10/5, 10/7
    expect(byTitle('朝会').map((o) => o.start.slice(0, 10))).toEqual(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07']);
    expect(byTitle('Cancelled')).toHaveLength(0);
    // range filtering
    const narrow = expandIcs(parsed, { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-13T00:00:00Z') }, 'Asia/Tokyo').occurrences;
    expect(narrow.map((o) => o.title)).toEqual(['Weekly standup']);
  });

  it('size limit and non-ICS input are rejected', () => {
    expect(() => parseIcs(ICS, { maxBytes: 100 })).toThrow(/exceeds/);
    expect(() => parseIcs('hello world')).toThrow(/Not an iCalendar/);
  });
});

describe('calendar connectors (API)', () => {
  let env: TestEnv;
  let owner: Client;
  let ws: string;
  let orgId: string;
  let member: { client: Client; userId: string };

  beforeAll(async () => {
    env = await createTestEnv({
      env: { GOOGLE_CLIENT_ID: 'google-client-id', GOOGLE_CLIENT_SECRET: 'google-client-secret', MICROSOFT_CLIENT_ID: 'ms-client-id', MICROSOFT_CLIENT_SECRET: 'ms-client-secret' },
    });
    const o = await env.setupOwner('owner@example.com');
    owner = o.client;
    ws = o.workspaceId;
    orgId = o.orgId;
    member = await env.addUser(owner, orgId, ws, 'member@example.com', 'member');
    fakeDns({ 'calendar.example.com': ['93.184.216.34'], 'internal.example.com': ['10.1.2.3'] });
  });
  afterAll(async () => env?.close());

  const calendarMeetings = async () => (await owner.get(`/api/w/${ws}/meetings?limit=200`)).body.items.filter((m: any) => m.source === 'calendar');

  it('ICS upload → preview only (no meetings) → explicit import → re-import never duplicates; recurring events grouped into one series', async () => {
    const up = await owner.post(`/api/w/${ws}/connectors/ics`, { content: ICS });
    expect(up.status).toBe(200);
    expect(up.body.connector.provider).toBe('ics');
    expect(up.body.connector.displayName).toBe('Team calendar');
    const events = up.body.events as any[];
    expect(events.map((e) => e.title)).toContain('Weekly standup');
    expect(events.every((e) => e.imported === false)).toBe(true);
    expect(await calendarMeetings()).toHaveLength(0); // preview writes no meetings

    const standups = events.filter((e) => e.title === 'Weekly standup');
    const kickoff = events.find((e) => e.title === 'Client kickoff, Acme');
    const ids = [standups[0].id, standups[1].id, kickoff.id];
    const imp = await owner.post(`/api/w/${ws}/connectors/${up.body.connector.id}/import`, { eventIds: ids });
    expect(imp.status).toBe(200);
    expect(imp.body.created).toHaveLength(3);
    const ms = await calendarMeetings();
    expect(ms).toHaveLength(3);
    const st = ms.filter((m: any) => m.title === 'Weekly standup');
    expect(st[0].seriesId).toBeTruthy();
    expect(st[0].seriesId).toBe(st[1].seriesId);
    expect(st.every((m: any) => m.calendarEventId.startsWith('ics:weekly-standup@example.com::'))).toBe(true);
    const detail = await owner.get(`/api/w/${ws}/meetings/${st[0].id}`);
    expect(detail.body.participants.map((p: any) => p.email).sort()).toEqual(['hanako@example.com', 'ken@example.com']);
    expect(detail.body.participants.find((p: any) => p.email === 'hanako@example.com').role).toBe('organizer');

    // re-import: nothing new
    const again = await owner.post(`/api/w/${ws}/connectors/${up.body.connector.id}/import`, { eventIds: ids });
    expect(again.body.created).toHaveLength(0);
    expect(again.body.existing).toHaveLength(3);
    // re-upload the same file (sync with content) keeps preview ids stable and marks imported events
    const sync = await owner.post(`/api/w/${ws}/connectors/${up.body.connector.id}/sync`, { content: ICS });
    expect(sync.status).toBe(200);
    const kick2 = sync.body.events.find((e: any) => e.title === 'Client kickoff, Acme');
    expect(kick2.id).toBe(kickoff.id);
    expect(kick2.imported).toBe(true);
    expect(kick2.meetingId).toBeTruthy();
    // a second ICS connector with the same calendar maps to the same calendar ids → still no duplicates
    const up2 = await owner.post(`/api/w/${ws}/connectors/ics`, { content: ICS, name: 'copy' });
    const k3 = up2.body.events.find((e: any) => e.title === 'Client kickoff, Acme');
    expect(k3.imported).toBe(true);
    const imp3 = await owner.post(`/api/w/${ws}/connectors/${up2.body.connector.id}/import`, { eventIds: [k3.id] });
    expect(imp3.body.created).toHaveLength(0);
    expect(await calendarMeetings()).toHaveLength(3);
    // a third weekly instance joins the existing series
    const imp4 = await owner.post(`/api/w/${ws}/connectors/${up.body.connector.id}/import`, { eventIds: [standups[2].id] });
    expect(imp4.body.created).toHaveLength(1);
    const st3 = (await calendarMeetings()).filter((m: any) => m.title === 'Weekly standup');
    expect(new Set(st3.map((m: any) => m.seriesId)).size).toBe(1);
  });

  it('ICS connectors are private to their owner; size limit → 413; non-ICS → 400', async () => {
    const up = await member.client.post(`/api/w/${ws}/connectors/ics`, { content: ICS });
    expect(up.status).toBe(200);
    expect((await owner.post(`/api/w/${ws}/connectors/${up.body.connector.id}/import`, { eventIds: [up.body.events[0].id] })).status).toBe(404);
    expect((await owner.get(`/api/w/${ws}/connectors/${up.body.connector.id}/events`)).status).toBe(404);
    // owner (admin) sees the connector metadata only
    const list = await owner.get(`/api/w/${ws}/connectors`);
    expect(list.body.items.find((c: any) => c.id === up.body.connector.id).owned).toBe(false);
    // an event already imported privately by someone else is reported without exposing the meeting
    const kick = up.body.events.find((e: any) => e.title === 'Client kickoff, Acme');
    expect(kick.imported).toBe(true); // owner's import is workspace-visible
    (env.config as any).ICS_MAX_BYTES = '500';
    const big = await owner.post(`/api/w/${ws}/connectors/ics`, { content: ICS });
    expect(big.status).toBe(413);
    delete (env.config as any).ICS_MAX_BYTES;
    expect((await owner.post(`/api/w/${ws}/connectors/ics`, { content: 'not a calendar' })).status).toBe(400);
  });

  it('ICS URL: SSRF guarded (https only, no private targets), fetched via deps.http (kind connector), URL stored encrypted and never returned', async () => {
    expect((await owner.post(`/api/w/${ws}/connectors/ics`, { url: 'http://calendar.example.com/a.ics' })).body.error.details.code).toBe('unsafe_url');
    expect((await owner.post(`/api/w/${ws}/connectors/ics`, { url: 'https://10.0.0.8/a.ics' })).status).toBe(400);
    expect((await owner.post(`/api/w/${ws}/connectors/ics`, { url: 'https://internal.example.com/a.ics' })).status).toBe(400);
    expect(env.http.calls.filter((c) => c.provider === 'ics')).toHaveLength(0);
    env.http.responder = routeResponder({ 'https://calendar.example.com/private/': () => new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } }) });
    const url = 'https://calendar.example.com/private/abcdef-secret-token/basic.ics';
    const r = await owner.post(`/api/w/${ws}/connectors/ics`, { url: url.replace('https://', 'webcal://') });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain('abcdef-secret-token');
    expect(r.body.connector.config.urlHint).toBe('https://calendar.example.com/…');
    const call = env.http.calls.filter((c) => c.provider === 'ics').at(-1)!;
    expect(call.kind).toBe('connector');
    expect((call.init as any).redirect).toBe('manual');
    const row = await withSystem(env.pool, (db) => one<any>(db, 'SELECT secret_ciphertext FROM connector_accounts WHERE id=$1', [r.body.connector.id]));
    expect(row.secret_ciphertext).not.toContain('abcdef');
    // redirect to a private address is re-validated and refused
    env.http.responder = routeResponder({ 'https://calendar.example.com/private/': () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }) });
    const redir = await owner.post(`/api/w/${ws}/connectors/${r.body.connector.id}/sync`, {});
    expect(redir.status).toBe(400);
    expect(env.http.calls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
  });

  it('Google OAuth: PKCE + server-side state, minimal read-only scope, token stored encrypted and never returned; sync is preview-only; refresh on expiry', async () => {
    const start = await owner.get(`/api/w/${ws}/connectors/google_calendar/start`);
    expect(start.status).toBe(200);
    const au = new URL(start.body.authorizeUrl);
    expect(`${au.origin}${au.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(au.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events.readonly');
    expect(au.searchParams.get('code_challenge_method')).toBe('S256');
    expect(au.searchParams.get('access_type')).toBe('offline');
    expect(au.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/connectors/oauth/callback');
    const state = au.searchParams.get('state')!;
    const challenge = au.searchParams.get('code_challenge')!;
    // optional calendar list scope only on request
    const s2 = new URL((await owner.get(`/api/w/${ws}/connectors/google_calendar/start?calendarList=1`)).body.authorizeUrl);
    expect(s2.searchParams.get('scope')!.split(' ')).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');

    // forged state
    const forged = await owner.get(`/api/connectors/oauth/callback?code=x&state=forged-state`);
    expect(forged.status).toBe(302);
    expect(forged.headers.location).toContain('error=invalid_state');
    // state started by owner but completed in another user's browser session → rejected
    const other = new URL((await owner.get(`/api/w/${ws}/connectors/google_calendar/start`)).body.authorizeUrl).searchParams.get('state')!;
    const stolen = await member.client.get(`/api/connectors/oauth/callback?code=x&state=${other}`);
    expect(stolen.headers.location).toContain('error=invalid_state');
    expect(env.http.calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))).toHaveLength(0);

    let accessToken = 'ya29.ACCESS-TOKEN-1';
    let refreshCalls = 0;
    env.http.responder = routeResponder({
      'https://oauth2.googleapis.com/token': (call) => {
        const p = new URLSearchParams(String(call.init?.body));
        if (p.get('grant_type') === 'refresh_token') {
          refreshCalls++;
          accessToken = 'ya29.ACCESS-TOKEN-2';
          return json({ access_token: accessToken, expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/calendar.events.readonly' });
        }
        return json({ access_token: accessToken, refresh_token: '1//REFRESH-TOKEN-SECRET', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/calendar.events.readonly' });
      },
      'https://www.googleapis.com/calendar/v3/calendars/primary/events': (call) => {
        if ((call.init?.headers as any)?.authorization !== `Bearer ${accessToken}`) return json({ error: 'unauthorized' }, 401);
        return json({
          summary: 'owner@example.com',
          items: [
            { id: 'rec1_20261005T010000Z', recurringEventId: 'rec1', status: 'confirmed', summary: '定例', start: { dateTime: '2026-10-05T10:00:00+09:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-10-05T10:30:00+09:00' }, organizer: { email: 'owner@example.com' }, attendees: [{ email: 'a@example.com', displayName: 'A' }, { email: 'room@resource.calendar.google.com', resource: true }] },
            { id: 'rec1_20261012T010000Z', recurringEventId: 'rec1', status: 'confirmed', summary: '定例', start: { dateTime: '2026-10-12T10:00:00+09:00' }, end: { dateTime: '2026-10-12T10:30:00+09:00' } },
            { id: 'single1', status: 'confirmed', summary: 'Customer call', start: { dateTime: '2026-10-07T15:00:00+09:00' }, end: { dateTime: '2026-10-07T16:00:00+09:00' } },
            { id: 'gone1', status: 'cancelled', summary: 'Cancelled' },
            { id: 'allday1', status: 'confirmed', summary: 'Holiday', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
          ],
        });
      },
    });
    const cb = await owner.get(`/api/connectors/oauth/callback?code=AUTH-CODE&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('connected=google_calendar');
    const tokenCall = env.http.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!;
    expect(tokenCall.kind).toBe('connector');
    const tp = new URLSearchParams(String(tokenCall.init?.body));
    expect(tp.get('grant_type')).toBe('authorization_code');
    expect(tp.get('code')).toBe('AUTH-CODE');
    expect(createHash('sha256').update(tp.get('code_verifier')!).digest('base64url')).toBe(challenge);
    // replaying the state fails (one-time)
    expect((await owner.get(`/api/connectors/oauth/callback?code=AUTH-CODE&state=${encodeURIComponent(state)}`)).headers.location).toContain('error=invalid_state');

    const list = await owner.get(`/api/w/${ws}/connectors`);
    const g = list.body.items.find((c: any) => c.provider === 'google_calendar');
    expect(g.scopes).toEqual(['https://www.googleapis.com/auth/calendar.events.readonly']);
    expect(g.hasCredentials).toBe(true);
    expect(list.raw).not.toContain('ya29');
    expect(list.raw).not.toContain('REFRESH-TOKEN');
    const row = await withSystem(env.pool, (db) => one<any>(db, 'SELECT secret_ciphertext FROM connector_accounts WHERE id=$1', [g.id]));
    expect(row.secret_ciphertext).not.toContain('ya29');
    const plain = JSON.parse(decryptString(deriveKey(env.config.MASTER_KEY, 'connector'), row.secret_ciphertext));
    expect(plain.refreshToken).toBe('1//REFRESH-TOKEN-SECRET');

    const sync = await owner.post(`/api/w/${ws}/connectors/${g.id}/sync`, {});
    expect(sync.status).toBe(200);
    expect(sync.body.events.map((e: any) => e.title).sort()).toEqual(['Customer call', 'Holiday', '定例', '定例']);
    expect(sync.body.events.find((e: any) => e.title === 'Holiday').allDay).toBe(true);
    expect(sync.body.events.find((e: any) => e.title === '定例').attendees.map((a: any) => a.email)).toEqual(['a@example.com']);
    expect(JSON.stringify(sync.body)).not.toContain('ya29');
    expect((await calendarMeetings()).filter((m: any) => m.calendarEventId?.startsWith('google:'))).toHaveLength(0);

    const recIds = sync.body.events.filter((e: any) => e.title === '定例').map((e: any) => e.id);
    const imp = await owner.post(`/api/w/${ws}/connectors/${g.id}/import`, { eventIds: recIds });
    expect(imp.body.created).toHaveLength(2);
    const gm = (await calendarMeetings()).filter((m: any) => m.calendarEventId?.startsWith('google:'));
    expect(new Set(gm.map((m: any) => m.seriesId)).size).toBe(1);

    // access token expired → refreshed via refresh_token grant, new ciphertext persisted
    env.clock.advance(2 * 3600_000);
    const sync2 = await owner.post(`/api/w/${ws}/connectors/${g.id}/sync`, {});
    expect(sync2.status).toBe(200);
    expect(refreshCalls).toBe(1);
    const row2 = await withSystem(env.pool, (db) => one<any>(db, 'SELECT secret_ciphertext FROM connector_accounts WHERE id=$1', [g.id]));
    expect(JSON.parse(decryptString(deriveKey(env.config.MASTER_KEY, 'connector'), row2.secret_ciphertext)).accessToken).toBe('ya29.ACCESS-TOKEN-2');
    // secrets never reach the logs
    expect(env.logs.join('\n')).not.toMatch(/ya29|REFRESH-TOKEN|AUTH-CODE|google-client-secret/);
    // member cannot use / see the owner's calendar connector
    expect((await member.client.post(`/api/w/${ws}/connectors/${g.id}/sync`, {})).status).toBe(404);
  });

  it('Microsoft Graph: Calendars.ReadBasic + offline_access, calendarView mapped from UTC; foreign nextLink refused', async () => {
    const start = await member.client.get(`/api/w/${ws}/connectors/microsoft_calendar/start`);
    const au = new URL(start.body.authorizeUrl);
    expect(`${au.origin}${au.pathname}`).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(au.searchParams.get('scope')).toBe('offline_access https://graph.microsoft.com/Calendars.ReadBasic');
    env.http.responder = routeResponder({
      'https://login.microsoftonline.com/common/oauth2/v2.0/token': json({ access_token: 'EwB-ms-access', refresh_token: 'M.R3-ms-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'https://graph.microsoft.com/Calendars.ReadBasic' }),
      'https://graph.microsoft.com/v1.0/me/calendarView': (call, url) => {
        if (url.searchParams.get('page') === '2') return json({ value: [], '@odata.nextLink': 'https://evil.example.com/steal' });
        return json({
          value: [
            { id: 'AAMk1', subject: 'Design review', start: { dateTime: '2026-10-08T01:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-08T02:00:00.0000000', timeZone: 'UTC' }, isAllDay: false, organizer: { emailAddress: { name: 'Org', address: 'org@example.com' } }, attendees: [{ type: 'required', emailAddress: { name: 'B', address: 'b@example.com' } }] },
            { id: 'AAMk2', subject: 'Cancelled', isCancelled: true, start: { dateTime: '2026-10-09T01:00:00' }, end: { dateTime: '2026-10-09T02:00:00' } },
          ],
          ...(call.init && (call.init.headers as any).prefer === 'outlook.timezone="UTC"' ? {} : { bad: true }),
        });
      },
    });
    const cb = await member.client.get(`/api/connectors/oauth/callback?code=MS-CODE&state=${encodeURIComponent(au.searchParams.get('state')!)}`);
    expect(cb.headers.location).toContain('connected=microsoft_calendar');
    const tokenCall = env.http.calls.filter((c) => c.url.includes('login.microsoftonline.com')).at(-1)!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).get('scope')).toBe('offline_access https://graph.microsoft.com/Calendars.ReadBasic');
    const c = (await member.client.get(`/api/w/${ws}/connectors`)).body.items.find((x: any) => x.provider === 'microsoft_calendar');
    const sync = await member.client.post(`/api/w/${ws}/connectors/${c.id}/sync`, {});
    expect(sync.status).toBe(200);
    expect(sync.body.events).toHaveLength(1);
    expect(sync.body.events[0]).toMatchObject({ title: 'Design review', start: '2026-10-08T01:00:00.000Z', end: '2026-10-08T02:00:00.000Z' });
    expect(sync.body.events[0].organizer).toEqual({ name: 'Org', email: 'org@example.com' });
    // pagination link to a non-Graph host is never followed
    env.http.responder = routeResponder({
      'https://graph.microsoft.com/v1.0/me/calendarView': json({ value: [], '@odata.nextLink': 'https://evil.example.com/steal' }),
    });
    const bad = await member.client.post(`/api/w/${ws}/connectors/${c.id}/sync`, {});
    expect(bad.status).toBe(502);
    expect(env.http.calls.some((x) => x.url.includes('evil.example.com'))).toBe(false);
  });

  it('OAuth start without configured client → 409; API tokens cannot start OAuth', async () => {
    const saved = env.config.GOOGLE_CLIENT_ID;
    (env.config as any).GOOGLE_CLIENT_ID = undefined;
    const r = await owner.get(`/api/w/${ws}/connectors/google_calendar/start`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('connector_not_configured');
    (env.config as any).GOOGLE_CLIENT_ID = saved;
  });

  it('background connectors.sync refreshes previews only; autoImport is admin-only and creates meetings only when enabled', async () => {
    const before = (await calendarMeetings()).length;
    let listed = 0;
    env.http.responder = routeResponder({
      'https://oauth2.googleapis.com/token': json({ access_token: 'ya29.ACCESS-TOKEN-3', expires_in: 3600, token_type: 'Bearer' }),
      'https://www.googleapis.com/calendar/v3/calendars/primary/events': () => {
        listed++;
        return json({ items: [{ id: 'auto1', status: 'confirmed', summary: 'Auto candidate', start: { dateTime: '2026-10-03T10:00:00+09:00' }, end: { dateTime: '2026-10-03T11:00:00+09:00' } }] });
      },
      'https://graph.microsoft.com/v1.0/me/calendarView': json({ value: [] }),
    });
    const runJob = async (key: string) => {
      await withSystem(env.pool, (db) => env.deps.jobs.enqueue(db, { orgId: null, type: 'connectors.sync', key, maxAttempts: 1 }));
      await env.worker.drain();
    };
    await runJob('connectors.sync:test-1');
    expect(listed).toBeGreaterThan(0);
    expect((await calendarMeetings()).length).toBe(before); // preview only

    const g = (await owner.get(`/api/w/${ws}/connectors`)).body.items.find((c: any) => c.provider === 'google_calendar');
    const memberIcs = (await member.client.get(`/api/w/${ws}/connectors`)).body.items.find((c: any) => c.provider === 'ics' && c.owned);
    expect((await member.client.patch(`/api/w/${ws}/connectors/${memberIcs.id}`, { autoImport: true })).status).toBe(403);
    const en = await owner.patch(`/api/w/${ws}/connectors/${g.id}`, { autoImport: true });
    expect(en.status).toBe(200);
    expect(en.body.connector.config.autoImport).toBe(true);
    await runJob('connectors.sync:test-2');
    const after = await calendarMeetings();
    expect(after.length).toBe(before + 1);
    expect(after.some((m: any) => m.title === 'Auto candidate')).toBe(true);
    await runJob('connectors.sync:test-3');
    expect((await calendarMeetings()).length).toBe(before + 1); // idempotent
  });
});
