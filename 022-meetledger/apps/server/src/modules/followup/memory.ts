// Meeting Memory: person timeline, project / series / topic memory, next meeting in a series.
// Facts only (ledger rows, meetings, human notes). No AI-generated characterization of people.
// Every list is bounded (section limits + exact counts; the timeline is keyset-paginated).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateInTz, tokenSet } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';
import { body, iso, parse, query, wsIdParams, wsParams, zIso } from '../../lib/http';
import { meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { createMeeting, meetingDetail } from '../core/meetings';
import { suggestAgenda } from './agenda';
import { topicKeyOf } from '../ledger/common';
import {
  RECENT_SQL,
  countByStatus,
  countChanges,
  countCurrentDecisions,
  loadActions,
  loadChanges,
  loadCommitments,
  loadDecisions,
  loadQuestions,
  meetingBrief,
  meetingTimeSql,
  newScope,
  safeTz,
  type RecentOrder,
  type Scope,
} from './util';

/** Items shown per memory section (totals in `counts`; full lists via the ledger list endpoints). */
export const MEMORY_LIMIT = 20;
/** Topic memory scans at most this many most-recent items per ledger table (plus exact topic_key matches of any age). */
export const TOPIC_SCAN = 20_000;

type SectionScopes = { decision: Scope; action: Scope; commitment: Scope; question: Scope };
const same = (s: Scope): SectionScopes => ({ decision: s, action: s, commitment: s, question: s });

/** The five memory sections for a scope: top MEMORY_LIMIT of each + exact totals. */
export async function memorySections(db: Db, ctx: WsCtx, sc: SectionScopes, opts: { changesDays?: number } = {}) {
  const now = ctx.deps.clock.now();
  const today = dateInTz(now, safeTz(ctx.user.timezone));
  const n = MEMORY_LIMIT;
  const since = new Date(now.getTime() - (opts.changesDays ?? 90) * 86400_000).toISOString();
  const currentDecisions = await loadDecisions(db, sc.decision, { view: 'current', limit: n });
  const outstandingCommitments = await loadCommitments(db, sc.commitment, { statuses: ['open'], today, limit: n });
  const openActions = await loadActions(db, sc.action, { statuses: ['confirmed', 'in_progress'], today, limit: n });
  const openQuestions = await loadQuestions(db, sc.question, { statuses: ['open'], limit: n });
  const recentChanges = await loadChanges(db, sc.decision, { sinceIso: since, limit: n });
  const total = async (shown: number, count: () => Promise<number>) => (shown < n ? shown : count());
  const counts = {
    currentDecisions: await total(currentDecisions.length, () => countCurrentDecisions(db, sc.decision)),
    outstandingCommitments: await total(outstandingCommitments.length, () => countByStatus(db, 'commitment', sc.commitment, ['open'])),
    openActions: await total(openActions.length, () => countByStatus(db, 'action', sc.action, ['confirmed', 'in_progress'])),
    openQuestions: await total(openQuestions.length, () => countByStatus(db, 'question', sc.question, ['open'])),
    recentChanges: await total(recentChanges.length, () => countChanges(db, sc.decision, since)),
  };
  const more = {
    currentDecisions: counts.currentDecisions > currentDecisions.length,
    outstandingCommitments: counts.outstandingCommitments > outstandingCommitments.length,
    openActions: counts.openActions > openActions.length,
    openQuestions: counts.openQuestions > openQuestions.length,
    recentChanges: counts.recentChanges > recentChanges.length,
  };
  return { currentDecisions, outstandingCommitments, openActions, openQuestions, recentChanges, counts, more, limit: n };
}

async function meetingsWhere(db: Db, ctx: WsCtx, col: 'project_id' | 'series_id', id: string) {
  const now = ctx.deps.clock.now();
  const q = (cmp: string, dir: string, limit: number) =>
    rows(
      db,
      `SELECT m.* FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.${col} = $3 AND ${meetingTimeSql('m')} ${cmp} $4
        ORDER BY ${meetingTimeSql('m')} ${dir} LIMIT ${limit}`,
      [ctx.workspaceId, ctx.userId, id, now],
    );
  const past = await q('<=', 'DESC', 10);
  const upcoming = await q('>', 'ASC', 5);
  const cnt = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.${col} = $3`,
    [ctx.workspaceId, ctx.userId, id],
  );
  return { recentMeetings: past.map(meetingBrief), upcomingMeetings: upcoming.map(meetingBrief), meetingCount: cnt?.n ?? 0 };
}

/** Visible meeting ids of a project / series (items are matched by their own project/series id OR by their meeting). */
async function visibleMeetingIds(db: Db, ctx: WsCtx, col: 'project_id' | 'series_id', id: string): Promise<string[]> {
  return (
    await rows<{ id: string }>(db, `SELECT m.id FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.${col} = $3`, [
      ctx.workspaceId,
      ctx.userId,
      id,
    ])
  ).map((r) => r.id);
}

function groupScope(ctx: WsCtx, col: 'project_id' | 'series_id', id: string, meetingIds: string[]): Scope {
  const s = newScope(ctx.workspaceId, ctx.userId);
  s.ors.push(`{a}.${col} = ${s.p(id)}::uuid`);
  if (meetingIds.length) s.ors.push(`{a}.meeting_id = ANY(${s.p(meetingIds)}::uuid[])`);
  return s;
}

/** Lowercased NFKC token containment (all query tokens must occur in the text). */
export function topicMatcher(topic: string): (text: string) => boolean {
  const q = tokenSet(topic);
  return (text: string) => {
    if (!q.size) return false;
    const t = tokenSet(text);
    for (const x of q) if (!t.has(x)) return false;
    return true;
  };
}

// ---------------------------------------------------------------------------------------------- person timeline cursor
type EvType = 'action' | 'commitment' | 'decision' | 'followup' | 'meeting' | 'note';
interface Cursor {
  at: string;
  type: EvType;
  id: string;
}
const EV_TYPES: EvType[] = ['action', 'commitment', 'decision', 'followup', 'meeting', 'note'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const [at, type, id] = raw.split('|');
  if (!at || Number.isNaN(Date.parse(at)) || !EV_TYPES.includes(type as EvType) || !UUID_RE.test(id ?? '')) throw badRequest('Invalid cursor');
  return { at: new Date(at).toISOString(), type: type as EvType, id: id.toLowerCase() };
}
const encodeCursor = (e: { at: string; type: string; id: string }) => `${e.at}|${e.type}|${e.id}`;

/**
 * Keyset predicate on the tuple (at, type, id) — the order the merged timeline uses. `type` is a constant per query,
 * so the tuple comparison reduces to at/id comparisons (all leakproof).
 */
function afterCursor(c: Cursor | null, type: EvType, atSql: string, idSql: string, dir: 'desc' | 'asc', p: (v: unknown) => string): string {
  if (!c) return 'TRUE';
  const op = dir === 'desc' ? '<' : '>';
  const at = `${p(c.at)}::timestamptz`;
  if (type === c.type) return `(${atSql} ${op} ${at} OR (${atSql} = ${at} AND ${idSql} ${op} ${p(c.id)}::uuid))`;
  const typeBefore = dir === 'desc' ? type < c.type : type > c.type;
  return typeBefore ? `${atSql} ${op}= ${at}` : `${atSql} ${op} ${at}`;
}

const msTrunc = (x: string) => `date_trunc('milliseconds', ${x})`;

/** Candidate ids for topic memory: bounded scans of the newest TOPIC_SCAN rows per table + exact topic_key matches. */
async function topicCandidates(db: Db, ctx: WsCtx, topic: string) {
  const terms = topic.split(/[\s　]+/).filter(Boolean).slice(0, 8);
  const like = terms.map((t) => `%${t.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
  const key = topicKeyOf(topic);
  const match = topicMatcher(topic);
  let truncated = false;
  const scan = async (sql: string, extra: unknown[] = []) => {
    const list = await rows<{ id: string; t: string; n: number }>(db, sql, [ctx.workspaceId, like, ...extra]);
    if (list.some((r) => r.n >= TOPIC_SCAN)) truncated = true;
    return list.filter((r) => match(r.t ?? '')).map((r) => r.id);
  };
  // `n` = rows examined by the window (to report truncation); ILIKE / token matching only on the bounded window.
  const windowed = (inner: string, textExpr: string) => `
    SELECT z.id, z.t, z.n FROM (SELECT r.id, ${textExpr} AS t, (count(*) OVER ())::int AS n FROM (${inner}) r) z
     WHERE z.t ILIKE ANY($2::text[])`;
  const decInner = (cond: string, order: string) =>
    `SELECT x.id, x.text, x.topic FROM decisions x WHERE x.workspace_id = $1 AND x.review_state = 'confirmed' AND ${cond} ORDER BY ${order} LIMIT ${TOPIC_SCAN}`;
  const decisions = [
    ...(await scan(windowed(decInner(`x.status = 'active'`, 'x.created_at DESC'), `concat_ws(' ', r.text, r.topic)`))),
    ...(await scan(windowed(decInner(`x.status = 'superseded'`, 'x.updated_at DESC'), `concat_ws(' ', r.text, r.topic)`))),
    ...(key
      ? (
          await rows<{ id: string }>(
            db,
            `SELECT x.id FROM decisions x WHERE x.workspace_id = $1 AND x.topic_key = $2 AND x.review_state = 'confirmed' ORDER BY x.created_at DESC LIMIT 2000`,
            [ctx.workspaceId, key],
          )
        ).map((r) => r.id)
      : []),
  ];
  const actions = await scan(
    windowed(
      `SELECT x.id, x.description FROM actions x WHERE x.workspace_id = $1 AND x.status IN ('confirmed', 'in_progress') ORDER BY x.due_date DESC, x.id DESC LIMIT ${TOPIC_SCAN}`,
      'r.description',
    ),
  );
  const commitments = await scan(
    windowed(`SELECT x.id, x.description FROM commitments x WHERE x.workspace_id = $1 AND x.status = 'open' ORDER BY x.due_date DESC, x.id DESC LIMIT ${TOPIC_SCAN}`, 'r.description'),
  );
  const questions = await scan(
    windowed(`SELECT x.id, x.question FROM open_questions x WHERE x.workspace_id = $1 AND x.status = 'open' ORDER BY x.created_at DESC, x.id DESC LIMIT ${TOPIC_SCAN}`, 'r.question'),
  );
  const meetingRows = await rows<any>(
    db,
    `SELECT m.* FROM (SELECT x.* FROM meetings x WHERE x.workspace_id = $1 ORDER BY x.scheduled_start DESC LIMIT ${TOPIC_SCAN}) m
      WHERE ${meetingVisibleSql('m', '$3')} AND m.title ILIKE ANY($2::text[]) ORDER BY ${meetingTimeSql('m')} DESC LIMIT 200`,
    [ctx.workspaceId, like, ctx.userId],
  );
  const cap = (ids: string[]) => [...new Set(ids)].slice(0, 5000);
  return {
    ids: { decision: cap(decisions), action: cap(actions), commitment: cap(commitments), question: cap(questions) },
    meetings: meetingRows.filter((m) => match(m.title)).slice(0, MEMORY_LIMIT),
    truncated,
  };
}

export default async function memoryRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------------ person timeline (facts only, keyset-paginated)
  app.get('/api/w/:workspaceId/people/:id/timeline', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(
      req,
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), order: z.enum(['asc', 'desc']).default('desc'), cursor: z.string().max(200).optional() }),
    );
    const cur = parseCursor(q.cursor);
    const dir = q.order;
    const DIR = dir === 'asc' ? 'ASC' : 'DESC';
    const per = q.limit + 1;
    const order: RecentOrder = dir === 'asc' ? 'recent_asc' : 'recent';
    return ctx.tx(async (db) => {
      const person = await one<any>(db, 'SELECT * FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [id, workspaceId]);
      if (!person) throw notFound('Person not found');
      const today = dateInTz(deps.clock.now(), safeTz(ctx.user.timezone));
      const events: { type: EvType; at: string; id: string; [k: string]: unknown }[] = [];

      // meetings of this person (visible)
      const pmIds = (
        await rows<{ id: string }>(
          db,
          `SELECT m.id FROM participants pa JOIN meetings m ON m.id = pa.meeting_id WHERE pa.person_id = $3 AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}`,
          [workspaceId, ctx.userId, id],
        )
      ).map((r) => r.id);
      const mp: unknown[] = [workspaceId, ctx.userId, id];
      const mpush = (v: unknown) => {
        mp.push(v);
        return `$${mp.length}`;
      };
      const mAt = msTrunc(meetingTimeSql('m'));
      const meetings = await rows(
        db,
        `SELECT m.*, pa.role AS participant_role, ${mAt} AS at FROM participants pa JOIN meetings m ON m.id = pa.meeting_id
          WHERE pa.person_id = $3 AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND ${afterCursor(cur, 'meeting', mAt, 'm.id', dir, mpush)}
          ORDER BY ${mAt} ${DIR}, m.id ${DIR} LIMIT ${per}`,
        mp,
      );
      for (const m of meetings) events.push({ type: 'meeting', at: iso(m.at)!, id: m.id, meeting: meetingBrief(m), role: m.participant_role });

      const s = newScope(workspaceId, ctx.userId);
      const pid = s.p(id);
      const sd = s.clone();
      // owner, or a participant of a decision made in a meeting this person attended (array test only as post-filter)
      sd.ands.push(`({a}.owner_person_id = ${pid}::uuid OR ({a}.meeting_id = ANY(${sd.p(pmIds)}::uuid[]) AND {a}.participant_person_ids @> ARRAY[${pid}::uuid]))`);
      sd.ands.push(afterCursor(cur, 'decision', RECENT_SQL.decision, 'd.id', dir, (v) => sd.p(v)));
      for (const d of await loadDecisions(db, sd, { view: 'confirmed_all', limit: per, order }))
        events.push({ type: 'decision', at: d.at!, id: d.id, text: d.text, status: d.status, source: d.source });

      const sa = s.clone();
      sa.ands.push(`{a}.assignee_person_id = ${pid}::uuid`);
      const saPage = sa.clone();
      saPage.ands.push(afterCursor(cur, 'action', RECENT_SQL.action, 'a.id', dir, (v) => saPage.p(v)));
      for (const a of await loadActions(db, saPage, { statuses: ['confirmed', 'in_progress', 'done', 'cancelled'], today, limit: per, order }))
        events.push({ type: 'action', at: a.at!, id: a.id, description: a.description, status: a.status, dueDate: a.dueDate, overdue: a.overdue, source: a.source });

      const scBy = s.clone();
      scBy.ands.push(`{a}.promised_by_person_id = ${pid}::uuid`);
      const scTo = s.clone();
      scTo.ands.push(`{a}.promised_to_person_id = ${pid}::uuid`);
      const sc = s.clone();
      sc.ors.push(`{a}.promised_by_person_id = ${pid}::uuid`, `{a}.promised_to_person_id = ${pid}::uuid`);
      sc.ands.push(afterCursor(cur, 'commitment', RECENT_SQL.commitment, 'c.id', dir, (v) => sc.p(v)));
      for (const c of await loadCommitments(db, sc, { statuses: ['open', 'done', 'cancelled'], today, limit: per, order }))
        events.push({
          type: 'commitment',
          at: c.at!,
          id: c.id,
          description: c.description,
          role: c.promisedByPersonId === id ? 'promised_by' : 'promised_to',
          promisedByName: c.promisedByName,
          promisedToName: c.promisedToName,
          status: c.status,
          dueDate: c.dueDate,
          overdue: c.overdue,
          source: c.source,
        });

      const fp: unknown[] = [workspaceId, ctx.userId, pmIds];
      const fAt = msTrunc('coalesce(f.sent_at, f.approved_at, f.created_at)');
      const followups = pmIds.length
        ? await rows(
            db,
            `SELECT f.id, f.kind, f.status, f.subject, ${fAt} AS at, m.id AS meeting_id, m.title AS meeting_title, ${meetingTimeSql('m')} AS meeting_date
               FROM followup_drafts f JOIN meetings m ON m.id = f.meeting_id
              WHERE f.meeting_id = ANY($3::uuid[]) AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND f.status IN ('approved', 'sent')
                AND ${afterCursor(cur, 'followup', fAt, 'f.id', dir, (v) => (fp.push(v), `$${fp.length}`))}
              ORDER BY ${fAt} ${DIR}, f.id ${DIR} LIMIT ${per}`,
            fp,
          )
        : [];
      for (const f of followups)
        events.push({
          type: 'followup',
          at: iso(f.at)!,
          id: f.id,
          kind: f.kind,
          status: f.status,
          subject: f.subject,
          source: { meetingId: f.meeting_id, meetingTitle: f.meeting_title, meetingDate: iso(f.meeting_date) },
        });

      const np: unknown[] = [id, workspaceId];
      const nAt = msTrunc('n.created_at');
      const notes = await rows(
        db,
        `SELECT n.id, n.body, ${nAt} AS at, u.name AS author FROM person_notes n LEFT JOIN users u ON u.id = n.author_user_id
          WHERE n.person_id = $1 AND n.workspace_id = $2 AND ${afterCursor(cur, 'note', nAt, 'n.id', dir, (v) => (np.push(v), `$${np.length}`))}
          ORDER BY ${nAt} ${DIR}, n.id ${DIR} LIMIT ${per}`,
        np,
      );
      for (const n of notes) events.push({ type: 'note', at: iso(n.at)!, id: n.id, body: n.body, author: n.author ?? null, authoredBy: 'human' });

      // merge: (at, type, id) in the requested direction — identical to the per-query keyset order
      const sign = dir === 'asc' ? 1 : -1;
      const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
      events.sort((x, y) => sign * (cmp(x.at, y.at) || cmp(x.type, y.type) || cmp(x.id, y.id)));
      const page = events.slice(0, q.limit);
      const last = page[page.length - 1];
      const openAct = ['confirmed', 'in_progress'];
      return {
        person: { id: person.id, name: person.name, organization: person.organization, roleTitle: person.role_title, email: person.email, tags: person.tags ?? [] },
        factsOnly: true,
        stats: {
          meetings: pmIds.length,
          openActions: await countByStatus(db, 'action', sa, openAct),
          openCommitmentsBy: await countByStatus(db, 'commitment', scBy, ['open']),
          openCommitmentsTo: await countByStatus(db, 'commitment', scTo, ['open']),
        },
        events: page,
        truncated: events.length > q.limit,
        nextCursor: events.length > q.limit && last ? encodeCursor(last) : null,
      };
    });
  });

  // ------------------------------------------------------------------ project memory
  app.get('/api/w/:workspaceId/projects/:id/memory', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const p = await one<any>(db, 'SELECT * FROM projects WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!p) throw notFound('Project not found');
      const s = groupScope(ctx, 'project_id', id, await visibleMeetingIds(db, ctx, 'project_id', id));
      return {
        project: { id: p.id, name: p.name, kind: p.kind, clientName: p.client_name, status: p.status },
        ...(await memorySections(db, ctx, same(s))),
        ...(await meetingsWhere(db, ctx, 'project_id', id)),
      };
    });
  });

  // ------------------------------------------------------------------ series memory
  app.get('/api/w/:workspaceId/series/:id/memory', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const sr = await one<any>(db, 'SELECT * FROM series WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!sr) throw notFound('Series not found');
      const s = groupScope(ctx, 'series_id', id, await visibleMeetingIds(db, ctx, 'series_id', id));
      const ms = await meetingsWhere(db, ctx, 'series_id', id);
      return {
        series: { id: sr.id, title: sr.title, cadence: sr.cadence, projectId: sr.project_id, meetingType: sr.meeting_type },
        ...(await memorySections(db, ctx, same(s))),
        ...ms,
        previousMeeting: ms.recentMeetings[0] ?? null,
        nextMeeting: ms.upcomingMeetings[0] ?? null,
      };
    });
  });

  // ------------------------------------------------------------------ topic memory (?topic= token match, bounded scan)
  app.get('/api/w/:workspaceId/memory', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ topic: z.string().trim().min(1).max(100), projectId: z.string().uuid().optional() }));
    const topic = q.topic.normalize('NFKC');
    return ctx.tx(async (db) => {
      const cand = await topicCandidates(db, ctx, topic);
      const scopeFor = (ids: string[]) => {
        const s = newScope(workspaceId, ctx.userId);
        s.ands.push(`{a}.id = ANY(${s.p(ids)}::uuid[])`);
        if (q.projectId) s.ands.push(`{a}.project_id = ${s.p(q.projectId)}::uuid`);
        return s;
      };
      const sections = await memorySections(db, ctx, {
        decision: scopeFor(cand.ids.decision),
        action: scopeFor(cand.ids.action),
        commitment: scopeFor(cand.ids.commitment),
        question: scopeFor(cand.ids.question),
      });
      return {
        topic: q.topic,
        ...sections,
        meetings: (q.projectId ? cand.meetings.filter((m: any) => m.project_id === q.projectId) : cand.meetings).map(meetingBrief),
        scan: { recentItemsPerType: TOPIC_SCAN, truncated: cand.truncated },
      };
    });
  });

  // ------------------------------------------------------------------ next meeting in a series (carries open items into brief/agenda)
  app.post('/api/w/:workspaceId/series/:id/meetings', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        scheduledStart: zIso,
        scheduledEnd: zIso.nullable().optional(),
        title: z.string().trim().min(1).max(300).optional(),
        copyParticipants: z.boolean().default(true),
      }),
    );
    return ctx.tx(async (db) => {
      const sr = await one<any>(db, 'SELECT * FROM series WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!sr) throw notFound('Series not found');
      const prev = await one<any>(
        db,
        `SELECT m.* FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.series_id = $3
          ORDER BY ${meetingTimeSql('m')} DESC LIMIT 1`,
        [workspaceId, ctx.userId, id],
      );
      const participants =
        prev && b.copyParticipants
          ? (await rows(db, 'SELECT person_id, role FROM participants WHERE meeting_id=$1 AND person_id IS NOT NULL ORDER BY created_at', [prev.id])).map((p) => ({
              personId: p.person_id as string,
              role: p.role as 'organizer' | 'attendee' | 'optional',
            }))
          : [];
      const accessUserIds =
        prev && prev.visibility === 'selected' ? (await rows<{ user_id: string }>(db, 'SELECT user_id FROM meeting_access WHERE meeting_id=$1', [prev.id])).map((r) => r.user_id) : [];
      const input: Parameters<typeof createMeeting>[2] = {
        title: b.title ?? sr.title,
        scheduledStart: b.scheduledStart,
        scheduledEnd: b.scheduledEnd ?? null,
        seriesId: id,
        source: 'manual',
        participants,
        accessUserIds,
        ...(prev ? { visibility: prev.visibility } : {}),
      };
      const m = await createMeeting(db, ctx, input);
      const agenda = await suggestAgenda(db, ctx, m);
      return { ...(await meetingDetail(db, ctx, m)), agendaSuggested: agenda.created };
    });
  });
}
