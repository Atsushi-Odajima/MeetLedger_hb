// Shared helpers for the followup module: time zones, ledger item loading (ACL-filtered), DTO mapping.
import { dateInTz, defaultTemplateFor, findBuiltinTemplate, minutesInTz, type MeetingTemplate } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { iso } from '../../lib/http';
import { meetingVisibleSql } from '../../rbac/access';

export type Locale = 'ja' | 'en';
export const asLocale = (s: string | null | undefined): Locale => (s === 'en' ? 'en' : 'ja');

/** SQL expression for "when the meeting happened / will happen". */
export const meetingTimeSql = (a: string) => `coalesce(${a}.scheduled_start, ${a}.started_at, ${a}.created_at)`;

export function safeTz(tz: string | null | undefined, fallback = 'Asia/Tokyo'): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/** Offset (ms) of `tz` at instant `d`: local wall clock - UTC. */
export function tzOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return local - Math.floor(d.getTime() / 1000) * 1000;
}

/** UTC instant for local date `YYYY-MM-DD` at `minutes` after local midnight in `tz`. */
export function zonedTime(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(t), tz);
  t = guess - off2;
  return new Date(t);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** ISO-8601 week key (e.g. 2026-W40) of a local date. */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function localClock(d: Date, tz: string): string {
  return hhmm(minutesInTz(d, tz));
}

export function todayFor(ctx: Pick<WsCtx, 'deps' | 'user'>): string {
  return dateInTz(ctx.deps.clock.now(), safeTz(ctx.user.timezone));
}

/** Template for a meeting: built-in, else workspace custom template (templates table), else default for the type. */
export async function resolveTemplate(db: Db, workspaceId: string, key: string | null, meetingType: string): Promise<MeetingTemplate> {
  const builtin = findBuiltinTemplate(key);
  if (builtin) return builtin;
  const base = defaultTemplateFor((meetingType as any) ?? 'other');
  if (key) {
    const t = await one<any>(db, 'SELECT key, name, meeting_type, definition FROM templates WHERE workspace_id=$1 AND key=$2', [workspaceId, key]);
    if (t) return mergeTemplate(base, { ...(t.definition ?? {}), key: t.key, name: t.name, meetingType: t.meeting_type });
  }
  return base;
}

export function mergeTemplate(base: MeetingTemplate, over: Partial<MeetingTemplate>): MeetingTemplate {
  return {
    ...base,
    ...over,
    extractionRules: { ...base.extractionRules, ...(over.extractionRules ?? {}) },
    followupStyle: { ...base.followupStyle, ...(over.followupStyle ?? {}) },
    agenda: over.agenda ?? base.agenda,
    summarySections: over.summarySections ?? base.summarySections,
  };
}

// ----------------------------------------------------------------------------------------------- ledger item loading
//
// Performance notes (spec §40 scale: 500k rows per ledger table, 50k meetings):
// - Under row level security only LEAKPROOF operators (=, <, = ANY, IS NULL) can become index conditions. Every scope
//   branch is therefore a plain-column equality backed by an index (021_ledger_*, 031_followup_*), so OR-ed branches run as
//   a BitmapOr instead of a sequential scan. Non-leakproof operators (&&, @>, ILIKE, @@) are only used as post-filters.
// - ACL: every loader LEFT JOINs the source meeting `sm` and applies `meetingVisibleSql('sm', $2)` to it — exactly the
//   semantics of itemVisibleSql (meeting_id NULL = workspace item, else the meeting must be visible), but evaluated on the
//   join that is needed for the source title/date anyway (a correlated EXISTS inside an OR is planned as a hashed subplan
//   over ALL meetings of the workspace on every query).
// - Every list is LIMITed; totals come from count helpers on the same scope.

export interface SourceInfo {
  meetingId: string | null;
  meetingTitle: string | null;
  meetingDate: string | null;
}

export interface MemDecision {
  type: 'decision';
  id: string;
  text: string;
  topic: string | null;
  reason: string | null;
  status: string;
  decidedAt: string | null;
  confirmedAt: string | null;
  supersedesDecisionId: string | null;
  at: string | null;
  source: SourceInfo;
}
export interface MemAction {
  type: 'action';
  id: string;
  description: string;
  assigneeName: string | null;
  assigneePersonId: string | null;
  assigneeUserId: string | null;
  mine: boolean;
  dueDate: string | null;
  status: string;
  overdue: boolean;
  confirmedAt: string | null;
  at: string | null;
  source: SourceInfo;
}
export interface MemCommitment {
  type: 'commitment';
  id: string;
  description: string;
  promisedByName: string | null;
  promisedByPersonId: string | null;
  promisedToName: string | null;
  promisedToPersonId: string | null;
  direction: 'mine' | 'theirs' | 'other';
  dueDate: string | null;
  status: string;
  overdue: boolean;
  at: string | null;
  source: SourceInfo;
}
export interface MemQuestion {
  type: 'question';
  id: string;
  question: string;
  ownerName: string | null;
  ownerPersonId: string | null;
  dueDate: string | null;
  status: string;
  at: string | null;
  source: SourceInfo;
}
export interface MemChange {
  changedAt: string | null;
  previous: { id: string; text: string; source: SourceInfo };
  current: { id: string; text: string; source: SourceInfo } | null;
}

const src = (r: any): SourceInfo => ({ meetingId: r.meeting_id ?? null, meetingTitle: r.src_title ?? null, meetingDate: iso(r.src_date) });

/**
 * Item scope. Every loader adds `workspace_id = $1` and the meeting ACL for user `$2`, then ANDs `ands` and ORs `ors`.
 * Fragments are FIXED SQL using `{a}` for the table alias (`sm` = joined source meeting); values always go through `p()`.
 * Loaders clone the scope so their own params never leak into other queries (pg rejects unreferenced params).
 */
export class Scope {
  ors: string[] = [];
  ands: string[] = [];
  params: unknown[];
  constructor(workspaceId: string, userId: string) {
    this.params = [workspaceId, userId];
  }
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  clone(): Scope {
    const c = new Scope('', '');
    c.params = [...this.params];
    c.ors = [...this.ors];
    c.ands = [...this.ands];
    return c;
  }
}

export function newScope(workspaceId: string, userId: string): Scope {
  return new Scope(workspaceId, userId);
}

/**
 * Source meeting of an item as `sm`. LATERAL + LIMIT keeps it a per-row primary-key probe: as a plain LEFT JOIN the planner
 * hashes every meeting of the workspace (50k rows, RLS filter per row) even when only a few hundred items match.
 */
export const srcJoin = (alias: string) =>
  `LEFT JOIN LATERAL (SELECT m0.id, m0.title, m0.scheduled_start, m0.started_at, m0.created_at, m0.deleted_at, m0.visibility, m0.created_by
                        FROM meetings m0 WHERE m0.id = ${alias}.meeting_id LIMIT 1) sm ON true`;

/** itemVisibleSql semantics on the joined source meeting `sm` (see note above). */
export const itemAclOnJoin = (alias: string) => `(${alias}.meeting_id IS NULL OR ${meetingVisibleSql('sm', '$2')})`;

function whereFor(alias: string, s: Scope): string {
  const parts = [`${alias}.workspace_id = $1`, itemAclOnJoin(alias), ...s.ands.map((x) => x.replaceAll('{a}', alias))];
  if (s.ors.length) parts.push(`(${s.ors.map((x) => x.replaceAll('{a}', alias)).join(' OR ')})`);
  return parts.join(' AND ');
}

const lim = (n: number, max = 500) => Math.max(1, Math.min(max, n | 0));

const CURRENT_DECISION = `d.review_state = 'confirmed' AND d.status = 'active' AND d.superseded_by_decision_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM decisions sd WHERE sd.supersedes_decision_id = d.id AND sd.review_state = 'confirmed' AND sd.status = 'active')`;
/** "When it happened" per table (timeline order / keyset cursor; millisecond precision so cursors round-trip through ISO strings). */
export const RECENT_SQL = {
  decision: `date_trunc('milliseconds', coalesce(d.decided_at, sm.scheduled_start, sm.started_at, sm.created_at, d.confirmed_at, d.created_at))`,
  action: `date_trunc('milliseconds', coalesce(sm.scheduled_start, sm.started_at, sm.created_at, a.confirmed_at, a.created_at))`,
  commitment: `date_trunc('milliseconds', coalesce(sm.scheduled_start, sm.started_at, sm.created_at, c.created_at))`,
  question: `date_trunc('milliseconds', coalesce(sm.scheduled_start, sm.started_at, sm.created_at, q.created_at))`,
} as const;

/** Decisions: `view` current = confirmed & active & not superseded. Default order: newest decision first (item columns only). */
export async function loadDecisions(
  db: Db,
  s0: Scope,
  opts: { view: 'current' | 'confirmed_all'; limit: number; extra?: (alias: string) => string; order?: 'default' | RecentOrder },
): Promise<MemDecision[]> {
  const s = s0.clone();
  const cond = opts.view === 'current' ? CURRENT_DECISION : `d.review_state = 'confirmed'`;
  const order = isRecent(opts.order) ? recentOrder('decision', opts.order) : `coalesce(d.decided_at, d.confirmed_at, d.created_at) DESC, d.id DESC`;
  const list = await rows(
    db,
    `SELECT d.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date, ${RECENT_SQL.decision} AS at
       FROM decisions d ${srcJoin('d')}
      WHERE ${whereFor('d', s)} AND ${cond} ${opts.extra ? 'AND ' + opts.extra('d') : ''}
      ORDER BY ${order}
      LIMIT ${lim(opts.limit)}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'decision',
    id: r.id,
    text: r.text,
    topic: r.topic,
    reason: r.reason,
    status: r.status,
    decidedAt: iso(r.decided_at),
    confirmedAt: iso(r.confirmed_at),
    supersedesDecisionId: r.supersedes_decision_id,
    at: iso(r.at),
    source: src(r),
  }));
}

export type RecentOrder = 'recent' | 'recent_asc';
export type ActionOrder = 'due_asc' | 'due_desc' | RecentOrder;
const isRecent = (o: string | undefined): o is RecentOrder => o === 'recent' || o === 'recent_asc';
const ALIAS = { decision: 'd', action: 'a', commitment: 'c', question: 'q' } as const;
/** Timeline order: (at, type, id) — the same tuple the keyset cursor compares. */
const recentOrder = (kind: keyof typeof ALIAS, o: RecentOrder) => {
  const dir = o === 'recent_asc' ? 'ASC' : 'DESC';
  return `${RECENT_SQL[kind]} ${dir}, ${ALIAS[kind]}.id ${dir}`;
};

export async function loadActions(
  db: Db,
  s0: Scope,
  opts: { statuses: string[]; today: string; limit: number; extra?: (alias: string) => string; order?: ActionOrder; indexOrder?: boolean },
): Promise<MemAction[]> {
  const s = s0.clone();
  const st = s.p(opts.statuses);
  const order = isRecent(opts.order) ? recentOrder('action', opts.order) : dueOrder('a', opts.order, opts.indexOrder);
  const list = await rows(
    db,
    `SELECT a.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date, ${RECENT_SQL.action} AS at,
            coalesce(ap.name, au.name, a.assignee_text) AS assignee_name,
            (a.assignee_user_id = $2 OR ap.user_id = $2) AS mine
       FROM actions a
       ${srcJoin('a')}
       LEFT JOIN people ap ON ap.id = a.assignee_person_id
       LEFT JOIN users au ON au.id = a.assignee_user_id
      WHERE ${whereFor('a', s)} AND a.status = ANY(${st}::text[]) ${opts.extra ? 'AND ' + opts.extra('a') : ''}
      ORDER BY ${order}
      LIMIT ${lim(opts.limit)}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'action',
    id: r.id,
    description: r.description,
    assigneeName: r.assignee_name ?? null,
    assigneePersonId: r.assignee_person_id,
    assigneeUserId: r.assignee_user_id,
    mine: r.mine === true,
    dueDate: r.due_date,
    status: r.status,
    overdue: !!r.due_date && r.due_date < opts.today && ['confirmed', 'in_progress'].includes(r.status),
    confirmedAt: iso(r.confirmed_at),
    at: iso(r.at),
    source: src(r),
  }));
}

/**
 * Due-date order. By default the expression is NOT index-matchable on purpose: for scoped lists (project, series, brief)
 * an index-ordered scan + LIMIT is a trap — with few matches the planner walks the whole (workspace_id, due_date) index
 * (500k rows). `indexOrder` keeps the plain column order for lists whose own index provides it (dashboard "mine").
 */
function dueOrder(a: string, order: ActionOrder | undefined, indexOrder?: boolean): string {
  const desc = order === 'due_desc';
  if (indexOrder) return desc ? `${a}.due_date DESC NULLS LAST, ${a}.id DESC` : `${a}.due_date ASC NULLS LAST, ${a}.id ASC`;
  return desc ? `coalesce(${a}.due_date, '-infinity'::date) DESC, ${a}.id DESC` : `coalesce(${a}.due_date, 'infinity'::date) ASC, ${a}.id ASC`;
}

/** Direction relative to the current user ($2): mine = promised by me; theirs = promised to me / us (internal) or by an external person. */
export const commitmentDirectionSql = (c: string, pb: string, pt: string, me = '$2') => `CASE
  WHEN ${c}.promised_by_user_id = ${me} OR ${pb}.user_id = ${me} THEN 'mine'
  WHEN ${c}.promised_to_user_id IS NOT NULL OR ${pt}.user_id IS NOT NULL
    OR (${c}.promised_by_user_id IS NULL AND ${pb}.id IS NOT NULL AND ${pb}.user_id IS NULL) THEN 'theirs'
  ELSE 'other' END`;

export async function loadCommitments(
  db: Db,
  s0: Scope,
  opts: {
    statuses: string[];
    today: string;
    limit: number;
    extra?: (alias: string) => string;
    order?: ActionOrder;
    direction?: 'mine' | 'theirs' | 'other';
    indexOrder?: boolean;
  },
): Promise<MemCommitment[]> {
  const s = s0.clone();
  const st = s.p(opts.statuses);
  const dir = opts.direction ? `AND ${commitmentDirectionSql('c', 'pb', 'pt')} = ${s.p(opts.direction)}` : '';
  const order = isRecent(opts.order) ? recentOrder('commitment', opts.order) : dueOrder('c', opts.order, opts.indexOrder);
  const list = await rows(
    db,
    `SELECT c.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date, ${RECENT_SQL.commitment} AS at,
            coalesce(pb.name, pbu.name, c.promised_by_text) AS by_name,
            coalesce(pt.name, ptu.name, c.promised_to_text) AS to_name,
            ${commitmentDirectionSql('c', 'pb', 'pt')} AS direction
       FROM commitments c
       ${srcJoin('c')}
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id
       LEFT JOIN users pbu ON pbu.id = c.promised_by_user_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id
       LEFT JOIN users ptu ON ptu.id = c.promised_to_user_id
      WHERE ${whereFor('c', s)} AND c.status = ANY(${st}::text[]) ${dir} ${opts.extra ? 'AND ' + opts.extra('c') : ''}
      ORDER BY ${order}
      LIMIT ${lim(opts.limit)}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'commitment',
    id: r.id,
    description: r.description,
    promisedByName: r.by_name ?? null,
    promisedByPersonId: r.promised_by_person_id,
    promisedToName: r.to_name ?? null,
    promisedToPersonId: r.promised_to_person_id,
    direction: r.direction,
    dueDate: r.due_date,
    status: r.status,
    overdue: !!r.due_date && r.due_date < opts.today && r.status === 'open',
    at: iso(r.at),
    source: src(r),
  }));
}

export async function loadQuestions(
  db: Db,
  s0: Scope,
  opts: { statuses: string[]; limit: number; extra?: (alias: string) => string; order?: 'default' | RecentOrder; indexOrder?: boolean },
): Promise<MemQuestion[]> {
  const s = s0.clone();
  const st = s.p(opts.statuses);
  const order = isRecent(opts.order) ? recentOrder('question', opts.order) : opts.indexOrder ? 'q.created_at DESC, q.id DESC' : `(q.created_at + interval '0 seconds') DESC, q.id DESC`;
  const list = await rows(
    db,
    `SELECT q.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date, ${RECENT_SQL.question} AS at, op.name AS owner_name
       FROM open_questions q
       ${srcJoin('q')}
       LEFT JOIN people op ON op.id = q.owner_person_id
      WHERE ${whereFor('q', s)} AND q.status = ANY(${st}::text[]) ${opts.extra ? 'AND ' + opts.extra('q') : ''}
      ORDER BY ${order}
      LIMIT ${lim(opts.limit)}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'question',
    id: r.id,
    question: r.question,
    ownerName: r.owner_name ?? null,
    ownerPersonId: r.owner_person_id,
    dueDate: r.due_date,
    status: r.status,
    at: iso(r.at),
    source: src(r),
  }));
}

const TABLE = { decision: ['decisions', 'd'], action: ['actions', 'a'], commitment: ['commitments', 'c'], question: ['open_questions', 'q'] } as const;
export type ItemKind = keyof typeof TABLE;

/**
 * Count for a scope (same predicates as the loaders). `cond` is fixed SQL for the table alias.
 * With `cap` the count stops at `cap` (the caller shows "cap+"), bounding the cost on huge workspace-wide sets.
 */
export async function countItems(db: Db, kind: ItemKind, s0: Scope, cond: (alias: string) => string, cap?: number): Promise<number> {
  const s = s0.clone();
  const [table, a] = TABLE[kind];
  const inner = `SELECT 1 FROM ${table} ${a} ${srcJoin(a)} WHERE ${whereFor(a, s)} AND ${cond(a)}`;
  const r = await one<{ n: number }>(db, cap ? `SELECT count(*)::int AS n FROM (${inner} LIMIT ${lim(cap, 100_000)}) x` : `SELECT count(*)::int AS n FROM (${inner}) x`, s.params);
  return r?.n ?? 0;
}

export const countCurrentDecisions = (db: Db, s: Scope) => countItems(db, 'decision', s, () => CURRENT_DECISION);
export const countByStatus = (db: Db, kind: ItemKind, s0: Scope, statuses: string[], cap?: number) => {
  const s = s0.clone();
  const st = s.p(statuses);
  return countItems(db, kind, s, (a) => `${a}.status = ANY(${st}::text[])`, cap);
};

/** Open commitments per direction for the current user. */
export async function countCommitmentsByDirection(db: Db, s0: Scope, statuses: string[]): Promise<Record<'mine' | 'theirs' | 'other', number>> {
  const s = s0.clone();
  const st = s.p(statuses);
  const list = await rows<{ direction: 'mine' | 'theirs' | 'other'; n: number }>(
    db,
    `SELECT ${commitmentDirectionSql('c', 'pb', 'pt')} AS direction, count(*)::int AS n
       FROM commitments c
       ${srcJoin('c')}
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id
      WHERE ${whereFor('c', s)} AND c.status = ANY(${st}::text[])
      GROUP BY 1`,
    s.params,
  );
  const out = { mine: 0, theirs: 0, other: 0 };
  for (const r of list) out[r.direction] = r.n;
  return out;
}

/**
 * Superseded decisions (old → new) changed since `sinceIso` (old.updated_at = time of supersession), newest first.
 * The successor is looked up through two indexed equalities (superseded_by / supersedes) and must be visible too.
 */
export async function loadChanges(db: Db, s0: Scope, opts: { sinceIso: string; limit: number; indexOrder?: boolean }): Promise<MemChange[]> {
  const s = s0.clone();
  const since = s.p(opts.sinceIso);
  // workspace-wide lists walk decisions_superseded_recent; scoped lists sort their (bounded) matches instead (see dueOrder)
  const ord = opts.indexOrder ? 'd.updated_at DESC, d.id DESC' : `(d.updated_at + interval '0 seconds') DESC, d.id DESC`;
  const succ = (cond: string) => `SELECT x.id, x.text, x.meeting_id, x.confirmed_at, x.created_at, xm.title AS m_title, ${meetingTimeSql('xm')} AS m_date
      FROM decisions x LEFT JOIN LATERAL (SELECT m1.* FROM meetings m1 WHERE m1.id = x.meeting_id LIMIT 1) xm ON true
     WHERE ${cond} AND x.review_state = 'confirmed' AND (x.meeting_id IS NULL OR ${meetingVisibleSql('xm', '$2')})`;
  const list = await rows(
    db,
    `SELECT d.id, d.text, d.meeting_id, d.updated_at, d.src_title, d.src_date,
            nd.id AS new_id, nd.text AS new_text, nd.meeting_id AS new_meeting_id, nd.m_title AS new_title, nd.m_date AS new_date,
            coalesce(nd.confirmed_at, nd.created_at, d.updated_at) AS changed_at
       FROM (SELECT d.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date FROM decisions d ${srcJoin('d')}
              WHERE ${whereFor('d', s)} AND d.review_state = 'confirmed' AND d.status = 'superseded' AND d.updated_at >= ${since}::timestamptz
              ORDER BY ${ord} LIMIT ${lim(opts.limit, 200)}) d
       LEFT JOIN LATERAL (
         (${succ('x.id = d.superseded_by_decision_id')})
         UNION ALL
         (${succ('x.supersedes_decision_id = d.id')})
         LIMIT 1) nd ON true
      ORDER BY d.updated_at DESC, d.id DESC`,
    s.params,
  );
  return list.map((r) => ({
    changedAt: iso(r.changed_at),
    previous: { id: r.id, text: r.text, source: src(r) },
    current: r.new_id
      ? { id: r.new_id, text: r.new_text, source: { meetingId: r.new_meeting_id, meetingTitle: r.new_title ?? null, meetingDate: iso(r.new_date) } }
      : null,
  }));
}

export const countChanges = (db: Db, s0: Scope, sinceIso: string, cap?: number) => {
  const s = s0.clone();
  const since = s.p(sinceIso);
  return countItems(db, 'decision', s, () => `d.review_state = 'confirmed' AND d.status = 'superseded' AND d.updated_at >= ${since}::timestamptz`, cap);
};

export function meetingBrief(m: any) {
  return {
    id: m.id,
    title: m.title,
    scheduledStart: iso(m.scheduled_start),
    scheduledEnd: iso(m.scheduled_end),
    date: iso(m.scheduled_start ?? m.started_at ?? m.created_at),
    meetingType: m.meeting_type,
    status: m.status,
    visibility: m.visibility,
    projectId: m.project_id,
    seriesId: m.series_id,
  };
}

/** Person ids of the current user in this workspace. */
export async function myPersonIds(db: Db, workspaceId: string, userId: string): Promise<string[]> {
  return (await rows<{ id: string }>(db, 'SELECT id FROM people WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL', [workspaceId, userId])).map((r) => r.id);
}
