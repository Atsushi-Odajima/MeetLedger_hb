import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../context';
import { one, rows } from '../../db/pool';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { body, iso, parse, query, wsIdParams, wsParams, zUuid } from '../../lib/http';
import { requireAuth, workspaceCtx } from '../../rbac/access';
import { deleteMeetingAiIndex, deleteMeetingAudio, deleteMeetingFully, deleteMeetingTranscript } from './deletion';
import { exportActionsCsv, exportCommitmentsCsv, exportDecisions, projectBook } from './ledgerExport';
import { exportFileBase, loadMeetingBundle, MEETING_EXPORT_FORMATS, renderMeeting } from './meetingExport';
import { contentDisposition, fmtDate } from './render';
import { ensureSampleWorkspace } from './sample';
import { signExportUrl, verifyExportSignature } from './workspaceExport';
import { importWorkspace, parseExportDoc } from './workspaceImport';

const zFlag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

function sendFile(reply: FastifyReply, r: { body: string; contentType: string; ext: string }, title: string, base: string, inline = false) {
  reply
    .header('content-type', r.contentType)
    .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', title, base, r.ext))
    .header('cache-control', 'no-store');
  return r.body;
}

const jobStatus = (j: any): 'queued' | 'running' | 'ready' | 'failed' | 'expired' => {
  if (j.status === 'succeeded') return j.result?.expired ? 'expired' : 'ready';
  if (j.status === 'dead' || j.status === 'cancelled') return 'failed';
  if (j.status === 'running' || j.attempts > 0) return 'running';
  return 'queued';
};

export default async function dataRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------------ deletion
  app.delete('/api/w/:workspaceId/meetings/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    return deleteMeetingFully(ctx, id);
  });

  app.post('/api/w/:workspaceId/meetings/:id/delete-audio', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    return deleteMeetingAudio(ctx, id);
  });

  app.post('/api/w/:workspaceId/meetings/:id/delete-transcript', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    return deleteMeetingTranscript(ctx, id);
  });

  app.post('/api/w/:workspaceId/meetings/:id/delete-ai-index', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ disableAi: z.boolean().default(false) }));
    return deleteMeetingAiIndex(ctx, id, b);
  });

  app.get('/api/w/:workspaceId/deletion-requests', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }));
    const admin = ctx.role === 'admin' || ctx.role === 'owner';
    const list = await ctx.tx((db) =>
      rows(
        db,
        `SELECT d.*, u.name AS requested_by_name FROM deletion_requests d LEFT JOIN users u ON u.id = d.requested_by
          WHERE d.workspace_id=$1 AND ($2::boolean OR d.requested_by = $3) ORDER BY d.created_at DESC LIMIT $4`,
        [workspaceId, admin, ctx.userId, q.limit],
      ),
    );
    return {
      items: list.map((d) => ({
        id: d.id,
        scope: d.scope,
        targetId: d.target_id,
        targetLabel: d.target_label,
        requestedBy: d.requested_by ? { id: d.requested_by, name: d.requested_by_name } : null,
        trigger: d.requested_by ? 'user' : 'retention',
        status: d.status,
        steps: d.steps,
        createdAt: iso(d.created_at),
        completedAt: iso(d.completed_at),
      })),
    };
  });

  // ------------------------------------------------------------------ per-meeting / ledger exports
  app.get('/api/w/:workspaceId/meetings/:id/export', async (req, reply) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const q = query(req, z.object({ format: z.enum(MEETING_EXPORT_FORMATS).default('md'), download: zFlag }));
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const out = await ctx.tx(async (db) => {
      const b = await loadMeetingBundle(db, ctx, id);
      if ((q.format === 'srt' || q.format === 'vtt') && !b.segments.length) throw notFound('Transcript not found');
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'meeting.exported', entityType: 'meeting', entityId: id, meta: { format: q.format } });
      return { r: renderMeeting(b, q.format), title: b.meeting.title as string, base: exportFileBase(b) };
    });
    return sendFile(reply, out.r, out.title, out.base, q.format === 'html' && !q.download);
  });

  const ledgerQuery = z.object({ projectId: zUuid.optional(), includeCandidates: zFlag });

  app.get('/api/w/:workspaceId/decisions/export', async (req, reply) => {
    const { workspaceId } = parse(wsParams, req.params);
    const q = query(req, ledgerQuery.extend({ format: z.enum(['csv', 'json']).default('csv') }));
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const r = await ctx.tx(async (db) => {
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'decisions.exported', meta: { format: q.format } });
      return exportDecisions(db, ctx, q, q.format);
    });
    return sendFile(reply, r, 'decisions', `decisions-${fmtDate(deps.clock.now(), ctx.user.timezone || 'Asia/Tokyo')}`);
  });

  app.get('/api/w/:workspaceId/actions/export', async (req, reply) => {
    const { workspaceId } = parse(wsParams, req.params);
    const q = query(req, ledgerQuery.extend({ format: z.enum(['csv']).default('csv') }));
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const r = await ctx.tx(async (db) => {
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'actions.exported', meta: { format: 'csv' } });
      return exportActionsCsv(db, ctx, q);
    });
    return sendFile(reply, r, 'actions', `actions-${fmtDate(deps.clock.now(), ctx.user.timezone || 'Asia/Tokyo')}`);
  });

  app.get('/api/w/:workspaceId/commitments/export', async (req, reply) => {
    const { workspaceId } = parse(wsParams, req.params);
    const q = query(req, ledgerQuery.extend({ format: z.enum(['csv']).default('csv') }));
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const r = await ctx.tx(async (db) => {
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'commitments.exported', meta: { format: 'csv' } });
      return exportCommitmentsCsv(db, ctx, q);
    });
    return sendFile(reply, r, 'commitments', `commitments-${fmtDate(deps.clock.now(), ctx.user.timezone || 'Asia/Tokyo')}`);
  });

  app.get('/api/w/:workspaceId/projects/:id/book', async (req, reply) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const q = query(req, z.object({ format: z.enum(['md', 'html']).default('md'), download: zFlag }));
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const r = await ctx.tx(async (db) => {
      const book = await projectBook(db, ctx, id, q.format);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'project.book_exported', entityType: 'project', entityId: id, meta: { format: q.format } });
      return book;
    });
    return sendFile(reply, r, r.title, `project-book-${fmtDate(deps.clock.now(), ctx.user.timezone || 'Asia/Tokyo')}`, q.format === 'html' && !q.download);
  });

  // ------------------------------------------------------------------ full workspace export (job) / import
  const heavy = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/w/:workspaceId/export/full', heavy, async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const b = body(req, z.object({ includeMedia: z.boolean().default(false) }));
    return ctx.tx(async (db) => {
      const j = await deps.jobs.enqueue(db, {
        orgId: ctx.orgId,
        type: 'export.full',
        key: `export-full:${workspaceId}:${ctx.userId}:${Date.now()}`,
        payload: { workspaceId, userId: ctx.userId, includeMedia: b.includeMedia },
        maxAttempts: 2,
      });
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'workspace.export_requested', meta: { jobId: j.id, includeMedia: b.includeMedia } });
      return { jobId: j.id };
    });
  });

  const loadExportJob = (db: any, orgId: string, workspaceId: string, userId: string, jobId: string) =>
    one(
      db,
      `SELECT id, status, attempts, result, created_at, finished_at FROM jobs
        WHERE id=$1 AND type='export.full' AND org_id=$2 AND payload->>'workspaceId' = $3 AND payload->>'userId' = $4`,
      [jobId, orgId, workspaceId, userId],
    );

  app.get('/api/w/:workspaceId/export/full/:jobId', async (req) => {
    const { workspaceId, jobId } = parse(z.object({ workspaceId: zUuid, jobId: zUuid }), req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const j = await ctx.tx((db) => loadExportJob(db, ctx.orgId, workspaceId, ctx.userId, jobId));
    if (!j) throw notFound('Export not found');
    const status = jobStatus(j);
    const out: Record<string, unknown> = { jobId, status, createdAt: iso(j.created_at), finishedAt: iso(j.finished_at) };
    if (status === 'ready') {
      Object.assign(out, signExportUrl(deps, workspaceId, jobId, ctx.userId));
      out.size = j.result.size;
      out.counts = j.result.counts;
      out.mediaFiles = j.result.mediaFiles;
      out.excludedMeetings = j.result.excludedMeetings;
    }
    return out;
  });

  app.get('/api/w/:workspaceId/export/full/:jobId/download', async (req, reply) => {
    const { workspaceId, jobId } = parse(z.object({ workspaceId: zUuid, jobId: zUuid }), req.params);
    const q = query(req, z.object({ u: zUuid, exp: z.coerce.number().int(), sig: z.string().min(10).max(200) }));
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    if (q.u !== ctx.userId || !verifyExportSignature(deps, workspaceId, jobId, q.u, q.exp, q.sig)) throw forbidden('Download link is invalid or expired');
    const j = await ctx.tx(async (db) => {
      const job = await loadExportJob(db, ctx.orgId, workspaceId, ctx.userId, jobId);
      if (job && jobStatus(job) === 'ready')
        await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'workspace.export_downloaded', meta: { jobId } });
      return job;
    });
    if (!j || jobStatus(j) !== 'ready') throw notFound('Export not found');
    const stream = await deps.storage.getStream(j.result.storageKey);
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="meetledger-workspace-export-${fmtDate(j.finished_at, ctx.user.timezone || 'Asia/Tokyo')}.json"`)
      .header('cache-control', 'no-store');
    return reply.send(stream);
  });

  app.post('/api/w/:workspaceId/import/full', { bodyLimit: deps.config.MAX_UPLOAD_MB * 1024 * 1024, ...heavy }, async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw forbidden('Interactive session required');
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    let raw: unknown = req.body;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw badRequest('file is required');
      try {
        raw = JSON.parse((await file.toBuffer()).toString('utf8'));
      } catch {
        throw badRequest('Export file is not valid JSON');
      }
    }
    const doc = parseExportDoc(raw);
    return ctx.tx((db) => importWorkspace(db, ctx, doc));
  });

  // ------------------------------------------------------------------ sample workspace
  app.post('/api/sample-workspace', async (req) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw forbidden('Interactive session required');
    if (!deps.config.SAMPLE_WORKSPACE) throw forbidden('Sample workspace is disabled on this installation');
    return ensureSampleWorkspace(deps, auth.user.id);
  });
}
