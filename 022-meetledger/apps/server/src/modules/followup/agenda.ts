// Agenda: suggestions from open actions / questions / commitments of the previous meeting and the series
// (idempotent via UNIQUE(meeting_id, source_type, source_id)), template items, manual items.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateInTz } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { forbidden, notFound } from '../../lib/errors';
import { body, iso, parse, wsIdParams } from '../../lib/http';
import { roleAtLeast } from '@meetledger/shared';
import { itemVisibleSql, loadMeeting, meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { relatedScope } from './brief';
import { asLocale, loadActions, loadCommitments, loadQuestions, resolveTemplate, safeTz } from './util';

const SOURCE_TABLE: Record<string, string> = { action: 'actions', question: 'open_questions', commitment: 'commitments', decision: 'decisions' };

function agendaDto(r: any) {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    text: r.text,
    sourceType: r.source_type,
    sourceId: r.source_id,
    status: r.status,
    position: r.position,
    createdAt: iso(r.created_at),
  };
}

/** Agenda items of a meeting; items copied from ledger rows the viewer cannot see are hidden (ACL). */
export async function listAgenda(db: Db, ctx: WsCtx, meetingId: string) {
  const list = await rows(db, 'SELECT * FROM agenda_items WHERE meeting_id=$1 ORDER BY position, created_at, id', [meetingId]);
  const out = [];
  for (const r of list) {
    const table = SOURCE_TABLE[r.source_type];
    if (table && r.source_id) {
      const ok = await one(db, `SELECT 1 FROM ${table} x WHERE x.id = $1 AND x.workspace_id = $2 AND ${itemVisibleSql('x', '$3')}`, [r.source_id, ctx.workspaceId, ctx.userId]);
      if (!ok) continue;
    }
    out.push(agendaDto(r));
  }
  return out;
}

/** Idempotent: re-running never duplicates (UNIQUE for ledger sources, text check for template items). */
export async function suggestAgenda(db: Db, ctx: WsCtx, m: any): Promise<{ created: number }> {
  const ja = asLocale(ctx.user.locale) === 'ja';
  const today = dateInTz(ctx.deps.clock.now(), safeTz(ctx.user.timezone));
  const rel = await relatedScope(db, ctx, m, { includeProject: false, includePersons: false });
  const pos = await one<{ p: number }>(db, 'SELECT coalesce(max(position), -1)::int AS p FROM agenda_items WHERE meeting_id=$1', [m.id]);
  let position = (pos?.p ?? -1) + 1;
  let created = 0;
  const insert = async (text: string, sourceType: string, sourceId: string | null) => {
    if (sourceId === null) {
      const exists = await one(db, 'SELECT 1 FROM agenda_items WHERE meeting_id=$1 AND source_type=$2 AND text=$3', [m.id, sourceType, text]);
      if (exists) return;
    }
    const r = await db.query(
      `INSERT INTO agenda_items(org_id, meeting_id, text, source_type, source_id, status, position) VALUES ($1,$2,$3,$4,$5,'candidate',$6)
       ON CONFLICT (meeting_id, source_type, source_id) DO NOTHING`,
      [ctx.orgId, m.id, text.slice(0, 1000), sourceType, sourceId, position],
    );
    if (r.rowCount) {
      created++;
      position++;
    }
  };
  if (!rel.empty) {
    for (const a of await loadActions(db, rel.base, { statuses: ['confirmed', 'in_progress'], today, limit: 30 })) {
      const who = a.assigneeName ? (ja ? `（${a.assigneeName}）` : ` (${a.assigneeName})`) : '';
      await insert(`${ja ? 'Action確認: ' : 'Action follow-up: '}${a.description}${who}`, 'action', a.id);
    }
    for (const c of await loadCommitments(db, rel.base, { statuses: ['open'], today, limit: 30 })) {
      await insert(`${ja ? '約束の確認: ' : 'Commitment check: '}${c.description}`, 'commitment', c.id);
    }
    for (const q of await loadQuestions(db, rel.base, { statuses: ['open'], limit: 30 })) {
      await insert(`${ja ? '未解決の質問: ' : 'Open question: '}${q.question}`, 'question', q.id);
    }
  }
  const template = await resolveTemplate(db, ctx.workspaceId, m.template_key, m.meeting_type);
  for (const t of template.agenda) await insert(t, 'template', null);
  return { created };
}

export default async function agendaRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/meetings/:id/agenda', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      return { items: await listAgenda(db, ctx, id) };
    });
  });

  app.post('/api/w/:workspaceId/meetings/:id/agenda/suggest', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      const r = await suggestAgenda(db, ctx, m);
      return { created: r.created, items: await listAgenda(db, ctx, id) };
    });
  });

  app.post('/api/w/:workspaceId/meetings/:id/agenda', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ text: z.string().trim().min(1).max(1000), position: z.number().int().min(0).max(10000).optional() }));
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id, 'write');
      const pos = b.position ?? ((await one<{ p: number }>(db, 'SELECT coalesce(max(position), -1)::int + 1 AS p FROM agenda_items WHERE meeting_id=$1', [id]))?.p ?? 0);
      const r = await one(
        db,
        `INSERT INTO agenda_items(org_id, meeting_id, text, source_type, source_id, status, position) VALUES ($1,$2,$3,'manual',NULL,'accepted',$4) RETURNING *`,
        [ctx.orgId, id, b.text, pos],
      );
      return agendaDto(r);
    });
  });

  app.patch('/api/w/:workspaceId/agenda/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        text: z.string().trim().min(1).max(1000).optional(),
        status: z.enum(['candidate', 'accepted', 'rejected', 'done']).optional(),
        position: z.number().int().min(0).max(10000).optional(),
      }),
    );
    return ctx.tx(async (db) => {
      const item = await one<any>(
        db,
        `SELECT ai.* FROM agenda_items ai JOIN meetings m ON m.id = ai.meeting_id WHERE ai.id = $1 AND m.workspace_id = $2 AND ${meetingVisibleSql('m', '$3')}`,
        [id, workspaceId, ctx.userId],
      );
      if (!item) throw notFound('Agenda item not found');
      if (!roleAtLeast(ctx.role, 'member')) throw forbidden('Read-only role');
      const r = await one(
        db,
        'UPDATE agenda_items SET text = coalesce($2, text), status = coalesce($3, status), position = coalesce($4, position) WHERE id = $1 RETURNING *',
        [id, b.text ?? null, b.status ?? null, b.position ?? null],
      );
      return agendaDto(r);
    });
  });
}
