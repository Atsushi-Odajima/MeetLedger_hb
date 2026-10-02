// Recency windows over the meetings a user may see.
//
// Why: under FORCE RLS PostgreSQL can only use an index when the qual's operator is LEAKPROOF. `tsvector @@ tsquery`
// is not, so the GIN indexes on tsv cannot serve tenant queries and a plain FTS query becomes a full scan of all
// transcript segments. Instead we walk the visible meetings newest-first via a btree (meetings_ws_mdate, keyset on
// leakproof timestamptz/uuid comparisons) and match content only inside each window (btree on meeting_id).
// The window list itself is computed with meetingVisibleSql, and every content query joins meetings with the same
// predicate again, so ACL is always applied in SQL before anything is ranked or returned.
import type { Db } from '../../db/pool';
import { one, rows } from '../../db/pool';
import { meetingVisibleSql } from '../../rbac/access';

export const MDATE = 'coalesce(m.scheduled_start, m.created_at)';

export interface WindowMeeting {
  id: string;
  title: string;
  project_id: string | null;
  mdate: Date;
}

export interface MeetingScope {
  workspaceId: string;
  userId: string;
  from?: Date | null;
  to?: Date | null;
  projectId?: string | null;
  /** restrict to these meeting ids (e.g. meetings related to a person) */
  meetingIds?: string[] | null;
  /** 'ai': AI-enabled & non-confidential only; 'excluded': AI OFF or confidential only */
  ai?: 'ai' | 'excluded' | null;
}

/**
 * SQL predicate (alias m) for the scope; pushes its parameters onto `params`. Always includes the ACL predicate.
 * `fixed` lets callers reuse placeholders already holding the workspace / user id.
 */
export function scopeSql(s: MeetingScope, params: unknown[], fixed?: { ws: string; user: string }): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const w = [`m.workspace_id = ${fixed?.ws ?? p(s.workspaceId)}`, meetingVisibleSql('m', fixed?.user ?? p(s.userId))];
  if (s.ai === 'ai') w.push('m.ai_enabled = true AND m.is_confidential = false');
  if (s.ai === 'excluded') w.push('(m.ai_enabled = false OR m.is_confidential = true)');
  if (s.from) w.push(`${MDATE} >= ${p(s.from.toISOString())}`);
  if (s.to) w.push(`${MDATE} < ${p(s.to.toISOString())}`);
  if (s.projectId) w.push(`m.project_id = ${p(s.projectId)}`);
  if (s.meetingIds) w.push(`m.id = ANY(${p(s.meetingIds)}::uuid[])`);
  return w.join(' AND ');
}

export interface Cursor {
  mdate: string;
  id: string;
}

/** Next `size` visible meetings older than `cursor` (newest first). */
export async function nextWindow(db: Db, s: MeetingScope, cursor: Cursor | null, size: number): Promise<{ meetings: WindowMeeting[]; cursor: Cursor | null; exhausted: boolean }> {
  const params: unknown[] = [];
  const where = scopeSql(s, params);
  let keyset = '';
  if (cursor) {
    params.push(cursor.mdate, cursor.id);
    const d = `$${params.length - 1}::timestamptz`;
    const i = `$${params.length}::uuid`;
    keyset = `AND ${MDATE} <= ${d} AND (${MDATE} < ${d} OR m.id < ${i})`;
  }
  params.push(size);
  const list = await rows<WindowMeeting>(
    db,
    `SELECT m.id, m.title, m.project_id, ${MDATE} AS mdate FROM meetings m
      WHERE ${where} ${keyset}
      ORDER BY ${MDATE} DESC, m.id DESC LIMIT $${params.length}`,
    params,
  );
  const last = list[list.length - 1];
  return {
    meetings: list,
    cursor: last ? { mdate: new Date(last.mdate).toISOString(), id: last.id } : cursor,
    exhausted: list.length < size,
  };
}

/** Meetings related to people: participant, or referenced by indexed content (speaker mapping, owner, promiser...). */
export async function personMeetingIds(db: Db, workspaceId: string, personIds: string | string[], max = 50000): Promise<string[]> {
  const r = await rows<{ id: string }>(
    db,
    `SELECT pa.meeting_id AS id FROM participants pa JOIN meetings m ON m.id = pa.meeting_id AND m.workspace_id = $1 WHERE pa.person_id = ANY($2::uuid[])
     UNION
     SELECT r.meeting_id FROM search_person_refs r WHERE r.workspace_id = $1 AND r.person_id = ANY($2::uuid[])
     LIMIT $3`,
    [workspaceId, Array.isArray(personIds) ? personIds : [personIds], max],
  );
  return r.map((x) => x.id);
}

/**
 * Adaptive window sizing: grow x4 per round but never beyond what the remaining time budget allows
 * at the per-meeting cost observed so far.
 */
export class WindowPlanner {
  private spentMs = 0;
  private meetingsScanned = 0;
  readonly startedAt = Date.now();
  constructor(
    private budgetMs: number,
    private size: number,
    private maxSize = 20000,
  ) {}
  record(ms: number, meetings: number) {
    this.spentMs += ms;
    this.meetingsScanned += meetings;
  }
  elapsed() {
    return Date.now() - this.startedAt;
  }
  /** size of the next window, or 0 when the budget is exhausted */
  next(): number {
    if (this.meetingsScanned === 0) return this.size; // the newest window is always searched
    const remaining = this.budgetMs - this.elapsed();
    if (remaining <= 0) return 0;
    const perMeeting = Math.max(0.01, this.spentMs / this.meetingsScanned);
    const affordable = Math.floor((remaining * 0.8) / perMeeting); // safety margin: per-meeting cost varies
    this.size = Math.min(this.size * 4, this.maxSize);
    const n = Math.min(this.size, affordable);
    return n >= Math.min(20, this.size) ? n : 0;
  }
}

/** Is `tsvector @@ tsquery` leakproof here (a DBA may mark it so)? Then GIN indexes are usable under RLS. */
let ginCache: { at: number; value: boolean } | null = null;
let ginOverride: boolean | null = null;
export function setGinOverride(v: boolean | null) {
  ginOverride = v;
}
export async function ginUsable(db: Db): Promise<boolean> {
  if (ginOverride !== null) return ginOverride;
  if (ginCache && Date.now() - ginCache.at < 10 * 60_000) return ginCache.value;
  const r = await one<{ lp: boolean }>(db, "SELECT proleakproof AS lp FROM pg_proc WHERE oid = 'ts_match_vq(tsvector,tsquery)'::regprocedure");
  ginCache = { at: Date.now(), value: !!r?.lp };
  return ginCache.value;
}
