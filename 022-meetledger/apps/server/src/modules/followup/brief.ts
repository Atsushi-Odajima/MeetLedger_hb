// Pre-meeting Brief: concise, facts from the ledger only (no AI text), ACL-filtered, "first meeting" ⇒ minimal.
import type { FastifyInstance } from 'fastify';
import { dateInTz } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { iso, parse, wsIdParams } from '../../lib/http';
import { loadMeeting, meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import {
  loadActions,
  loadChanges,
  loadCommitments,
  loadDecisions,
  loadQuestions,
  meetingBrief,
  meetingTimeSql,
  newScope,
  resolveTemplate,
  safeTz,
  type Scope,
} from './util';

export const BRIEF_LIMITS = { decisions: 8, actions: 10, commitments: 10, questions: 8, changes: 5, notesPerPerson: 3 };

export interface BriefParticipant {
  personId: string | null;
  name: string;
  organization: string | null;
  roleTitle: string | null;
  isMe: boolean;
  isInternal: boolean;
}

export async function loadParticipants(db: Db, meetingId: string, userId: string): Promise<BriefParticipant[]> {
  const list = await rows(
    db,
    `SELECT pa.person_id, pa.user_id, pa.display_name, pe.name, pe.organization, pe.role_title, pe.user_id AS person_user_id
       FROM participants pa LEFT JOIN people pe ON pe.id = pa.person_id AND pe.deleted_at IS NULL
      WHERE pa.meeting_id = $1 ORDER BY pa.role, pa.display_name`,
    [meetingId],
  );
  return list.map((p) => ({
    personId: p.person_id,
    name: p.name ?? p.display_name,
    organization: p.organization ?? null,
    roleTitle: p.role_title ?? null,
    isMe: p.user_id === userId || p.person_user_id === userId,
    isInternal: !!(p.user_id || p.person_user_id),
  }));
}

/** Previous meeting: same series first, else the latest visible meeting sharing a participant (other than me) or the project. */
export async function findPreviousMeeting(db: Db, ctx: WsCtx, m: any, otherPersonIds: string[]) {
  const t = m.scheduled_start ?? m.started_at ?? m.created_at;
  return one<any>(
    db,
    `SELECT pm.*,
            CASE WHEN $4::uuid IS NOT NULL AND pm.series_id = $4 THEN 'series'
                 WHEN EXISTS (SELECT 1 FROM participants pp WHERE pp.meeting_id = pm.id AND pp.person_id = ANY($6::uuid[])) THEN 'participants'
                 ELSE 'project' END AS via
       FROM meetings pm
      WHERE pm.workspace_id = $1 AND ${meetingVisibleSql('pm', '$2')} AND pm.id <> $3
        AND ${meetingTimeSql('pm')} < $7
        AND (($4::uuid IS NOT NULL AND pm.series_id = $4)
          OR ($5::uuid IS NOT NULL AND pm.project_id = $5)
          OR EXISTS (SELECT 1 FROM participants pp WHERE pp.meeting_id = pm.id AND pp.person_id = ANY($6::uuid[])))
      ORDER BY ($4::uuid IS NOT NULL AND pm.series_id = $4) DESC, ${meetingTimeSql('pm')} DESC
      LIMIT 1`,
    [ctx.workspaceId, ctx.userId, m.id, m.series_id ?? null, m.project_id ?? null, otherPersonIds, t],
  );
}

export interface RelatedScope {
  base: Scope;
  previous: any | null;
  relatedMeetingIds: string[];
  personIds: string[];
  /** true when nothing links this meeting to earlier ones (no series / project / previous meeting / known people). */
  empty: boolean;
}

/**
 * Scope of ledger items relevant to meeting `m` (excluding its own items):
 * same series, same project, the previous meeting and (optionally) items linked to the other participants.
 */
export async function relatedScope(db: Db, ctx: WsCtx, m: any, opts: { includeProject: boolean; includePersons: boolean }): Promise<RelatedScope> {
  const participants = await loadParticipants(db, m.id, ctx.userId);
  const personIds = [...new Set(participants.filter((p) => p.personId && !p.isMe).map((p) => p.personId as string))];
  const previous = await findPreviousMeeting(db, ctx, m, personIds);
  const related = await rows<{ id: string }>(
    db,
    `SELECT rm.id FROM meetings rm
      WHERE rm.workspace_id = $1 AND ${meetingVisibleSql('rm', '$2')} AND rm.id <> $3
        AND (($4::uuid IS NOT NULL AND rm.series_id = $4) OR ($5::uuid IS NOT NULL AND rm.project_id = $5))
      ORDER BY ${meetingTimeSql('rm')} DESC LIMIT 500`,
    [ctx.workspaceId, ctx.userId, m.id, m.series_id ?? null, opts.includeProject ? (m.project_id ?? null) : null],
  );
  const ids = new Set(related.map((r) => r.id));
  if (previous) ids.add(previous.id);
  const s = newScope(ctx.workspaceId, ctx.userId);
  s.ands.push(`{a}.meeting_id IS DISTINCT FROM ${s.p(m.id)}::uuid`);
  if (m.series_id) s.ors.push(`{a}.series_id = ${s.p(m.series_id)}::uuid`);
  if (opts.includeProject && m.project_id) s.ors.push(`{a}.project_id = ${s.p(m.project_id)}::uuid`);
  if (ids.size) s.ors.push(`{a}.meeting_id = ANY(${s.p([...ids])}::uuid[])`);
  const persons = opts.includePersons ? personIds : [];
  return { base: s, previous, relatedMeetingIds: [...ids], personIds: persons, empty: s.ors.length === 0 && persons.length === 0 };
}

/** Per-table scope: base ORs + person links for that table. */
export function withPersons(base: Scope, personIds: string[], kind: 'decision' | 'action' | 'commitment' | 'question'): Scope | null {
  const s = base.clone();
  if (personIds.length) {
    const p = s.p(personIds);
    if (kind === 'action') s.ors.push(`{a}.assignee_person_id = ANY(${p}::uuid[])`);
    if (kind === 'commitment') s.ors.push(`({a}.promised_by_person_id = ANY(${p}::uuid[]) OR {a}.promised_to_person_id = ANY(${p}::uuid[]))`);
    if (kind === 'decision') s.ors.push(`({a}.owner_person_id = ANY(${p}::uuid[]) OR {a}.participant_person_ids && ${p}::uuid[])`);
    if (kind === 'question') s.ors.push(`{a}.owner_person_id = ANY(${p}::uuid[])`);
  }
  return s.ors.length ? s : null;
}

function cap<T>(list: T[], n: number): { items: T[]; more: number } {
  return { items: list.slice(0, n), more: Math.max(0, list.length - n) };
}

export async function buildBrief(db: Db, ctx: WsCtx, m: any) {
  const now = ctx.deps.clock.now();
  const tz = safeTz(ctx.user.timezone);
  const today = dateInTz(now, tz);
  const participants = await loadParticipants(db, m.id, ctx.userId);
  const template = await resolveTemplate(db, ctx.workspaceId, m.template_key, m.meeting_type);
  const rel = await relatedScope(db, ctx, m, { includeProject: true, includePersons: true });
  const L = BRIEF_LIMITS;

  const sd = withPersons(rel.base, rel.personIds, 'decision');
  const sa = withPersons(rel.base, rel.personIds, 'action');
  const sc = withPersons(rel.base, rel.personIds, 'commitment');
  const sq = withPersons(rel.base, rel.personIds, 'question');
  const decisions = sd ? await loadDecisions(db, sd, { view: 'current', limit: L.decisions + 1 }) : [];
  const actions = sa ? await loadActions(db, sa, { statuses: ['confirmed', 'in_progress'], today, limit: L.actions + 1 }) : [];
  const commitments = sc ? await loadCommitments(db, sc, { statuses: ['open'], today, limit: L.commitments * 3 + 3 }) : [];
  const questions = sq ? await loadQuestions(db, sq, { statuses: ['open'], limit: L.questions + 1 }) : [];
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const changes = sd ? await loadChanges(db, sd, { sinceIso: since, limit: L.changes }) : [];

  const firstMeeting = !rel.previous && !decisions.length && !actions.length && !commitments.length && !questions.length && !changes.length;
  const base = {
    meeting: meetingBrief(m),
    generatedAt: now.toISOString(),
    timezone: tz,
    firstMeeting,
    participants,
    agendaTemplate: template.agenda,
  };
  if (firstMeeting) {
    // 初回: 過去の履歴が無いので無理に生成しない（参加者の基本情報と定型アジェンダのみ）。
    return {
      ...base,
      previousMeeting: null,
      currentDecisions: [],
      openActions: [],
      commitments: { mine: [], theirs: [], others: [] },
      openQuestions: [],
      personNotes: [],
      recentChanges: [],
      more: { decisions: 0, actions: 0, commitments: 0, questions: 0 },
    };
  }

  const otherPersonIds = participants.filter((p) => p.personId && !p.isMe).map((p) => p.personId as string);
  const personNotes: { personId: string; name: string; organization: string | null; roleTitle: string | null; profileNote: string | null; notes: any[] }[] = [];
  if (otherPersonIds.length) {
    const people = await rows(db, 'SELECT id, name, organization, role_title, notes FROM people WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL', [
      ctx.workspaceId,
      otherPersonIds,
    ]);
    const notes = await rows(
      db,
      `SELECT n.id, n.person_id, n.body, n.created_at, u.name AS author
         FROM person_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.workspace_id = $1 AND n.person_id = ANY($2::uuid[]) ORDER BY n.created_at DESC`,
      [ctx.workspaceId, otherPersonIds],
    );
    for (const p of people) {
      const mine = notes.filter((n) => n.person_id === p.id).slice(0, L.notesPerPerson);
      if (!mine.length && !p.notes) continue;
      personNotes.push({
        personId: p.id,
        name: p.name,
        organization: p.organization,
        roleTitle: p.role_title,
        profileNote: p.notes ? String(p.notes).slice(0, 500) : null,
        notes: mine.map((n) => ({ id: n.id, body: n.body, author: n.author ?? null, createdAt: iso(n.created_at) })),
      });
    }
  }

  const d = cap(decisions, L.decisions);
  const a = cap(actions, L.actions);
  const q = cap(questions, L.questions);
  const split = (dir: string) => commitments.filter((c) => c.direction === dir).slice(0, L.commitments);
  return {
    ...base,
    previousMeeting: rel.previous ? { ...meetingBrief(rel.previous), via: rel.previous.via as 'series' | 'participants' | 'project' } : null,
    currentDecisions: d.items,
    openActions: a.items,
    commitments: { mine: split('mine'), theirs: split('theirs'), others: split('other') },
    openQuestions: q.items,
    personNotes,
    recentChanges: changes,
    more: {
      decisions: d.more,
      actions: a.more,
      commitments: ['mine', 'theirs', 'other'].reduce((n, dir) => n + Math.max(0, commitments.filter((c) => c.direction === dir).length - L.commitments), 0),
      questions: q.more,
    },
  };
}

export default async function briefRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/meetings/:id/brief', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => buildBrief(db, ctx, await loadMeeting(db, ctx, id)));
  });
}
