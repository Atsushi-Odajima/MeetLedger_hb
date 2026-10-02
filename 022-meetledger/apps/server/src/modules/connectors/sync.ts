import type { Deps, WsCtx } from '../../context';
import { one, rows, withSystem, withTenant, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { safeErrorMessage } from '../../lib/logger';
import { meetingVisibleSql } from '../../rbac/access';
import { wsSettings } from '../../privacy/policy';
import { createMeeting } from '../core/meetings';
import { CALENDAR_PROVIDERS, calendarConnectorFor, type CalendarEvent, type CalendarRange, type ConnectorRow } from './calendar';

// Sync = refresh the PREVIEW cache only (connector_events). Meetings are created only by an explicit import of selected
// events, or by the background job when an admin explicitly enabled `autoImport` on the connector (default OFF).

export const DEFAULT_PREVIEW_DAYS = { back: 1, ahead: 30 };
export const MAX_RANGE_DAYS = 366;

export function defaultRange(now: Date): CalendarRange {
  return { from: new Date(now.getTime() - DEFAULT_PREVIEW_DAYS.back * 86400_000), to: new Date(now.getTime() + DEFAULT_PREVIEW_DAYS.ahead * 86400_000) };
}

/** Upserts events into the preview cache keeping row ids stable (ids returned by a preview stay importable). */
export async function storePreview(db: Db, row: ConnectorRow, range: CalendarRange, events: CalendarEvent[], now: Date) {
  const keys: string[] = [];
  for (const e of events) {
    keys.push(e.key);
    await db.query(
      `INSERT INTO connector_events(org_id, workspace_id, connector_id, event_key, series_key, recurrence, title, starts_at, ends_at, all_day, start_date, end_date,
                                    timezone, organizer, attendees, flags, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (connector_id, event_key) DO UPDATE SET series_key=EXCLUDED.series_key, recurrence=EXCLUDED.recurrence, title=EXCLUDED.title,
         starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, all_day=EXCLUDED.all_day, start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
         timezone=EXCLUDED.timezone, organizer=EXCLUDED.organizer, attendees=EXCLUDED.attendees, flags=EXCLUDED.flags, fetched_at=EXCLUDED.fetched_at`,
      [
        row.org_id,
        row.workspace_id,
        row.id,
        e.key,
        e.seriesKey,
        e.recurrence,
        e.title,
        e.start,
        e.end,
        e.allDay,
        e.startDate,
        e.endDate,
        e.timezone,
        e.organizer ? JSON.stringify(e.organizer) : null,
        JSON.stringify(e.attendees),
        e.flags,
        now,
      ],
    );
  }
  // Events that disappeared from the provider within the refreshed range are removed from the preview (meetings stay).
  await db.query('DELETE FROM connector_events WHERE connector_id=$1 AND starts_at >= $2 AND starts_at < $3 AND NOT (event_key = ANY($4))', [row.id, range.from, range.to, keys]);
  // Keep the cache small: drop entries that ended more than 30 days ago.
  await db.query(`DELETE FROM connector_events WHERE connector_id=$1 AND coalesce(ends_at, starts_at) < $2`, [row.id, new Date(now.getTime() - 30 * 86400_000)]);
}

export interface PreviewItem {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  timezone: string | null;
  organizer: { name: string | null; email: string | null } | null;
  attendees: { name: string | null; email: string | null }[];
  recurring: boolean;
  recurrence: string | null;
  flags: string[];
  /** a meeting for this calendar event already exists and is visible to you */
  imported: boolean;
  meetingId: string | null;
  /** a meeting for this event exists in the workspace but is not visible to you (e.g. another member imported it privately) */
  importedByOther: boolean;
}

export async function listPreview(db: Db, ctx: Pick<WsCtx, 'workspaceId' | 'userId'>, connectorId: string, range?: CalendarRange): Promise<PreviewItem[]> {
  const params: unknown[] = [connectorId, ctx.workspaceId, ctx.userId];
  let where = 'ce.connector_id = $1 AND ce.workspace_id = $2';
  if (range) {
    params.push(range.from, range.to);
    where += ' AND ce.starts_at < $5 AND coalesce(ce.ends_at, ce.starts_at) >= $4';
  }
  const list = await rows<any>(
    db,
    `SELECT ce.*, m.id AS meeting_id, (m.id IS NOT NULL AND ${meetingVisibleSql('m', '$3')}) AS meeting_visible
       FROM connector_events ce
       LEFT JOIN meetings m ON m.workspace_id = ce.workspace_id AND m.calendar_event_id = ce.event_key AND m.deleted_at IS NULL
      WHERE ${where}
      ORDER BY ce.starts_at, ce.event_key LIMIT 2000`,
    params,
  );
  return list.map((r) => ({
    id: r.id,
    title: r.title,
    start: new Date(r.starts_at).toISOString(),
    end: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    allDay: r.all_day,
    startDate: r.start_date,
    endDate: r.end_date,
    timezone: r.timezone,
    organizer: r.organizer,
    attendees: r.attendees ?? [],
    recurring: !!r.series_key,
    recurrence: r.recurrence,
    flags: r.flags ?? [],
    imported: !!r.meeting_id && r.meeting_visible,
    meetingId: r.meeting_id && r.meeting_visible ? r.meeting_id : null,
    importedByOther: !!r.meeting_id && !r.meeting_visible,
  }));
}

/** Fetches events from the provider and refreshes the preview cache. Never creates meetings. */
export async function refreshConnector(deps: Deps, row: ConnectorRow, range: CalendarRange, userTz: string) {
  const conn = calendarConnectorFor(deps, row, userTz);
  try {
    const res = await conn.listEvents(range);
    await withTenant(deps.pool, row.org_id, async (db) => {
      await storePreview(db, row, range, res.events, deps.clock.now());
      await db.query(
        `UPDATE connector_accounts SET last_sync_at=$2, last_error=NULL, status=CASE WHEN status='error' THEN 'active' ELSE status END,
                display_name=coalesce(display_name, $3) WHERE id=$1`,
        [row.id, deps.clock.now(), res.calendarName ?? null],
      );
    });
    return { count: res.events.length, truncated: !!res.truncated };
  } catch (e: any) {
    const code = typeof e?.code === 'string' ? e.code : 'sync_failed';
    await withTenant(deps.pool, row.org_id, (db) =>
      db.query(`UPDATE connector_accounts SET last_error=$2, status=CASE WHEN $2='reauth_required' THEN 'error' ELSE status END WHERE id=$1`, [row.id, code.slice(0, 60)]),
    );
    throw e;
  }
}

async function ensureSeries(db: Db, ctx: WsCtx, ev: { series_key: string; title: string; recurrence: string | null }, visibility: string): Promise<string> {
  const cadence = ev.recurrence === 'daily' || ev.recurrence === 'weekly' ? ev.recurrence : null;
  const ins = await one<{ id: string }>(
    db,
    `INSERT INTO series(org_id, workspace_id, title, cadence, default_visibility, calendar_recurring_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id, calendar_recurring_id) WHERE calendar_recurring_id IS NOT NULL DO NOTHING RETURNING id`,
    [ctx.orgId, ctx.workspaceId, ev.title, cadence, visibility, ev.series_key, ctx.userId],
  );
  if (ins) return ins.id;
  const ex = await one<{ id: string }>(db, 'SELECT id FROM series WHERE workspace_id=$1 AND calendar_recurring_id=$2', [ctx.workspaceId, ev.series_key]);
  return ex!.id;
}

export interface ImportOptions {
  visibility?: 'private' | 'workspace' | 'selected';
  meetingType?: string;
  projectId?: string | null;
}

export interface ImportResult {
  created: { eventId: string; meetingId: string }[];
  existing: { eventId: string; meetingId: string | null }[];
  skipped: { eventId: string; reason: string }[];
}

/**
 * Creates meetings for the selected preview events (explicit user action). Idempotent: the unique index
 * meetings(workspace_id, calendar_event_id) guarantees a re-import never duplicates; recurring instances are grouped into
 * one series per calendar recurrence id.
 */
export async function importEvents(db: Db, ctx: WsCtx, connectorId: string, eventIds: string[], opts: ImportOptions = {}): Promise<ImportResult> {
  const out: ImportResult = { created: [], existing: [], skipped: [] };
  const w = await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]);
  const s = wsSettings(w?.settings);
  for (const eventId of [...new Set(eventIds)]) {
    const ev = await one<any>(db, 'SELECT * FROM connector_events WHERE id=$1 AND connector_id=$2 AND workspace_id=$3', [eventId, connectorId, ctx.workspaceId]);
    if (!ev) {
      out.skipped.push({ eventId, reason: 'not_found' });
      continue;
    }
    await db.query('SAVEPOINT cal_import');
    try {
      const existing = await one<any>(
        db,
        `SELECT m.id, ${meetingVisibleSql('m', '$3')} AS visible FROM meetings m WHERE m.workspace_id=$1 AND m.calendar_event_id=$2 AND m.deleted_at IS NULL`,
        [ctx.workspaceId, ev.event_key, ctx.userId],
      );
      if (existing) {
        await db.query('RELEASE SAVEPOINT cal_import');
        if (existing.visible) out.existing.push({ eventId, meetingId: existing.id });
        else out.skipped.push({ eventId, reason: 'already_imported_by_another_member' });
        continue;
      }
      const visibility = opts.visibility ?? s.defaults.visibility;
      const seriesId = ev.series_key ? await ensureSeries(db, ctx, ev, visibility) : null;
      const participants: any[] = [];
      const seen = new Set<string>();
      const add = (p: { name: string | null; email: string | null } | null, role: 'organizer' | 'attendee') => {
        if (!p || (!p.name && !p.email)) return;
        const k = (p.email ?? `name:${p.name}`).toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        participants.push({ name: p.name ?? undefined, email: p.email ?? undefined, role });
      };
      add(ev.organizer, 'organizer');
      for (const a of (ev.attendees ?? []).slice(0, 200)) add(a, 'attendee');
      const m = await createMeeting(db, ctx, {
        title: ev.title,
        scheduledStart: new Date(ev.starts_at).toISOString(),
        scheduledEnd: ev.ends_at ? new Date(ev.ends_at).toISOString() : null,
        source: 'calendar',
        calendarEventId: ev.event_key,
        seriesId,
        visibility: opts.visibility,
        meetingType: opts.meetingType as any,
        projectId: opts.projectId ?? undefined,
        participants,
        accessUserIds: [],
      });
      await db.query('UPDATE meetings SET calendar_connection_id=$2 WHERE id=$1', [m.id, connectorId]);
      await db.query('RELEASE SAVEPOINT cal_import');
      out.created.push({ eventId, meetingId: m.id });
    } catch (e: any) {
      await db.query('ROLLBACK TO SAVEPOINT cal_import');
      if (e?.code === '23505') {
        // concurrent import of the same event: the unique index won — never a duplicate meeting
        const ex = await one<any>(db, 'SELECT id FROM meetings WHERE workspace_id=$1 AND calendar_event_id=$2 AND deleted_at IS NULL', [ctx.workspaceId, ev.event_key]);
        out.existing.push({ eventId, meetingId: ex?.id ?? null });
        continue;
      }
      throw e;
    }
  }
  await audit(db, {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: 'connector.calendar_import',
    entityType: 'connector',
    entityId: connectorId,
    meta: { created: out.created.length, existing: out.existing.length, skipped: out.skipped.length },
  });
  return out;
}

/** Synthetic workspace context for background work on behalf of the connector owner (auto-import). */
async function ownerCtx(deps: Deps, row: ConnectorRow): Promise<WsCtx | null> {
  const u = await withTenant(deps.pool, row.org_id, (db) =>
    one<any>(
      db,
      `SELECT u.id, u.email, u.name, u.timezone, u.locale, wm.role FROM users u
         JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = $2
        WHERE u.id = $1 AND u.disabled_at IS NULL`,
      [row.user_id, row.workspace_id],
    ),
  );
  if (!u || !['owner', 'admin', 'member'].includes(u.role)) return null;
  return {
    deps,
    userId: u.id,
    user: { id: u.id, email: u.email, name: u.name, timezone: u.timezone, locale: u.locale },
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    role: u.role,
    tx: (fn) => withTenant(deps.pool, row.org_id, fn),
  };
}

/** Background `connectors.sync` (org-less system job): refreshes previews; imports only when autoImport was enabled by an admin. */
export async function runBackgroundSync(deps: Deps, limit = 200) {
  const now = deps.clock.now();
  // Housekeeping of expired one-time artifacts (scheduler maintenance across orgs; no user input involved).
  await withSystem(deps.pool, async (db) => {
    await db.query('DELETE FROM connector_oauth_states WHERE expires_at < $1', [new Date(now.getTime() - 86400_000)]);
    await db.query('DELETE FROM mcp_confirmations WHERE expires_at < $1', [new Date(now.getTime() - 86400_000)]);
  });
  // Scheduler iterating orgs: claim the list in system context, do the work in each tenant's context.
  const list = await withSystem(deps.pool, (db) =>
    rows<{ id: string; org_id: string }>(
      db,
      `SELECT id, org_id FROM connector_accounts
        WHERE provider = ANY($1) AND status = 'active' AND secret_ciphertext IS NOT NULL
        ORDER BY last_sync_at NULLS FIRST LIMIT $2`,
      [[...CALENDAR_PROVIDERS], limit],
    ),
  );
  let synced = 0;
  let failed = 0;
  let autoImported = 0;
  for (const it of list) {
    try {
      const row = await withTenant(deps.pool, it.org_id, (db) => one<ConnectorRow>(db, 'SELECT * FROM connector_accounts WHERE id=$1', [it.id]));
      if (!row) continue;
      const ctx = await ownerCtx(deps, row);
      if (!ctx) continue;
      await refreshConnector(deps, row, defaultRange(now), ctx.user.timezone || 'Asia/Tokyo');
      synced++;
      if (row.config?.autoImport === true) {
        const horizon = new Date(now.getTime() + 14 * 86400_000);
        autoImported += await withTenant(deps.pool, row.org_id, async (db) => {
          const ids = await rows<{ id: string }>(
            db,
            `SELECT ce.id FROM connector_events ce
              WHERE ce.connector_id=$1 AND ce.all_day = false AND ce.starts_at >= $2 AND ce.starts_at < $3
                AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.workspace_id = ce.workspace_id AND m.calendar_event_id = ce.event_key AND m.deleted_at IS NULL)
              LIMIT 100`,
            [row.id, now, horizon],
          );
          if (!ids.length) return 0;
          const r = await importEvents(db, ctx, row.id, ids.map((x) => x.id));
          return r.created.length;
        });
      }
    } catch (e) {
      failed++;
      deps.log.error({ connectorId: it.id, err: safeErrorMessage(e) }, 'connector sync failed');
    }
  }
  return { synced, failed, autoImported };
}
