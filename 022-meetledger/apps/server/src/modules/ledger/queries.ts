// Reusable ledger queries (ACL applied in SQL via itemVisibleSql). Other modules may import these
// (dashboard, brief, memory, follow-up, MCP, export) instead of re-implementing ledger SQL.
//
// Scale (spec §40: 500k decisions / actions / commitments per workspace):
//  * keyset pagination on plain columns ((sort col, id) row comparison) backed by migration 021 indexes. Plain columns
//    matter: under row level security only leakproof expressions become index conditions (COALESCE is not).
//  * `total` is exact and computed on the first page only (cursor absent), index-only with the itemVisibleSql ACL.
//  * JIT is switched off per transaction: pessimistic ACL subplan estimates would otherwise trigger ~250 ms of compilation.
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, QuestionDto } from '@meetledger/shared';
import { one, rows, type Db } from '../../db/pool';
import { badRequest } from '../../lib/errors';
import { isUuid, itemVisibleSql } from '../../rbac/access';
import { MEETING_COLS, MEETING_JOIN, TABLE, Where, myPersonIds, todayOf, type LedgerScope, type LedgerType } from './common';
import { actionDto, commitmentDto, contradictionDto, decisionDto, loadSegStates, questionDto } from './mappers';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Exact number of matching visible items; computed on the first page only (null when a cursor is given). */
  total: number | null;
}
export interface PageOpts {
  limit?: number;
  /** opaque keyset cursor returned as nextCursor */
  cursor?: string | null;
  /** skip the total count (internal callers that do not need it) */
  noTotal?: boolean;
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
/** Internal callers (per-meeting ledger) may read larger bounded pages. */
const MAX_INTERNAL_PAGE = 500;

// ---------------------------------------------------------------- keyset cursor
interface Sort {
  /** plain column of alias x (never an expression: see header) */
  col: string;
  dir: 'ASC' | 'DESC';
  cast: 'timestamptz' | 'date';
}
const SORT: Record<LedgerType, Sort> = {
  decision: { col: 'decided_at', dir: 'DESC', cast: 'timestamptz' },
  action: { col: 'due_date', dir: 'ASC', cast: 'date' },
  commitment: { col: 'due_date', dir: 'ASC', cast: 'date' },
  question: { col: 'created_at', dir: 'DESC', cast: 'timestamptz' },
};

export function encodeCursor(v: string | null, id: string): string {
  return Buffer.from(JSON.stringify([v, id])).toString('base64url');
}
export function decodeCursor(c: string, cast: 'timestamptz' | 'date' | 'any' = 'any'): { v: string | null; id: string } {
  try {
    const [v, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    const okV = v === null || (typeof v === 'string' && (cast === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(v) : !Number.isNaN(Date.parse(v))));
    if (okV && isUuid(id)) return { v, id };
  } catch {
    /* fall through */
  }
  throw badRequest('Invalid cursor');
}
const sortValue = (row: any, s: Sort): string | null => {
  const v = row[s.col];
  if (v == null) return null;
  return s.cast === 'date' ? String(v) : new Date(v).toISOString();
};

const COMMITMENT_EXTRA = (alias: string) => `LEFT JOIN people pbp ON pbp.id = ${alias}.promised_by_person_id`;

function clampLimit(limit: number | undefined, internal = false) {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), internal ? MAX_INTERNAL_PAGE : MAX_PAGE);
}

/** WHERE builder pre-seeded with $1 = workspace, $2 = user. */
function where(scope: LedgerScope) {
  return new Where([scope.workspaceId, scope.userId]);
}

/**
 * One page ordered by (sort col NULLS LAST, id). With a cursor the next rows are read with an index-friendly row
 * comparison; rows with a NULL sort value (rare: imports) follow in a second branch.
 */
async function fetchPage(db: Db, type: LedgerType, w: Where, page: PageOpts, internal = false) {
  const s = SORT[type];
  const limit = clampLimit(page.limit, internal);
  const extraJoin = type === 'commitment' ? COMMITMENT_EXTRA('x') : '';
  const extraCols = type === 'commitment' ? ', pbp.user_id AS promised_by_person_user_id' : '';
  const params = [...w.params];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const base = `SELECT x.*, ${MEETING_COLS}${extraCols} FROM ${TABLE[type]} x ${MEETING_JOIN('x')} ${extraJoin}
                 WHERE x.workspace_id = $1 AND ${itemVisibleSql('x', '$2')} AND ${w.sql()}`;
  const order = `ORDER BY x.${s.col} ${s.dir} NULLS LAST, x.id ${s.dir}`;
  const cmp = s.dir === 'DESC' ? '<' : '>';
  let sql: string;
  if (!page.cursor) {
    sql = `${base} ${order} LIMIT ${limit + 1}`;
  } else {
    const c = decodeCursor(page.cursor, s.cast);
    if (c.v === null) {
      sql = `${base} AND x.${s.col} IS NULL AND x.id ${cmp} ${p(c.id)}::uuid ORDER BY x.id ${s.dir} LIMIT ${limit + 1}`;
    } else {
      const v = p(c.v);
      const id = p(c.id);
      sql = `SELECT * FROM (
               (${base} AND (x.${s.col}, x.id) ${cmp} (${v}::${s.cast}, ${id}::uuid) ${order} LIMIT ${limit + 1})
               UNION ALL
               (${base} AND x.${s.col} IS NULL ORDER BY x.id ${s.dir} LIMIT ${limit + 1})
             ) pg ORDER BY pg.${s.col} ${s.dir} NULLS LAST, pg.id ${s.dir} LIMIT ${limit + 1}`;
    }
  }
  const list = await rows(db, sql, params);
  const more = list.length > limit;
  const pageRows = list.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return { list: pageRows, nextCursor: more && last ? encodeCursor(sortValue(last, s), last.id) : null };
}

/** Exact count of visible matching rows (index-only scan; the meeting ACL is checked through a hashed itemVisibleSql subplan). */
async function countVisible(db: Db, type: LedgerType, w: Where): Promise<number> {
  const extraJoin = type === 'commitment' ? COMMITMENT_EXTRA('x') : '';
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM ${TABLE[type]} x ${extraJoin} WHERE x.workspace_id = $1 AND ${itemVisibleSql('x', '$2')} AND ${w.sql()}`,
    w.params,
  );
  return r?.n ?? 0;
}

async function pageOf<T>(db: Db, type: LedgerType, w: Where, f: PageOpts, map: (rows: any[]) => Promise<T[]> | T[], internal = false): Promise<Page<T>> {
  // Short OLTP queries: JIT compilation (triggered by pessimistic ACL subplan estimates) costs more than it saves.
  await db.query('SET LOCAL jit = off');
  const { list, nextCursor } = await fetchPage(db, type, w, f, internal);
  const total = f.cursor || f.noTotal ? null : list.length < clampLimit(f.limit, internal) && !nextCursor ? list.length : await countVisible(db, type, w);
  return { items: await map(list), nextCursor, total };
}

// ---------------------------------------------------------------- decisions
export interface DecisionFilters extends PageOpts {
  view?: 'current' | 'all' | 'candidates' | 'superseded';
  projectId?: string;
  seriesId?: string;
  personId?: string;
  meetingId?: string;
  topicKey?: string;
  ids?: string[];
}

function decisionWhere(scope: LedgerScope, f: DecisionFilters) {
  const w = where(scope);
  switch (f.view ?? 'current') {
    case 'current':
      w.add("x.review_state = 'confirmed' AND x.status = 'active'");
      break;
    case 'candidates':
      w.add("x.review_state = 'candidate'");
      break;
    case 'superseded':
      w.add("x.review_state = 'confirmed' AND x.status = 'superseded'");
      break;
    case 'all':
      w.add("x.review_state <> 'rejected'");
      break;
  }
  if (f.projectId) w.add('x.project_id = ?', f.projectId);
  if (f.seriesId) w.add('x.series_id = ?', f.seriesId);
  if (f.meetingId) w.add('x.meeting_id = ?', f.meetingId);
  if (f.topicKey) w.add('x.topic_key = ?', f.topicKey);
  if (f.ids) w.add('x.id = ANY(?)', f.ids);
  if (f.personId) {
    const p = w.p(f.personId);
    w.parts.push(`(x.owner_person_id = ${p} OR ${p} = ANY(x.participant_person_ids) OR EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = x.meeting_id AND pa.person_id = ${p}))`);
  }
  return w;
}

export async function listDecisions(db: Db, scope: LedgerScope, f: DecisionFilters = {}, internal = false): Promise<Page<DecisionDto>> {
  return pageOf(db, 'decision', decisionWhere(scope, f), f, async (list) => {
    const states = await loadSegStates(db, list);
    return list.map((r) => decisionDto(r, states));
  }, internal);
}

// ---------------------------------------------------------------- actions
export interface ActionFilters extends PageOpts {
  status?: string;
  assignee?: 'me';
  assigneePersonId?: string;
  overdue?: boolean;
  meetingId?: string;
  projectId?: string;
  includeRejected?: boolean;
}

export async function listActions(db: Db, scope: LedgerScope, f: ActionFilters = {}, internal = false): Promise<Page<ActionDto>> {
  const w = where(scope);
  const today = todayOf(scope);
  if (f.status === 'open') w.add("x.status IN ('confirmed','in_progress')");
  else if (f.status) w.add('x.status = ?', f.status);
  else if (!f.includeRejected) w.add("x.status <> 'rejected'");
  if (f.assignee === 'me') {
    const mine = await myPersonIds(db, scope);
    // Without linked people the predicate is a single indexable equality.
    if (mine.length) w.add('(x.assignee_user_id = $2 OR x.assignee_person_id = ANY(?))', mine);
    else w.add('x.assignee_user_id = $2');
  }
  if (f.assigneePersonId) w.add('x.assignee_person_id = ?', f.assigneePersonId);
  if (f.overdue) w.add("x.due_date < ?::date AND x.status IN ('confirmed','in_progress')", today);
  if (f.meetingId) w.add('x.meeting_id = ?', f.meetingId);
  if (f.projectId) w.add('x.project_id = ?', f.projectId);
  return pageOf(db, 'action', w, f, async (list) => {
    const states = await loadSegStates(db, list);
    return list.map((r) => actionDto(r, states, today));
  }, internal);
}

// ---------------------------------------------------------------- commitments
export interface CommitmentFilters extends PageOpts {
  direction?: 'mine' | 'theirs' | 'all';
  status?: string;
  overdue?: boolean;
  meetingId?: string;
  projectId?: string;
  personId?: string;
  includeRejected?: boolean;
}

export async function listCommitments(db: Db, scope: LedgerScope, f: CommitmentFilters = {}, internal = false): Promise<Page<CommitmentDto>> {
  const w = where(scope);
  const today = todayOf(scope);
  const mine = await myPersonIds(db, scope);
  if (f.status === 'open') w.add("x.status = 'open'");
  else if (f.status) w.add('x.status = ?', f.status);
  else if (!f.includeRejected) w.add("x.status <> 'rejected'");
  if (f.direction && f.direction !== 'all') {
    const my = mine.length ? w.p(mine) : null;
    const byMe = my ? `(x.promised_by_user_id = $2 OR x.promised_by_person_id = ANY(${my}))` : 'x.promised_by_user_id = $2';
    const isMine = `coalesce(${byMe}, false)`;
    if (f.direction === 'mine') w.parts.push(byMe);
    else
      w.parts.push(
        `(NOT ${isMine} AND (coalesce(x.promised_to_user_id = $2, false) ${my ? `OR coalesce(x.promised_to_person_id = ANY(${my}), false)` : ''}
          OR (x.promised_by_person_id IS NOT NULL AND x.promised_by_user_id IS NULL AND pbp.user_id IS NULL)))`,
      );
  }
  if (f.overdue) w.add("x.due_date < ?::date AND x.status = 'open'", today);
  if (f.meetingId) w.add('x.meeting_id = ?', f.meetingId);
  if (f.projectId) w.add('x.project_id = ?', f.projectId);
  if (f.personId) {
    const p = w.p(f.personId);
    w.parts.push(`(x.promised_by_person_id = ${p} OR x.promised_to_person_id = ${p})`);
  }
  const set = new Set(mine);
  return pageOf(db, 'commitment', w, f, async (list) => {
    const states = await loadSegStates(db, list);
    return list.map((r) => commitmentDto(r, states, today, scope.userId, set));
  }, internal);
}

// ---------------------------------------------------------------- questions
export interface QuestionFilters extends PageOpts {
  status?: string;
  meetingId?: string;
  projectId?: string;
  includeRejected?: boolean;
}

export async function listQuestions(db: Db, scope: LedgerScope, f: QuestionFilters = {}, internal = false): Promise<Page<QuestionDto>> {
  const w = where(scope);
  if (f.status) w.add('x.status = ?', f.status);
  else if (!f.includeRejected) w.add("x.status <> 'rejected'");
  if (f.meetingId) w.add('x.meeting_id = ?', f.meetingId);
  if (f.projectId) w.add('x.project_id = ?', f.projectId);
  return pageOf(db, 'question', w, f, async (list) => {
    const states = await loadSegStates(db, list);
    return list.map((r) => questionDto(r, states));
  }, internal);
}

// ---------------------------------------------------------------- single item DTO
export async function itemDto(db: Db, scope: LedgerScope, type: LedgerType, row: any) {
  const states = await loadSegStates(db, [row]);
  if (type === 'decision') return decisionDto(row, states);
  if (type === 'action') return actionDto(row, states, todayOf(scope));
  if (type === 'question') return questionDto(row, states);
  const r = row.promised_by_person_user_id !== undefined ? row : { ...row, promised_by_person_user_id: await personUserId(db, row.promised_by_person_id) };
  return commitmentDto(r, states, todayOf(scope), scope.userId, new Set(await myPersonIds(db, scope)));
}

async function personUserId(db: Db, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const r = await rows<{ user_id: string | null }>(db, 'SELECT user_id FROM people WHERE id=$1', [personId]);
  return r[0]?.user_id ?? null;
}

// ---------------------------------------------------------------- contradictions
export interface ContradictionFilters {
  status?: 'open' | 'confirmed_change' | 'not_change' | 'dismissed' | 'all';
  meetingId?: string;
  /** contradictions raised in any of these meetings (Review Inbox page) */
  meetingIds?: string[];
  /** with meetingIds: also contradictions not attached to a meeting */
  includeNullMeeting?: boolean;
  ids?: string[];
  limit?: number;
  cursor?: string | null;
}

function contradictionWhere(scope: LedgerScope, f: ContradictionFilters) {
  const w = where(scope);
  if (!f.status || f.status === 'open') w.add("c.status = 'open'");
  else if (f.status !== 'all') w.add('c.status = ?', f.status);
  if (f.meetingId) w.add('(c.meeting_id = ? OR ed.meeting_id = ? OR nd.meeting_id = ?)', f.meetingId, f.meetingId, f.meetingId);
  if (f.meetingIds) w.add(f.includeNullMeeting ? '(c.meeting_id = ANY(?) OR c.meeting_id IS NULL)' : 'c.meeting_id = ANY(?)', f.meetingIds);
  if (f.ids) w.add('c.id = ANY(?)', f.ids);
  return w;
}
const CONTRADICTION_FROM = (w: Where) => `FROM contradiction_candidates c
       JOIN decisions ed ON ed.id = c.existing_decision_id
       JOIN decisions nd ON nd.id = c.new_decision_id
      WHERE c.workspace_id = $1 AND ${itemVisibleSql('ed', '$2')} AND ${itemVisibleSql('nd', '$2')} AND ${w.sql()}`;

/** Both decisions must be visible to the user (a contradiction must not reveal a decision of an inaccessible meeting). */
export async function pageContradictions(db: Db, scope: LedgerScope, f: ContradictionFilters = {}): Promise<Page<ContradictionDto>> {
  await db.query('SET LOCAL jit = off');
  const w = contradictionWhere(scope, f);
  const limit = clampLimit(f.limit, true);
  const params = [...w.params];
  let keyset = '';
  if (f.cursor) {
    const c = decodeCursor(f.cursor, 'timestamptz');
    params.push(c.v, c.id);
    keyset = ` AND (c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  const list = await rows(db, `SELECT c.* ${CONTRADICTION_FROM(w)}${keyset} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`, params);
  const more = list.length > limit;
  const pageRows = list.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const total = f.cursor ? null : more ? ((await one<{ n: number }>(db, `SELECT count(*)::int AS n ${CONTRADICTION_FROM(w)}`, w.params))?.n ?? 0) : pageRows.length;
  if (!pageRows.length) return { items: [], nextCursor: null, total };
  const decIds = [...new Set(pageRows.flatMap((c) => [c.existing_decision_id, c.new_decision_id]))];
  const byId = new Map((await decisionsByIds(db, scope, decIds)).map((d) => [d.id, d]));
  return {
    items: pageRows
      .filter((c) => byId.has(c.existing_decision_id) && byId.has(c.new_decision_id))
      .map((c) => contradictionDto(c, byId.get(c.existing_decision_id)!, byId.get(c.new_decision_id)!)),
    nextCursor: more && last ? encodeCursor(new Date(last.created_at).toISOString(), last.id) : null,
    total,
  };
}

/** Bounded list (first page) — kept for callers that only need the items. */
export async function listContradictions(db: Db, scope: LedgerScope, f: ContradictionFilters = {}): Promise<ContradictionDto[]> {
  return (await pageContradictions(db, scope, f)).items;
}

/** Decisions by id in any state (ACL applied). */
export async function decisionsByIds(db: Db, scope: LedgerScope, ids: string[]): Promise<DecisionDto[]> {
  if (!ids.length) return [];
  const list = await rows(
    db,
    `SELECT x.*, ${MEETING_COLS} FROM decisions x ${MEETING_JOIN('x')} WHERE x.workspace_id = $1 AND ${itemVisibleSql('x', '$2')} AND x.id = ANY($3)`,
    [scope.workspaceId, scope.userId, ids],
  );
  const states = await loadSegStates(db, list);
  return list.map((r) => decisionDto(r, states));
}

// ---------------------------------------------------------------- per meeting
export async function meetingLedger(db: Db, scope: LedgerScope, meetingId: string, includeRejected = false) {
  const opts = { meetingId, includeRejected, limit: MAX_INTERNAL_PAGE, noTotal: true };
  const decisions = await listDecisions(db, scope, { view: 'all', ...opts }, true);
  const actions = await listActions(db, scope, opts, true);
  const commitments = await listCommitments(db, scope, opts, true);
  const questions = await listQuestions(db, scope, opts, true);
  const contradictions = await listContradictions(db, scope, { status: 'all', meetingId });
  let decisionItems = decisions.items;
  if (includeRejected) {
    const rejected = await rows(db, "SELECT id FROM decisions WHERE meeting_id=$1 AND workspace_id=$2 AND review_state='rejected'", [meetingId, scope.workspaceId]);
    decisionItems = [...decisionItems, ...(await decisionsByIds(db, scope, rejected.map((r) => r.id)))];
  }
  return { decisions: decisionItems, actions: actions.items, commitments: commitments.items, questions: questions.items, contradictions };
}
