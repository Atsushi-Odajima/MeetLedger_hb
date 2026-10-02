// REST: decisions / actions / commitments / questions, Review Inbox, contradictions.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTION_STATUSES, COMMITMENT_STATUSES, QUESTION_STATUSES } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows } from '../../db/pool';
import { badRequest, conflict } from '../../lib/errors';
import { body, iso, parse, query, wsIdParams, wsParams, zUuid } from '../../lib/http';
import { meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { ledgerEvent, loadItem, scopeOf, topicKeyOf, type LedgerScope, type LedgerType } from './common';
import { decisionsByIds, itemDto, listActions, listCommitments, listContradictions, listDecisions, listQuestions } from './queries';
import {
  EDIT_SCHEMAS,
  acceptItem,
  applyEdits,
  createDecision,
  createDecisionSchema,
  editCandidate,
  rejectItem,
  resolveContradiction,
  setItemStatus,
  supersedeDecision,
} from './service';

const zLimit = z.coerce.number().int().min(1).max(500).default(200);
const zFlag = z
  .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
  .optional()
  .transform((v) => v === '1' || v === 'true');
const typeParams = z.object({ workspaceId: zUuid, type: z.enum(['decision', 'action', 'commitment', 'question']), id: zUuid });

async function visibleMeetingOrThrow(db: any, scope: LedgerScope, meetingId: string | null | undefined) {
  if (!meetingId) return null;
  const m = await one<any>(db, `SELECT m.* FROM meetings m WHERE m.id=$1 AND m.workspace_id=$2 AND ${meetingVisibleSql('m', '$3')}`, [meetingId, scope.workspaceId, scope.userId]);
  if (!m) throw badRequest('Unknown meetingId');
  return m;
}

export default async function ledgerRoutes(app: FastifyInstance, deps: Deps) {
  // ================================================================ decisions
  app.get('/api/w/:workspaceId/decisions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(
      req,
      z.object({
        view: z.enum(['current', 'all', 'candidates', 'superseded']).default('current'),
        projectId: zUuid.optional(),
        seriesId: zUuid.optional(),
        personId: zUuid.optional(),
        meetingId: zUuid.optional(),
        topic: z.string().max(200).optional(),
        limit: zLimit,
        cursor: z.string().regex(/^\d+$/).optional(),
      }),
    );
    return ctx.tx((db) => listDecisions(db, scopeOf(ctx), { ...q, topicKey: q.topic ? (topicKeyOf(q.topic) ?? undefined) : undefined }));
  });

  app.post('/api/w/:workspaceId/decisions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, createDecisionSchema);
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      return itemDto(db, scope, 'decision', await createDecision(db, scope, b));
    });
  });

  app.get('/api/w/:workspaceId/decisions/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      return itemDto(db, scope, 'decision', await loadItem(db, scope, 'decision', id));
    });
  });

  app.patch('/api/w/:workspaceId/decisions/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, EDIT_SCHEMAS.decision.extend({ status: z.enum(['active', 'revoked']).optional() }).strict());
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const row = await loadItem(db, scope, 'decision', id, true);
      if (row.review_state === 'rejected') throw conflict('Rejected decisions cannot be edited', { code: 'rejected' });
      const { status, ...edits } = b;
      const r = await applyEdits(db, scope, 'decision', row, edits);
      if (Object.keys(r.diff).length) await ledgerEvent(db, { orgId: ctx.orgId, workspaceId, type: 'decision', id, event: 'edited', byUserId: ctx.userId, diff: r.diff });
      if (status && status !== row.status) {
        if (row.status === 'superseded') throw conflict('A superseded decision keeps its history; supersede links cannot be undone here', { code: 'superseded' });
        if (row.review_state !== 'confirmed') throw conflict('Only confirmed decisions can be revoked', { code: 'not_confirmed' });
        await db.query('UPDATE decisions SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
        await ledgerEvent(db, { orgId: ctx.orgId, workspaceId, type: 'decision', id, event: 'status_changed', byUserId: ctx.userId, diff: { from: row.status, to: status } });
      }
      return itemDto(db, scope, 'decision', await loadItem(db, scope, 'decision', id));
    });
  });

  /** Supersede chain (oldest -> newest) + ledger events of every decision in the chain. */
  app.get('/api/w/:workspaceId/decisions/:id/history', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const start = await loadItem(db, scope, 'decision', id);
      const chainIds = [start.id];
      const seen = new Set(chainIds);
      let cur = start;
      for (let i = 0; i < 50 && cur.supersedes_decision_id && !seen.has(cur.supersedes_decision_id); i++) {
        const prev = await loadItem(db, scope, 'decision', cur.supersedes_decision_id).catch(() => null);
        if (!prev) break;
        chainIds.unshift(prev.id);
        seen.add(prev.id);
        cur = prev;
      }
      cur = start;
      for (let i = 0; i < 50 && cur.superseded_by_decision_id && !seen.has(cur.superseded_by_decision_id); i++) {
        const next = await loadItem(db, scope, 'decision', cur.superseded_by_decision_id).catch(() => null);
        if (!next) break;
        chainIds.push(next.id);
        seen.add(next.id);
        cur = next;
      }
      const decs = await decisionsByIds(db, scope, chainIds);
      const byId = new Map(decs.map((d) => [d.id, d]));
      const events = await rows(
        db,
        `SELECT e.id, e.entity_id, e.event, e.by_user_id, u.name AS by_user_name, e.diff, e.created_at
           FROM ledger_events e LEFT JOIN users u ON u.id = e.by_user_id
          WHERE e.workspace_id=$1 AND e.entity_type='decision' AND e.entity_id = ANY($2) ORDER BY e.created_at, e.id`,
        [workspaceId, chainIds],
      );
      return {
        chain: chainIds.map((x) => byId.get(x)).filter(Boolean),
        current: chainIds.map((x) => byId.get(x)).find((d) => d && d.reviewState === 'confirmed' && d.status === 'active') ?? null,
        events: events.map((e) => ({ id: e.id, decisionId: e.entity_id, event: e.event, byUserId: e.by_user_id, byUserName: e.by_user_name, diff: e.diff, createdAt: iso(e.created_at) })),
      };
    });
  });

  app.post('/api/w/:workspaceId/decisions/:id/supersede', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.union([
        z.object({ newDecisionId: zUuid }).strict(),
        z.object({ text: z.string().trim().min(1).max(2000), topic: z.string().trim().max(200).nullable().optional(), reason: z.string().trim().max(2000).nullable().optional() }).strict(),
      ]),
    );
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const r = await supersedeDecision(db, scope, id, b);
      return { old: await itemDto(db, scope, 'decision', r.old), new: await itemDto(db, scope, 'decision', r.new) };
    });
  });

  // ================================================================ actions
  app.get('/api/w/:workspaceId/actions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(
      req,
      z.object({
        status: z.enum([...ACTION_STATUSES, 'open']).optional(),
        assignee: z.literal('me').optional(),
        assigneePersonId: zUuid.optional(),
        overdue: zFlag,
        meetingId: zUuid.optional(),
        projectId: zUuid.optional(),
        limit: zLimit,
        cursor: z.string().regex(/^\d+$/).optional(),
      }),
    );
    return ctx.tx((db) => listActions(db, scopeOf(ctx), q));
  });

  app.post('/api/w/:workspaceId/actions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, EDIT_SCHEMAS.action.extend({ description: z.string().trim().min(1).max(2000), meetingId: zUuid.nullable().optional() }).strict());
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const m = await visibleMeetingOrThrow(db, scope, b.meetingId);
      const row = await one<any>(
        db,
        `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, series_id, description, status, extracted_by, created_by, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed','user',$7,$7,now()) RETURNING *`,
        [ctx.orgId, workspaceId, m?.id ?? null, m?.project_id ?? null, m?.series_id ?? null, b.description, ctx.userId],
      );
      const { description: _d, meetingId: _m, ...rest } = b;
      await applyEdits(db, scope, 'action', row, rest);
      await ledgerEvent(db, { orgId: ctx.orgId, workspaceId, type: 'action', id: row.id, event: 'created', byUserId: ctx.userId, diff: { manual: true } });
      return itemDto(db, scope, 'action', await loadItem(db, scope, 'action', row.id));
    });
  });

  // ================================================================ commitments
  app.get('/api/w/:workspaceId/commitments', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(
      req,
      z.object({
        direction: z.enum(['mine', 'theirs', 'all']).default('all'),
        status: z.enum([...COMMITMENT_STATUSES]).optional(),
        overdue: zFlag,
        meetingId: zUuid.optional(),
        projectId: zUuid.optional(),
        personId: zUuid.optional(),
        limit: zLimit,
        cursor: z.string().regex(/^\d+$/).optional(),
      }),
    );
    return ctx.tx((db) => listCommitments(db, scopeOf(ctx), q));
  });

  app.post('/api/w/:workspaceId/commitments', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, EDIT_SCHEMAS.commitment.extend({ description: z.string().trim().min(1).max(2000), meetingId: zUuid.nullable().optional() }).strict());
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const m = await visibleMeetingOrThrow(db, scope, b.meetingId);
      const row = await one<any>(
        db,
        `INSERT INTO commitments(org_id, workspace_id, meeting_id, project_id, series_id, description, status, extracted_by, created_by, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'open','user',$7,$7,now()) RETURNING *`,
        [ctx.orgId, workspaceId, m?.id ?? null, m?.project_id ?? null, m?.series_id ?? null, b.description, ctx.userId],
      );
      const { description: _d, meetingId: _m, ...rest } = b;
      await applyEdits(db, scope, 'commitment', row, rest);
      await ledgerEvent(db, { orgId: ctx.orgId, workspaceId, type: 'commitment', id: row.id, event: 'created', byUserId: ctx.userId, diff: { manual: true } });
      return itemDto(db, scope, 'commitment', await loadItem(db, scope, 'commitment', row.id));
    });
  });

  // ================================================================ questions
  app.get('/api/w/:workspaceId/questions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(
      req,
      z.object({ status: z.enum([...QUESTION_STATUSES]).optional(), meetingId: zUuid.optional(), projectId: zUuid.optional(), limit: zLimit, cursor: z.string().regex(/^\d+$/).optional() }),
    );
    return ctx.tx((db) => listQuestions(db, scopeOf(ctx), q));
  });

  app.post('/api/w/:workspaceId/questions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, EDIT_SCHEMAS.question.extend({ question: z.string().trim().min(1).max(2000), meetingId: zUuid.nullable().optional() }).strict());
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const m = await visibleMeetingOrThrow(db, scope, b.meetingId);
      const row = await one<any>(
        db,
        `INSERT INTO open_questions(org_id, workspace_id, meeting_id, project_id, series_id, question, status, extracted_by, created_by, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'open','user',$7,$7,now()) RETURNING *`,
        [ctx.orgId, workspaceId, m?.id ?? null, m?.project_id ?? null, m?.series_id ?? null, b.question, ctx.userId],
      );
      const { question: _q, meetingId: _m, ...rest } = b;
      await applyEdits(db, scope, 'question', row, rest);
      await ledgerEvent(db, { orgId: ctx.orgId, workspaceId, type: 'question', id: row.id, event: 'created', byUserId: ctx.userId, diff: { manual: true } });
      return itemDto(db, scope, 'question', await loadItem(db, scope, 'question', row.id));
    });
  });

  // ================================================================ PATCH / GET single (actions, commitments, questions)
  const patchable: { type: Exclude<LedgerType, 'decision'>; path: string; statuses: readonly string[] }[] = [
    { type: 'action', path: 'actions', statuses: ['confirmed', 'in_progress', 'done', 'cancelled'] },
    { type: 'commitment', path: 'commitments', statuses: ['open', 'done', 'cancelled'] },
    { type: 'question', path: 'questions', statuses: ['open', 'answered', 'dropped'] },
  ];
  for (const p of patchable) {
    app.get(`/api/w/:workspaceId/${p.path}/:id`, async (req) => {
      const { workspaceId, id } = parse(wsIdParams, req.params);
      const ctx = await workspaceCtx(deps, req, workspaceId);
      return ctx.tx(async (db) => {
        const scope = scopeOf(ctx);
        return itemDto(db, scope, p.type, await loadItem(db, scope, p.type, id));
      });
    });

    app.patch(`/api/w/:workspaceId/${p.path}/:id`, async (req) => {
      const { workspaceId, id } = parse(wsIdParams, req.params);
      const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
      const extra = p.type === 'question' ? { status: z.enum(p.statuses as [string, ...string[]]).optional(), answeredInMeetingId: zUuid.nullable().optional() } : { status: z.enum(p.statuses as [string, ...string[]]).optional() };
      const b = body(req, (EDIT_SCHEMAS[p.type] as z.ZodObject<any>).extend(extra).strict()) as Record<string, unknown>;
      return ctx.tx(async (db) => {
        const scope = scopeOf(ctx);
        const row = await loadItem(db, scope, p.type, id, true);
        if (row.status === 'rejected') throw conflict('Rejected items cannot be edited', { code: 'rejected' });
        const { status, answeredInMeetingId, ...edits } = b;
        const r = await applyEdits(db, scope, p.type, row, edits);
        if (Object.keys(r.diff).length) await ledgerEvent(db, { orgId: ctx.orgId, workspaceId, type: p.type, id, event: 'edited', byUserId: ctx.userId, diff: r.diff });
        if (answeredInMeetingId !== undefined) {
          if (answeredInMeetingId) await visibleMeetingOrThrow(db, scope, answeredInMeetingId as string);
          await db.query('UPDATE open_questions SET answered_in_meeting_id=$2, updated_at=now() WHERE id=$1', [id, answeredInMeetingId]);
        }
        if (status) await setItemStatus(db, scope, p.type, r.row, status as string);
        return itemDto(db, scope, p.type, await loadItem(db, scope, p.type, id));
      });
    });
  }

  // ================================================================ Review Inbox
  app.get('/api/w/:workspaceId/review', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ meetingId: zUuid.optional() }));
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const [decisions, actions, commitments, questions] = [
        await listDecisions(db, scope, { view: 'candidates', meetingId: q.meetingId, limit: 500 }),
        await listActions(db, scope, { status: 'candidate', meetingId: q.meetingId, limit: 500 }),
        await listCommitments(db, scope, { status: 'candidate', meetingId: q.meetingId, limit: 500 }),
        await listQuestions(db, scope, { status: 'candidate', meetingId: q.meetingId, limit: 500 }),
      ];
      const items = [
        ...decisions.items.map((item) => ({ type: 'decision' as const, item, flags: { assigneeInferred: false, dueInferred: false, missingOwner: false, missingDue: false, sourceStatus: item.source?.status ?? null } })),
        ...actions.items.map((item) => ({
          type: 'action' as const,
          item,
          flags: {
            assigneeInferred: item.assigneeInferred,
            dueInferred: item.dueInferred,
            missingOwner: !item.assigneePersonId && !item.assigneeUserId && !item.assigneeText,
            missingDue: !item.dueDate,
            sourceStatus: item.source?.status ?? null,
          },
        })),
        ...commitments.items.map((item) => ({
          type: 'commitment' as const,
          item,
          flags: { assigneeInferred: false, dueInferred: item.dueInferred, missingOwner: !item.promisedByPersonId && !item.promisedByText, missingDue: !item.dueDate, sourceStatus: item.source?.status ?? null },
        })),
        ...questions.items.map((item) => ({ type: 'question' as const, item, flags: { assigneeInferred: false, dueInferred: false, missingOwner: false, missingDue: false, sourceStatus: item.source?.status ?? null } })),
      ];
      // Meetings in scope: the given one, or every visible meeting that has candidates or needs review.
      const mParams: unknown[] = [workspaceId, ctx.userId];
      let mFilter = `(m.status = 'needs_review' OR EXISTS (SELECT 1 FROM decisions d WHERE d.meeting_id = m.id AND d.review_state='candidate')
                     OR EXISTS (SELECT 1 FROM actions a WHERE a.meeting_id = m.id AND a.status='candidate'))`;
      if (q.meetingId) {
        mParams.push(q.meetingId);
        mFilter = 'm.id = $3';
      }
      const meetingFrom = `FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')} AND ${mFilter}`;
      const unmappedSpeakers = await rows(
        db,
        `SELECT sp.id AS speaker_id, sp.label, m.id AS meeting_id, m.title AS meeting_title FROM meeting_speakers sp
          JOIN meetings m ON m.id = sp.meeting_id
         WHERE sp.person_id IS NULL AND m.id IN (SELECT m.id ${meetingFrom})
           AND EXISTS (SELECT 1 FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id AND t.is_current WHERE s.speaker_id = sp.id)
         ORDER BY m.title, sp.label LIMIT 500`,
        mParams,
      );
      const unlinkedParticipants = await rows(
        db,
        `SELECT pa.id AS participant_id, pa.display_name, m.id AS meeting_id, m.title AS meeting_title FROM participants pa
          JOIN meetings m ON m.id = pa.meeting_id
         WHERE pa.person_id IS NULL AND m.id IN (SELECT m.id ${meetingFrom}) ORDER BY m.title, pa.display_name LIMIT 500`,
        mParams,
      );
      const contradictions = await listContradictions(db, scope, { status: 'open', meetingId: q.meetingId });
      return {
        items,
        counts: { decision: decisions.items.length, action: actions.items.length, commitment: commitments.items.length, question: questions.items.length, contradiction: contradictions.length },
        unmappedSpeakers: unmappedSpeakers.map((s) => ({ speakerId: s.speaker_id, label: s.label, meetingId: s.meeting_id, meetingTitle: s.meeting_title })),
        unlinkedParticipants: unlinkedParticipants.map((p) => ({ participantId: p.participant_id, displayName: p.display_name, meetingId: p.meeting_id, meetingTitle: p.meeting_title })),
        contradictions,
      };
    });
  });

  app.post('/api/w/:workspaceId/review/:type/:id/accept', async (req) => {
    const { workspaceId, type, id } = parse(typeParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const raw = body(req, z.object({ edits: z.record(z.string(), z.unknown()).optional(), confirmInferred: z.boolean().optional() }).strict());
    const edits = raw.edits ? (parse(EDIT_SCHEMAS[type] as z.ZodType<Record<string, unknown>>, raw.edits) as Record<string, unknown>) : {};
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const row = await acceptItem(db, scope, type, id, { edits, confirmInferred: raw.confirmInferred });
      return { type, item: await itemDto(db, scope, type, row) };
    });
  });

  app.post('/api/w/:workspaceId/review/:type/:id/reject', async (req) => {
    const { workspaceId, type, id } = parse(typeParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ reason: z.string().trim().max(500).optional() }).strict());
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const row = await rejectItem(db, scope, type, id, b.reason ?? null);
      return { type, item: await itemDto(db, scope, type, row) };
    });
  });

  app.patch('/api/w/:workspaceId/review/:type/:id', async (req) => {
    const { workspaceId, type, id } = parse(typeParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const edits = body(req, EDIT_SCHEMAS[type] as z.ZodType<Record<string, unknown>>) as Record<string, unknown>;
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      const row = await editCandidate(db, scope, type, id, edits);
      return { type, item: await itemDto(db, scope, type, row) };
    });
  });

  /** Ledger events of one item (audit trail shown in the item drawer). */
  app.get('/api/w/:workspaceId/review/:type/:id/events', async (req) => {
    const { workspaceId, type, id } = parse(typeParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      await loadItem(db, scopeOf(ctx), type, id);
      const ev = await rows(
        db,
        `SELECT e.id, e.event, e.by_user_id, u.name AS by_user_name, e.diff, e.created_at FROM ledger_events e LEFT JOIN users u ON u.id = e.by_user_id
          WHERE e.workspace_id=$1 AND e.entity_type=$2 AND e.entity_id=$3 ORDER BY e.created_at, e.id`,
        [workspaceId, type, id],
      );
      return { items: ev.map((e) => ({ id: e.id, event: e.event, byUserId: e.by_user_id, byUserName: e.by_user_name, diff: e.diff, createdAt: iso(e.created_at) })) };
    });
  });

  // ================================================================ contradictions
  app.get('/api/w/:workspaceId/contradictions', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ status: z.enum(['open', 'confirmed_change', 'not_change', 'dismissed', 'all']).default('open'), meetingId: zUuid.optional() }));
    return ctx.tx(async (db) => ({ items: await listContradictions(db, scopeOf(ctx), q) }));
  });

  app.post('/api/w/:workspaceId/contradictions/:id/resolve', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ resolution: z.enum(['change', 'not_change', 'dismiss']) }).strict());
    return ctx.tx(async (db) => {
      const scope = scopeOf(ctx);
      await resolveContradiction(db, scope, id, b.resolution);
      const [c] = await listContradictions(db, scope, { status: 'all', ids: [id] });
      return c;
    });
  });
}

