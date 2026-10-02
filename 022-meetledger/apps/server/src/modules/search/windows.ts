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

/** Is `tsvector @@ tsquery` leakproof here (a DBA may mark it so)? Then GIN indexes are usable under RLS. Cached 1 min. */
let ginCache: { at: number; value: boolean } | null = null;
let ginOverride: boolean | null = null;
export function setGinOverride(v: boolean | null) {
  ginOverride = v;
}
export async function ginUsable(db: Db): Promise<boolean> {
  if (ginOverride !== null) return ginOverride;
  if (ginCache && Date.now() - ginCache.at < 60_000) return ginCache.value;
  const r = await one<{ lp: boolean }>(db, "SELECT proleakproof AS lp FROM pg_proc WHERE oid = 'ts_match_vq(tsvector,tsquery)'::regprocedure");
  ginCache = { at: Date.now(), value: !!r?.lp };
  return ginCache.value;
}

/**
 * Text match used INSIDE window queries. The function-call form `ts_match_vq(col, q)` is semantically `col @@ q` but is
 * never turned into a GIN index condition, so the planner keeps the btree (meeting_id) driven plan even when a DBA has
 * made `@@` leakproof (a GIN bitmap over every match of a common term would be far slower than scanning one window).
 */
export function windowMatch(col: string, q: string): string {
  return `ts_match_vq(${col}, ${q})`;
}

/** Thresholds of the hybrid decision (exact GIN path vs. recency windows). */
export const EXACT_CAP = 2000;
/** Above this planner estimate a term is treated as common without executing the count probe. */
export const ESTIMATE_COMMON = 20000;

export type SearchPath = 'exact' | 'window' | 'probe';

/**
 * Hybrid decision. Without a usable GIN (default: `@@` not leakproof under RLS) always 'window'.
 * With GIN: a planner estimate above ESTIMATE_COMMON -> 'window' (no probe); otherwise 'probe', and after the probe
 * 'exact' only when every branch has at most EXACT_CAP raw matches (complete results), else 'window'.
 */
export function decideSearchPath(i: { gin: boolean; estimate?: number | null; probe?: number[] | null; probeTimedOut?: boolean }): SearchPath {
  if (!i.gin) return 'window';
  if (i.probeTimedOut) return 'window';
  if (i.probe) return i.probe.every((n) => n <= EXACT_CAP) ? 'exact' : 'window';
  if (i.estimate != null && i.estimate > ESTIMATE_COMMON) return 'window';
  return 'probe';
}

/**
 * Upper bound of matches for a search query: per-lexeme planner estimates combined as min within a phrase / across
 * AND-ed terms (+ legacy alternative). PostgreSQL multiplies phrase lexeme selectivities as if independent, which
 * underestimates phrases of correlated bigrams (研修の日程 -> 33 rows estimated vs ~430k actual), so we bound instead.
 * A lexeme that is not among the column's most-common elements gets PostgreSQL's DEFAULT estimate (the same value as
 * for an absent lexeme); such a lexeme may be rare, so it bounds the term at 0 (-> the cheap, time-guarded probe decides).
 */
export async function estimateUpperBound(db: Db, table: 'transcript_segments' | 'search_docs', terms: { phrase: { literal: string }[]; legacy: { literal: string } | null }[]): Promise<number | null> {
  if (!terms.length) return 0;
  const cache = new Map<string, number | null>();
  const est = async (lit: string) => {
    if (!cache.has(lit)) cache.set(lit, await estimateMatches(db, table, lit));
    return cache.get(lit)!;
  };
  const unknown = await est(ABSENT_LEXEME);
  let bound = Infinity;
  for (const t of terms.slice(0, 8)) {
    let phraseMin = Infinity;
    for (const l of t.phrase.slice(0, 8)) {
      const e = await est(l.literal);
      if (e == null) return null;
      phraseMin = Math.min(phraseMin, unknown != null && e <= unknown ? 0 : e);
    }
    let legacy = 0;
    if (t.legacy) {
      const e = await est(t.legacy.literal);
      if (e == null) return null;
      legacy = unknown != null && e <= unknown ? 0 : e;
    }
    bound = Math.min(bound, phraseMin + legacy);
  }
  return Number.isFinite(bound) ? bound : null;
}

/** A lexeme that never occurs: its estimate is PostgreSQL's default for lexemes outside the most-common elements. */
export const ABSENT_LEXEME = "'zq0x9absentlexeme7v'";

/** Probe timeout: a probe that cannot finish this fast means "many matches" -> windows. */
export const PROBE_TIMEOUT_MS = 150;

/**
 * Counts raw GIN matches (capped at EXACT_CAP + 1) per branch under a short statement timeout (savepoint-protected).
 * Returns null when the probe timed out (= common term).
 */
export async function probeMatches(db: Db, tsq: string, workspaceId: string, want: { seg: boolean; doc: boolean }): Promise<number[] | null> {
  const prev = (await one<{ v: string }>(db, "SELECT current_setting('statement_timeout') AS v"))?.v ?? '0';
  await db.query('SAVEPOINT ml_search_probe');
  try {
    await db.query("SELECT set_config('statement_timeout', $1, true)", [`${PROBE_TIMEOUT_MS}ms`]);
    const r = await one<{ seg: number; doc: number }>(
      db,
      `SELECT ${want.seg ? `(SELECT count(*) FROM (SELECT 1 FROM transcript_segments s WHERE s.tsv @@ $1::tsquery LIMIT ${EXACT_CAP + 1}) a)::int` : '0'} AS seg,
              ${want.doc ? `(SELECT count(*) FROM (SELECT 1 FROM search_docs d WHERE d.workspace_id = $2 AND d.tsv @@ $1::tsquery LIMIT ${EXACT_CAP + 1}) b)::int` : '0'} AS doc`,
      [tsq, workspaceId],
    );
    await db.query("SELECT set_config('statement_timeout', $1, true)", [prev]);
    await db.query('RELEASE SAVEPOINT ml_search_probe');
    return [r?.seg ?? Infinity, r?.doc ?? Infinity];
  } catch (e: any) {
    await db.query('ROLLBACK TO SAVEPOINT ml_search_probe'); // also reverts the statement_timeout change
    await db.query('RELEASE SAVEPOINT ml_search_probe');
    if (e?.code === '57014') return null; // query_canceled (timeout)
    throw e;
  }
}

/** Planner row estimate for `table.tsv @@ q` (EXPLAIN only, nothing is executed). */
export async function estimateMatches(db: Db, table: 'transcript_segments' | 'search_docs', tsq: string): Promise<number | null> {
  try {
    const r = await one<{ 'QUERY PLAN': any }>(db, `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${table} x WHERE x.tsv @@ $1::tsquery`, [tsq]);
    const plan = r?.['QUERY PLAN'];
    const root = Array.isArray(plan) ? plan[0]?.Plan : null;
    return typeof root?.['Plan Rows'] === 'number' ? root['Plan Rows'] : null;
  } catch {
    return null;
  }
}
