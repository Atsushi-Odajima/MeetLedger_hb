// Personal dashboard: Today / Upcoming / Needs Review / My Actions / My Commitments / Waiting on Others / Overdue /
// Decisions Changed (7d) / Open Questions. Everything goes through meetingVisibleSql / itemVisibleSql.
import type { FastifyInstance } from 'fastify';
import { dateInTz } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { rows, type Db } from '../../db/pool';
import { parse, wsParams } from '../../lib/http';
import { meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { addDays, loadActions, loadChanges, loadCommitments, loadQuestions, meetingBrief, meetingTimeSql, newScope, safeTz, zonedTime } from './util';

const MY_PERSONS = `(SELECT mp.id FROM people mp WHERE mp.workspace_id = $1 AND mp.user_id = $2)`;
const MY_ACTION = `coalesce(({a}.assignee_user_id = $2 OR {a}.assignee_person_id IN ${MY_PERSONS}), false)`;
const MY_COMMITMENT = `coalesce(({a}.promised_by_user_id = $2 OR {a}.promised_by_person_id IN ${MY_PERSONS}), false)`;
/** The source meeting was created by me or I am a participant. */
const INVOLVED = `EXISTS (SELECT 1 FROM meetings im WHERE im.id = {a}.meeting_id AND (im.created_by = $2
  OR EXISTS (SELECT 1 FROM participants ip LEFT JOIN people ipe ON ipe.id = ip.person_id WHERE ip.meeting_id = im.id AND (ip.user_id = $2 OR ipe.user_id = $2))))`;

export async function buildDashboard(db: Db, ctx: WsCtx) {
  const now = ctx.deps.clock.now();
  const tz = safeTz(ctx.user.timezone);
  const today = dateInTz(now, tz);
  const dayStart = zonedTime(today, 0, tz);
  const dayEnd = zonedTime(addDays(today, 1), 0, tz);
  const weekEnd = zonedTime(addDays(today, 8), 0, tz);
  const ws = ctx.workspaceId;
  const me = ctx.userId;

  const meetingsBetween = (from: Date, to: Date, limit: number) =>
    rows(
      db,
      `SELECT m.* FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}
         AND m.scheduled_start >= $3 AND m.scheduled_start < $4 AND m.status <> 'archived'
       ORDER BY m.scheduled_start ASC LIMIT ${limit}`,
      [ws, me, from, to],
    );
  const todayMeetings = (await meetingsBetween(dayStart, dayEnd, 20)).map(meetingBrief);
  const upcoming = (await meetingsBetween(dayEnd, weekEnd, 10)).map(meetingBrief);

  const review = await rows(
    db,
    `SELECT m.*, c.n AS candidates FROM meetings m
       CROSS JOIN LATERAL (SELECT ((SELECT count(*) FROM decisions d WHERE d.meeting_id = m.id AND d.review_state = 'candidate')
                                 + (SELECT count(*) FROM actions a WHERE a.meeting_id = m.id AND a.status = 'candidate')
                                 + (SELECT count(*) FROM commitments x WHERE x.meeting_id = m.id AND x.status = 'candidate')
                                 + (SELECT count(*) FROM open_questions q WHERE q.meeting_id = m.id AND q.status = 'candidate'))::int AS n) c
      WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}
        AND (m.created_by = $2 OR EXISTS (SELECT 1 FROM participants ip LEFT JOIN people ipe ON ipe.id = ip.person_id WHERE ip.meeting_id = m.id AND (ip.user_id = $2 OR ipe.user_id = $2)))
        AND (m.status = 'needs_review' OR c.n > 0)
      ORDER BY ${meetingTimeSql('m')} DESC LIMIT 20`,
    [ws, me],
  );
  const needsReview = review.map((m) => ({ ...meetingBrief(m), candidates: m.candidates }));

  const sMine = newScope(ws, me);
  sMine.ands.push(MY_ACTION);
  const myActions = await loadActions(db, sMine, { statuses: ['confirmed', 'in_progress'], today, limit: 50 });

  const sMyC = newScope(ws, me);
  sMyC.ands.push(MY_COMMITMENT);
  const myCommitments = await loadCommitments(db, sMyC, { statuses: ['open'], today, limit: 50 });

  const sTheirs = newScope(ws, me);
  sTheirs.ands.push(`NOT ${MY_COMMITMENT}`);
  sTheirs.ands.push(`({a}.promised_to_user_id = $2 OR {a}.promised_to_person_id IN ${MY_PERSONS} OR ${INVOLVED})`);
  const waitingCommitments = (await loadCommitments(db, sTheirs, { statuses: ['open'], today, limit: 50 })).filter((c) => c.direction === 'theirs');

  const sOthers = newScope(ws, me);
  sOthers.ands.push(`NOT ${MY_ACTION}`, `({a}.assignee_user_id IS NOT NULL OR {a}.assignee_person_id IS NOT NULL OR {a}.assignee_text IS NOT NULL)`, INVOLVED);
  const waitingActions = await loadActions(db, sOthers, { statuses: ['confirmed', 'in_progress'], today, limit: 30 });

  const sOverA = newScope(ws, me);
  sOverA.ands.push(MY_ACTION, `{a}.due_date < ${sOverA.p(today)}::date`);
  const sOverC = newScope(ws, me);
  sOverC.ands.push(MY_COMMITMENT, `{a}.due_date < ${sOverC.p(today)}::date`);
  const overdue = {
    actions: await loadActions(db, sOverA, { statuses: ['confirmed', 'in_progress'], today, limit: 100 }),
    commitments: await loadCommitments(db, sOverC, { statuses: ['open'], today, limit: 100 }),
  };

  const sAll = newScope(ws, me);
  const decisionsChanged = await loadChanges(db, sAll, { sinceIso: new Date(now.getTime() - 7 * 86400_000).toISOString(), limit: 20 });

  const sQ = newScope(ws, me);
  sQ.ands.push(`({a}.owner_person_id IN ${MY_PERSONS} OR ${INVOLVED})`);
  const openQuestions = await loadQuestions(db, sQ, { statuses: ['open'], limit: 20 });

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    today: todayMeetings,
    upcoming,
    needsReview,
    myActions,
    myCommitments,
    waitingOnOthers: { commitments: waitingCommitments, actions: waitingActions },
    overdue,
    decisionsChanged,
    openQuestions,
    counts: {
      today: todayMeetings.length,
      needsReview: needsReview.length,
      myActions: myActions.length,
      myCommitments: myCommitments.length,
      waitingOnOthers: waitingCommitments.length + waitingActions.length,
      overdue: overdue.actions.length + overdue.commitments.length,
      decisionsChanged: decisionsChanged.length,
      openQuestions: openQuestions.length,
    },
  };
}

export default async function dashboardRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/dashboard', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx((db) => buildDashboard(db, ctx));
  });
}
