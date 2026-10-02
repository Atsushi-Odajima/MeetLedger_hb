// Meeting Memory: person timeline, project / series / topic memory, next meeting in a series.
// Facts only (ledger rows, meetings, human notes). No AI-generated characterization of people.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateInTz, tokenSet } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { body, iso, parse, query, wsIdParams, wsParams, zIso } from '../../lib/http';
import { meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { createMeeting, meetingDetail } from '../core/meetings';
import { suggestAgenda } from './agenda';
import {
  loadActions,
  loadChanges,
  loadCommitments,
  loadDecisions,
  loadQuestions,
  meetingBrief,
  meetingTimeSql,
  newScope,
  safeTz,
  type Scope,
} from './util';

const LIMIT = 50;

/** The five memory sections for a scope (per-table scopes may differ, e.g. topic search). */
export async function memorySections(
  db: Db,
  ctx: WsCtx,
  scopes: { decision: Scope; action: Scope; commitment: Scope; question: Scope },
  opts: { filter?: (text: string) => boolean } = {},
) {
  const now = ctx.deps.clock.now();
  const today = dateInTz(now, safeTz(ctx.user.timezone));
  const f = opts.filter ?? (() => true);
  const currentDecisions = (await loadDecisions(db, scopes.decision, { view: 'current', limit: LIMIT * 2 })).filter((d) => f(`${d.text} ${d.topic ?? ''}`)).slice(0, LIMIT);
  const outstandingCommitments = (await loadCommitments(db, scopes.commitment, { statuses: ['open'], today, limit: LIMIT * 2 })).filter((c) => f(c.description)).slice(0, LIMIT);
  const openActions = (await loadActions(db, scopes.action, { statuses: ['confirmed', 'in_progress'], today, limit: LIMIT * 2 })).filter((a) => f(a.description)).slice(0, LIMIT);
  const openQuestions = (await loadQuestions(db, scopes.question, { statuses: ['open'], limit: LIMIT * 2 })).filter((q) => f(q.question)).slice(0, LIMIT);
  const since = new Date(now.getTime() - 90 * 86400_000).toISOString();
  const recentChanges = (await loadChanges(db, scopes.decision, { sinceIso: since, limit: 40 }))
    .filter((c) => f(c.previous.text) || (c.current ? f(c.current.text) : false))
    .slice(0, 20);
  return { currentDecisions, outstandingCommitments, openActions, openQuestions, recentChanges };
}

const same = (s: Scope) => ({ decision: s, action: s, commitment: s, question: s });

async function meetingsWhere(db: Db, ctx: WsCtx, col: 'project_id' | 'series_id', id: string) {
  const now = ctx.deps.clock.now();
  const past = await rows(
    db,
    `SELECT m.* FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.${col} = $3 AND ${meetingTimeSql('m')} <= $4
      ORDER BY ${meetingTimeSql('m')} DESC LIMIT 10`,
    [ctx.workspaceId, ctx.userId, id, now],
  );
  const upcoming = await rows(
    db,
    `SELECT m.* FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.${col} = $3 AND ${meetingTimeSql('m')} > $4
      ORDER BY ${meetingTimeSql('m')} ASC LIMIT 5`,
    [ctx.workspaceId, ctx.userId, id, now],
  );
  return { recentMeetings: past.map(meetingBrief), upcomingMeetings: upcoming.map(meetingBrief) };
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

export default async function memoryRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------------ person timeline (facts only)
  app.get('/api/w/:workspaceId/people/:id/timeline', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), order: z.enum(['asc', 'desc']).default('desc') }));
    return ctx.tx(async (db) => {
      const person = await one<any>(db, 'SELECT * FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [id, workspaceId]);
      if (!person) throw notFound('Person not found');
      const today = dateInTz(deps.clock.now(), safeTz(ctx.user.timezone));
      const events: { type: string; at: string | null; [k: string]: unknown }[] = [];

      const meetings = await rows(
        db,
        `SELECT m.*, pa.role AS participant_role FROM participants pa JOIN meetings m ON m.id = pa.meeting_id
          WHERE pa.person_id = $3 AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}`,
        [workspaceId, ctx.userId, id],
      );
      for (const m of meetings) events.push({ type: 'meeting', at: iso(m.scheduled_start ?? m.started_at ?? m.created_at), meeting: meetingBrief(m), role: m.participant_role });

      const s = newScope(workspaceId, ctx.userId);
      const pid = s.p(id);
      const sd = s.clone();
      sd.ands.push(`({a}.owner_person_id = ${pid}::uuid OR ${pid}::uuid = ANY({a}.participant_person_ids))`);
      for (const d of await loadDecisions(db, sd, { view: 'confirmed_all', limit: 300 }))
        events.push({ type: 'decision', at: d.decidedAt ?? d.source.meetingDate ?? d.confirmedAt, id: d.id, text: d.text, status: d.status, source: d.source });

      const sa = s.clone();
      sa.ands.push(`{a}.assignee_person_id = ${pid}::uuid`);
      for (const a of await loadActions(db, sa, { statuses: ['confirmed', 'in_progress', 'done', 'cancelled'], today, limit: 300 }))
        events.push({ type: 'action', at: a.source.meetingDate ?? a.confirmedAt, id: a.id, description: a.description, status: a.status, dueDate: a.dueDate, overdue: a.overdue, source: a.source });

      const sc = s.clone();
      sc.ands.push(`({a}.promised_by_person_id = ${pid}::uuid OR {a}.promised_to_person_id = ${pid}::uuid)`);
      for (const c of await loadCommitments(db, sc, { statuses: ['open', 'done', 'cancelled'], today, limit: 300 }))
        events.push({
          type: 'commitment',
          at: c.source.meetingDate,
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

      const followups = await rows(
        db,
        `SELECT f.id, f.kind, f.status, f.subject, f.approved_at, f.sent_at, f.created_at, m.id AS meeting_id, m.title AS meeting_title, ${meetingTimeSql('m')} AS meeting_date
           FROM followup_drafts f JOIN meetings m ON m.id = f.meeting_id
          WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND f.status IN ('approved', 'sent')
            AND EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = m.id AND pa.person_id = $3)`,
        [workspaceId, ctx.userId, id],
      );
      for (const f of followups)
        events.push({
          type: 'followup',
          at: iso(f.sent_at ?? f.approved_at ?? f.created_at),
          id: f.id,
          kind: f.kind,
          status: f.status,
          subject: f.subject,
          source: { meetingId: f.meeting_id, meetingTitle: f.meeting_title, meetingDate: iso(f.meeting_date) },
        });

      const notes = await rows(
        db,
        `SELECT n.id, n.body, n.created_at, u.name AS author FROM person_notes n LEFT JOIN users u ON u.id = n.author_user_id
          WHERE n.person_id = $1 AND n.workspace_id = $2`,
        [id, workspaceId],
      );
      for (const n of notes) events.push({ type: 'note', at: iso(n.created_at), id: n.id, body: n.body, author: n.author ?? null, authoredBy: 'human' });

      const dir = q.order === 'asc' ? 1 : -1;
      events.sort((x, y) => {
        if (!x.at && !y.at) return 0;
        if (!x.at) return 1;
        if (!y.at) return -1;
        return dir * (Date.parse(x.at) - Date.parse(y.at));
      });
      return {
        person: { id: person.id, name: person.name, organization: person.organization, roleTitle: person.role_title, email: person.email, tags: person.tags ?? [] },
        factsOnly: true,
        stats: {
          meetings: meetings.length,
          openActions: events.filter((e) => e.type === 'action' && ['confirmed', 'in_progress'].includes(e.status as string)).length,
          openCommitmentsBy: events.filter((e) => e.type === 'commitment' && e.status === 'open' && e.role === 'promised_by').length,
          openCommitmentsTo: events.filter((e) => e.type === 'commitment' && e.status === 'open' && e.role === 'promised_to').length,
        },
        events: events.slice(0, q.limit),
        truncated: events.length > q.limit,
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
      const s = newScope(workspaceId, ctx.userId);
      const pp = s.p(id);
      s.ors.push(`{a}.project_id = ${pp}::uuid`, `{a}.meeting_id IN (SELECT pm.id FROM meetings pm WHERE pm.workspace_id = $1 AND pm.project_id = ${pp}::uuid)`);
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
      const s = newScope(workspaceId, ctx.userId);
      const sp = s.p(id);
      s.ors.push(`{a}.series_id = ${sp}::uuid`, `{a}.meeting_id IN (SELECT sm2.id FROM meetings sm2 WHERE sm2.workspace_id = $1 AND sm2.series_id = ${sp}::uuid)`);
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

  // ------------------------------------------------------------------ topic memory (?topic= token match)
  app.get('/api/w/:workspaceId/memory', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ topic: z.string().trim().min(1).max(100), projectId: z.string().uuid().optional() }));
    const topic = q.topic.normalize('NFKC');
    const terms = topic.split(/[\s　]+/).filter(Boolean).slice(0, 8);
    const like = terms.map((t) => `%${t.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    const match = topicMatcher(topic);
    return ctx.tx(async (db) => {
      const base = newScope(workspaceId, ctx.userId);
      if (q.projectId) base.ands.push(`{a}.project_id = ${base.p(q.projectId)}::uuid`);
      const mk = (cols: string[], extra?: string) => {
        const s = base.clone();
        const lp = s.p(like);
        s.ors.push(...cols.map((c) => `{a}.${c} ILIKE ANY(${lp}::text[])`));
        if (extra) s.ors.push(extra.replace('?', s.p(topic.toLowerCase())));
        return s;
      };
      const sections = await memorySections(
        db,
        ctx,
        { decision: mk(['text', 'topic'], 'lower({a}.topic_key) = ?'), action: mk(['description']), commitment: mk(['description']), question: mk(['question']) },
        { filter: match },
      );
      const ms = await rows(
        db,
        `SELECT m.* FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND m.title ILIKE ANY($3::text[])
          ORDER BY ${meetingTimeSql('m')} DESC LIMIT 50`,
        [workspaceId, ctx.userId, like],
      );
      return { topic: q.topic, ...sections, meetings: ms.filter((m) => match(m.title)).slice(0, 20).map(meetingBrief) };
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
