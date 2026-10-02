// Reusable ledger queries (ACL applied in SQL via itemVisibleSql). Other modules may import these
// (dashboard, brief, memory, follow-up, MCP, export) instead of re-implementing ledger SQL.
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, QuestionDto } from '@meetledger/shared';
import { rows, type Db } from '../../db/pool';
import { itemVisibleSql } from '../../rbac/access';
import { MEETING_COLS, MEETING_JOIN, TABLE, Where, myPersonIds, todayOf, type LedgerScope, type LedgerType } from './common';
import { actionDto, commitmentDto, contradictionDto, decisionDto, loadSegStates, questionDto } from './mappers';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
interface PageOpts {
  limit?: number;
  /** opaque offset cursor returned as nextCursor */
  cursor?: string | null;
}

const COMMITMENT_EXTRA = (alias: string) => `LEFT JOIN people pbp ON pbp.id = ${alias}.promised_by_person_id`;

async function fetchRows(db: Db, scope: LedgerScope, type: LedgerType, w: Where, order: string, page: PageOpts) {
  const limit = Math.min(Math.max(page.limit ?? 200, 1), 500);
  const offset = Math.max(Number.parseInt(page.cursor ?? '0', 10) || 0, 0);
  const extraJoin = type === 'commitment' ? COMMITMENT_EXTRA('x') : '';
  const extraCols = type === 'commitment' ? ', pbp.user_id AS promised_by_person_user_id' : '';
  const params = [scope.workspaceId, scope.userId, ...w.params.slice(2)];
  const list = await rows(
    db,
    `SELECT x.*, ${MEETING_COLS}${extraCols} FROM ${TABLE[type]} x ${MEETING_JOIN('x')} ${extraJoin}
      WHERE x.workspace_id = $1 AND ${itemVisibleSql('x', '$2')} AND ${w.sql()}
      ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`,
    params,
  );
  const more = list.length > limit;
  return { list: list.slice(0, limit), nextCursor: more ? String(offset + limit) : null };
}

/** WHERE builder pre-seeded with $1 = workspace, $2 = user. */
function where(scope: LedgerScope) {
  return new Where([scope.workspaceId, scope.userId]);
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

export async function listDecisions(db: Db, scope: LedgerScope, f: DecisionFilters = {}): Promise<Page<DecisionDto>> {
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
  const { list, nextCursor } = await fetchRows(db, scope, 'decision', w, 'coalesce(x.decided_at, x.created_at) DESC, x.created_at DESC, x.id', f);
  const states = await loadSegStates(db, list);
  return { items: list.map((r) => decisionDto(r, states)), nextCursor };
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

export async function listActions(db: Db, scope: LedgerScope, f: ActionFilters = {}): Promise<Page<ActionDto>> {
  const w = where(scope);
  const today = todayOf(scope);
  if (f.status === 'open') w.add("x.status IN ('confirmed','in_progress')");
  else if (f.status) w.add('x.status = ?', f.status);
  else if (!f.includeRejected) w.add("x.status <> 'rejected'");
  if (f.assignee === 'me') {
    const mine = await myPersonIds(db, scope);
    w.add('(coalesce(x.assignee_user_id = $2, false) OR coalesce(x.assignee_person_id = ANY(?), false))', mine);
  }
  if (f.assigneePersonId) w.add('x.assignee_person_id = ?', f.assigneePersonId);
  if (f.overdue) w.add("x.due_date < ?::date AND x.status IN ('confirmed','in_progress')", today);
  if (f.meetingId) w.add('x.meeting_id = ?', f.meetingId);
  if (f.projectId) w.add('x.project_id = ?', f.projectId);
  const { list, nextCursor } = await fetchRows(db, scope, 'action', w, 'x.due_date ASC NULLS LAST, x.created_at DESC, x.id', f);
  const states = await loadSegStates(db, list);
  return { items: list.map((r) => actionDto(r, states, today)), nextCursor };
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

export async function listCommitments(db: Db, scope: LedgerScope, f: CommitmentFilters = {}): Promise<Page<CommitmentDto>> {
  const w = where(scope);
  const today = todayOf(scope);
  const mine = await myPersonIds(db, scope);
  if (f.status === 'open') w.add("x.status = 'open'");
  else if (f.status) w.add('x.status = ?', f.status);
  else if (!f.includeRejected) w.add("x.status <> 'rejected'");
  if (f.direction && f.direction !== 'all') {
    const my = w.p(mine);
    const isMine = `(coalesce(x.promised_by_user_id = $2, false) OR coalesce(x.promised_by_person_id = ANY(${my}), false))`;
    if (f.direction === 'mine') w.parts.push(isMine);
    else
      w.parts.push(
        `(NOT ${isMine} AND (coalesce(x.promised_to_user_id = $2, false) OR coalesce(x.promised_to_person_id = ANY(${my}), false)
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
  const { list, nextCursor } = await fetchRows(db, scope, 'commitment', w, 'x.due_date ASC NULLS LAST, x.created_at DESC, x.id', f);
  const states = await loadSegStates(db, list);
  const set = new Set(mine);
  return { items: list.map((r) => commitmentDto(r, states, today, scope.userId, set)), nextCursor };
}

// ---------------------------------------------------------------- questions
export interface QuestionFilters extends PageOpts {
  status?: string;
  meetingId?: string;
  projectId?: string;
  includeRejected?: boolean;
}

export async function listQuestions(db: Db, scope: LedgerScope, f: QuestionFilters = {}): Promise<Page<QuestionDto>> {
  const w = where(scope);
  if (f.status) w.add('x.status = ?', f.status);
  else if (!f.includeRejected) w.add("x.status <> 'rejected'");
  if (f.meetingId) w.add('x.meeting_id = ?', f.meetingId);
  if (f.projectId) w.add('x.project_id = ?', f.projectId);
  const { list, nextCursor } = await fetchRows(db, scope, 'question', w, 'x.created_at DESC, x.id', f);
  const states = await loadSegStates(db, list);
  return { items: list.map((r) => questionDto(r, states)), nextCursor };
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
  ids?: string[];
  limit?: number;
}

/** Both decisions must be visible to the user (a contradiction must not reveal a decision of an inaccessible meeting). */
export async function listContradictions(db: Db, scope: LedgerScope, f: ContradictionFilters = {}): Promise<ContradictionDto[]> {
  const w = where(scope);
  if (!f.status || f.status === 'open') w.add("c.status = 'open'");
  else if (f.status !== 'all') w.add('c.status = ?', f.status);
  if (f.meetingId) w.add('(c.meeting_id = ? OR ed.meeting_id = ? OR nd.meeting_id = ?)', f.meetingId, f.meetingId, f.meetingId);
  if (f.ids) w.add('c.id = ANY(?)', f.ids);
  const list = await rows(
    db,
    `SELECT c.* FROM contradiction_candidates c
       JOIN decisions ed ON ed.id = c.existing_decision_id
       JOIN decisions nd ON nd.id = c.new_decision_id
      WHERE c.workspace_id = $1 AND ${itemVisibleSql('ed', '$2')} AND ${itemVisibleSql('nd', '$2')} AND ${w.sql()}
      ORDER BY c.created_at DESC LIMIT ${Math.min(Math.max(f.limit ?? 200, 1), 500)}`,
    w.params,
  );
  if (!list.length) return [];
  const decIds = [...new Set(list.flatMap((c) => [c.existing_decision_id, c.new_decision_id]))];
  const byId = new Map((await decisionsByIds(db, scope, decIds)).map((d) => [d.id, d]));
  return list.filter((c) => byId.has(c.existing_decision_id) && byId.has(c.new_decision_id)).map((c) => contradictionDto(c, byId.get(c.existing_decision_id)!, byId.get(c.new_decision_id)!));
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
  const [decisions, actions, commitments, questions, contradictions] = [
    await listDecisions(db, scope, { view: 'all', meetingId, limit: 500 }),
    await listActions(db, scope, { meetingId, includeRejected, limit: 500 }),
    await listCommitments(db, scope, { meetingId, includeRejected, limit: 500 }),
    await listQuestions(db, scope, { meetingId, includeRejected, limit: 500 }),
    await listContradictions(db, scope, { status: 'all', meetingId }),
  ];
  let decisionItems = decisions.items;
  if (includeRejected) {
    const rejected = await rows(db, "SELECT id FROM decisions WHERE meeting_id=$1 AND workspace_id=$2 AND review_state='rejected'", [meetingId, scope.workspaceId]);
    decisionItems = [...decisionItems, ...(await decisionsByIds(db, scope, rejected.map((r) => r.id)))];
  }
  return { decisions: decisionItems, actions: actions.items, commitments: commitments.items, questions: questions.items, contradictions };
}
