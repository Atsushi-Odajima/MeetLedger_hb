// Personal dashboard: Today / Upcoming / Needs Review / My Actions / My Commitments / Waiting on Others / Overdue /
// Decisions Changed (7d) / Open Questions. Every ledger query applies the meeting ACL (meetingVisibleSql on the source
// meeting = itemVisibleSql semantics); meetings use meetingVisibleSql.
//
// Bounded at spec §40 scale: each section returns the top DASH_LIMIT items + a count (capped at COUNT_CAP → "1000+").
// "Mine" lists walk the per-user indexes (021_ledger_perf_indexes); involvement-based sections (needs review, waiting on
// others, open questions) are driven by the meetings the user created/attended in the last DASH_WINDOW_DAYS days.
import type { FastifyInstance } from 'fastify';
import { dateInTz } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { rows, type Db } from '../../db/pool';
import { parse, wsParams } from '../../lib/http';
import { meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import {
  addDays,
  countByStatus,
  countChanges,
  countCommitmentsByDirection,
  countItems,
  loadActions,
  loadChanges,
  loadCommitments,
  loadQuestions,
  meetingBrief,
  meetingTimeSql,
  myPersonIds,
  newScope,
  safeTz,
  zonedTime,
  type Scope,
} from './util';

export const DASH_LIMIT = 10;
export const DASH_WINDOW_DAYS = 90;
export const COUNT_CAP = 1000;
/** Upper bound of involved meetings considered (newest first). */
const INVOLVED_MAX = 2000;

export async function buildDashboard(db: Db, ctx: WsCtx) {
  const now = ctx.deps.clock.now();
  const tz = safeTz(ctx.user.timezone);
  const today = dateInTz(now, tz);
  const dayStart = zonedTime(today, 0, tz);
  const dayEnd = zonedTime(addDays(today, 1), 0, tz);
  const weekEnd = zonedTime(addDays(today, 8), 0, tz);
  const since = new Date(now.getTime() - DASH_WINDOW_DAYS * 86400_000);
  const ws = ctx.workspaceId;
  const me = ctx.userId;
  const persons = await myPersonIds(db, ws, me);
  const N = DASH_LIMIT;

  // ---- meetings (index meetings_ws_start)
  const meetingsBetween = async (from: Date, to: Date) => {
    const where = `m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.scheduled_start >= $3 AND m.scheduled_start < $4 AND m.status <> 'archived'`;
    const list = await rows(db, `SELECT m.* FROM meetings m WHERE ${where} ORDER BY m.scheduled_start ASC, m.id LIMIT ${N * 2}`, [ws, me, from, to]);
    const cnt = list.length < N * 2 ? list.length : (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM meetings m WHERE ${where}`, [ws, me, from, to]))[0].n;
    return { items: list.map(meetingBrief), count: cnt };
  };
  const todayM = await meetingsBetween(dayStart, dayEnd);
  const upcomingM = await meetingsBetween(dayEnd, weekEnd);

  // ---- meetings I created or attended in the window (newest first, bounded)
  const involvedSql = (timeCond: string) => `
    SELECT m.id, m.status, ${meetingTimeSql('m')} AS t FROM meetings m
     WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND ${timeCond}
       AND (m.created_by = $2 OR EXISTS (SELECT 1 FROM participants ip WHERE ip.meeting_id = m.id AND (ip.user_id = $2 OR ip.person_id = ANY($5::uuid[]))))`;
  const involved = await rows<{ id: string; status: string; t: Date }>(
    db,
    `SELECT * FROM (${involvedSql('m.scheduled_start >= $3 AND m.scheduled_start <= $4')}
                    UNION ALL ${involvedSql('m.scheduled_start IS NULL AND m.created_at >= $3 AND m.created_at <= $4')}) x
      ORDER BY t DESC LIMIT ${INVOLVED_MAX}`,
    [ws, me, since, now, persons],
  );
  const involvedIds = involved.map((m) => m.id);

  // ---- needs review: candidate counts per involved meeting (4 grouped index lookups)
  const cand = new Map<string, number>();
  if (involvedIds.length) {
    for (const [table, cond] of [
      ['decisions', "review_state = 'candidate'"],
      ['actions', "status = 'candidate'"],
      ['commitments', "status = 'candidate'"],
      ['open_questions', "status = 'candidate'"],
    ] as const) {
      for (const r of await rows<{ meeting_id: string; n: number }>(
        db,
        `SELECT meeting_id, count(*)::int AS n FROM ${table} WHERE meeting_id = ANY($1::uuid[]) AND ${cond} GROUP BY meeting_id`,
        [involvedIds],
      ))
        cand.set(r.meeting_id, (cand.get(r.meeting_id) ?? 0) + r.n);
    }
  }
  const reviewIds = involved.filter((m) => m.status === 'needs_review' || (cand.get(m.id) ?? 0) > 0).map((m) => m.id);
  const reviewRows = reviewIds.length
    ? await rows(db, `SELECT m.* FROM meetings m WHERE m.id = ANY($1::uuid[]) ORDER BY ${meetingTimeSql('m')} DESC, m.id LIMIT ${N}`, [reviewIds.slice(0, N * 2)])
    : [];
  const needsReview = reviewRows.map((m) => ({ ...meetingBrief(m), candidates: cand.get(m.id) ?? 0 }));

  // ---- mine (per-user indexes; overdue split out so the lists stay actionable)
  const mine = (userCol: string, personCol: string) => (s: Scope) =>
    persons.length ? `({a}.${userCol} = $2 OR {a}.${personCol} = ANY(${s.p(persons)}::uuid[]))` : `{a}.${userCol} = $2`;
  const mineAction = mine('assignee_user_id', 'assignee_person_id');
  const mineCommit = mine('promised_by_user_id', 'promised_by_person_id');
  const scoped = (pred: (s: Scope) => string, due: 'open' | 'overdue') => {
    const s = newScope(ws, me);
    s.ands.push(pred(s));
    const t = s.p(today);
    s.ands.push(due === 'overdue' ? `{a}.due_date < ${t}::date` : `({a}.due_date >= ${t}::date OR {a}.due_date IS NULL)`);
    return s;
  };
  const OPEN = ['confirmed', 'in_progress'];
  const sMyA = scoped(mineAction, 'open');
  const sOverA = scoped(mineAction, 'overdue');
  const sMyC = scoped(mineCommit, 'open');
  const sOverC = scoped(mineCommit, 'overdue');
  const myActions = await loadActions(db, sMyA, { statuses: OPEN, today, limit: N, order: 'due_asc', indexOrder: true });
  const overdueActions = await loadActions(db, sOverA, { statuses: OPEN, today, limit: N, order: 'due_desc', indexOrder: true });
  const myCommitments = await loadCommitments(db, sMyC, { statuses: ['open'], today, limit: N, order: 'due_asc', indexOrder: true });
  const overdueCommitments = await loadCommitments(db, sOverC, { statuses: ['open'], today, limit: N, order: 'due_desc', indexOrder: true });
  const cnt = async (shown: number, count: () => Promise<number>) => (shown < N ? shown : count());

  // ---- waiting on others: items of my recent meetings owed by others
  const waitScope = () => {
    const s = newScope(ws, me);
    s.ands.push(`{a}.meeting_id = ANY(${s.p(involvedIds)}::uuid[])`);
    return s;
  };
  const sWaitC = waitScope();
  const sWaitA = waitScope();
  sWaitA.ands.push(
    `NOT coalesce(${mineAction(sWaitA)}, false)`,
    `({a}.assignee_user_id IS NOT NULL OR {a}.assignee_person_id IS NOT NULL OR {a}.assignee_text IS NOT NULL)`,
  );
  const waitingCommitments = involvedIds.length ? await loadCommitments(db, sWaitC, { statuses: ['open'], today, limit: N, direction: 'theirs' }) : [];
  const waitingActions = involvedIds.length ? await loadActions(db, sWaitA, { statuses: OPEN, today, limit: N }) : [];

  // ---- decisions changed (7d, workspace-wide; index decisions_superseded_recent)
  const sAll = newScope(ws, me);
  const since7 = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const decisionsChanged = await loadChanges(db, sAll, { sinceIso: since7, limit: N, indexOrder: true });

  // ---- open questions: of my recent meetings, or owned by me
  const sQ = newScope(ws, me);
  if (involvedIds.length) sQ.ors.push(`{a}.meeting_id = ANY(${sQ.p(involvedIds)}::uuid[])`);
  if (persons.length) sQ.ors.push(`{a}.owner_person_id = ANY(${sQ.p(persons)}::uuid[])`);
  const openQuestions = sQ.ors.length ? await loadQuestions(db, sQ, { statuses: ['open'], limit: N }) : [];

  const counts = {
    today: todayM.count,
    upcoming: upcomingM.count,
    needsReview: reviewIds.length,
    myActions: await cnt(myActions.length, () => countByStatus(db, 'action', sMyA, OPEN, COUNT_CAP)),
    myCommitments: await cnt(myCommitments.length, () => countByStatus(db, 'commitment', sMyC, ['open'], COUNT_CAP)),
    overdueActions: await cnt(overdueActions.length, () => countByStatus(db, 'action', sOverA, OPEN, COUNT_CAP)),
    overdueCommitments: await cnt(overdueCommitments.length, () => countByStatus(db, 'commitment', sOverC, ['open'], COUNT_CAP)),
    waitingCommitments: await cnt(waitingCommitments.length, async () => (await countCommitmentsByDirection(db, sWaitC, ['open'])).theirs),
    waitingActions: await cnt(waitingActions.length, () => countByStatus(db, 'action', sWaitA, OPEN, COUNT_CAP)),
    decisionsChanged: await cnt(decisionsChanged.length, () => countChanges(db, sAll, since7, COUNT_CAP)),
    openQuestions: await cnt(openQuestions.length, () => countItems(db, 'question', sQ, (a) => `${a}.status = 'open'`, COUNT_CAP)),
  };

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    today: todayM.items.slice(0, N * 2),
    upcoming: upcomingM.items.slice(0, N),
    needsReview,
    myActions,
    myCommitments,
    waitingOnOthers: { commitments: waitingCommitments, actions: waitingActions },
    overdue: { actions: overdueActions, commitments: overdueCommitments },
    decisionsChanged,
    openQuestions,
    counts: {
      ...counts,
      waitingOnOthers: counts.waitingCommitments + counts.waitingActions,
      overdue: counts.overdueActions + counts.overdueCommitments,
    },
    /** A count equal to countCap means "countCap or more". */
    countCap: COUNT_CAP,
    limit: N,
    windowDays: DASH_WINDOW_DAYS,
  };
}

export default async function dashboardRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/dashboard', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx((db) => buildDashboard(db, ctx));
  });
}
