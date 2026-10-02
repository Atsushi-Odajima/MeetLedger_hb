import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES, type Role } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows, withSystem } from '../../db/pool';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { body, parse, wsParams } from '../../lib/http';
import { requireAuth, workspaceCtx } from '../../rbac/access';
import { audit } from '../../lib/audit';
import { decideAi, decideTranscription, wsSettings, type WorkspaceSettings } from '../../privacy/policy';

const settingsPatch = z
  .object({
    defaults: z
      .object({
        visibility: z.enum(['private', 'workspace', 'selected']),
        audioRetention: z.enum(['never', 'until_processed', '7d', '30d', 'custom']),
        audioRetentionDays: z.number().int().min(1).max(3650).nullable(),
        transcriptionMode: z.enum(['local', 'cloud', 'none']),
        aiEnabled: z.boolean(),
      })
      .partial(),
    transcription: z.object({ cloudAllowed: z.boolean(), language: z.enum(['ja', 'en', 'auto']) }).partial(),
    ai: z
      .object({
        provider: z.enum(['local-rules', 'ollama', 'openai', 'anthropic']),
        cloudAllowed: z.boolean(),
        embeddings: z.enum(['local-hash', 'openai', 'ollama']),
      })
      .partial(),
    retention: z
      .object({
        transcriptDays: z.number().int().min(1).max(36500).nullable(),
        aiIndexDays: z.number().int().min(1).max(36500).nullable(),
        artifactDays: z.number().int().min(1).max(36500).nullable(),
      })
      .partial(),
  })
  .partial();

/** What actually happens with data under the current workspace settings (shown in Settings > Privacy). */
export function describeProcessing(s: WorkspaceSettings, deps: Deps) {
  const sample = { ai_enabled: s.defaults.aiEnabled, transcription_mode: s.defaults.transcriptionMode, is_confidential: false };
  const t = decideTranscription(sample, s, deps.config);
  const a = decideAi(sample, s, deps.config);
  return {
    transcription: { allowed: t.allowed, provider: t.provider, isLocal: t.isLocal, reason: t.reason },
    ai: { allowed: a.allowed, provider: a.provider, isLocal: a.isLocal, reason: a.reason },
    installation: {
      cloudTranscriptionProvider: deps.config.CLOUD_TRANSCRIPTION_PROVIDER,
      aiProvider: deps.config.AI_PROVIDER,
      embeddingProvider: deps.config.EMBEDDING_PROVIDER,
      emailDriver: deps.config.EMAIL_DRIVER,
      storageDriver: deps.config.STORAGE_DRIVER,
    },
  };
}

export default async function workspaceRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const w = await one<any>(db, 'SELECT id, org_id, name, settings, is_sample, created_at FROM workspaces WHERE id=$1', [workspaceId]);
      const s = wsSettings(w.settings);
      return { id: w.id, orgId: w.org_id, name: w.name, isSample: w.is_sample, role: ctx.role, settings: s, processing: describeProcessing(s, deps) };
    });
  });

  app.patch('/api/w/:workspaceId', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const b = body(req, z.object({ name: z.string().trim().min(1).max(100) }));
    await ctx.tx((db) => db.query('UPDATE workspaces SET name=$2 WHERE id=$1', [workspaceId, b.name]));
    return { ok: true };
  });

  app.patch('/api/w/:workspaceId/settings', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const patch = body(req, settingsPatch);
    return ctx.tx(async (db) => {
      const w = await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const cur = wsSettings(w.settings);
      const next: WorkspaceSettings = {
        defaults: { ...cur.defaults, ...(patch.defaults ?? {}) },
        transcription: { ...cur.transcription, ...(patch.transcription ?? {}) },
        ai: { ...cur.ai, ...(patch.ai ?? {}) },
        retention: { ...cur.retention, ...(patch.retention ?? {}) },
      };
      if (next.defaults.audioRetention === 'custom' && !next.defaults.audioRetentionDays) throw badRequest('custom retention requires audioRetentionDays');
      await db.query('UPDATE workspaces SET settings=$2 WHERE id=$1', [workspaceId, next]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'workspace.settings_updated', meta: { changed: Object.keys(patch) } });
      return { settings: next, processing: describeProcessing(next, deps) };
    });
  });

  app.get('/api/w/:workspaceId/members', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const members = await ctx.tx((db) =>
      rows(
        db,
        `SELECT u.id, u.email, u.name, wm.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id=$1 AND u.disabled_at IS NULL ORDER BY u.name`,
        [workspaceId],
      ),
    );
    return { members };
  });

  app.put('/api/w/:workspaceId/members/:userId', async (req) => {
    const { workspaceId, userId } = parse(z.object({ workspaceId: z.string().uuid(), userId: z.string().uuid() }), req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const b = body(req, z.object({ role: z.enum(ROLES) }));
    if (b.role === 'owner' && ctx.role !== 'owner') throw forbidden('Only owners can grant owner');
    await ctx.tx(async (db) => {
      const cur = await one<{ role: Role }>(db, 'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
      if (!cur) throw notFound('Member not found');
      if (cur.role === 'owner' && b.role !== 'owner') {
        const owners = await one<{ n: number }>(db, "SELECT count(*)::int n FROM workspace_members WHERE workspace_id=$1 AND role='owner'", [workspaceId]);
        if (owners!.n <= 1) throw badRequest('Cannot demote the last owner');
      }
      await db.query('UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId, b.role]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'member.role_changed', entityType: 'user', entityId: userId, meta: { role: b.role } });
    });
    return { ok: true };
  });

  app.delete('/api/w/:workspaceId/members/:userId', async (req) => {
    const { workspaceId, userId } = parse(z.object({ workspaceId: z.string().uuid(), userId: z.string().uuid() }), req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    if (userId === ctx.userId) throw badRequest('Use leave instead');
    await ctx.tx(async (db) => {
      const cur = await one<{ role: Role }>(db, 'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
      if (!cur) throw notFound('Member not found');
      if (cur.role === 'owner' && ctx.role !== 'owner') throw forbidden('Only owners can remove owners');
      await db.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
      await db.query('DELETE FROM meeting_access WHERE user_id=$1 AND meeting_id IN (SELECT id FROM meetings WHERE workspace_id=$2)', [userId, workspaceId]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'member.removed', entityType: 'user', entityId: userId });
    });
    return { ok: true };
  });

  app.post('/api/orgs/:orgId/workspaces', async (req) => {
    const auth = requireAuth(req);
    const { orgId } = parse(z.object({ orgId: z.string().uuid() }), req.params);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(100) }));
    const ws = await withSystem(deps.pool, async (db) => {
      const m = await one<{ role: Role }>(db, 'SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2', [orgId, auth.user.id]);
      if (!m || (m.role !== 'owner' && m.role !== 'admin')) throw forbidden('Requires org admin');
      const { DEFAULT_WS_SETTINGS } = await import('../../privacy/policy');
      const w = await one<{ id: string }>(db, 'INSERT INTO workspaces(org_id, name, settings) VALUES ($1,$2,$3) RETURNING id', [orgId, b.name, DEFAULT_WS_SETTINGS]);
      await db.query('INSERT INTO workspace_members(workspace_id, org_id, user_id, role) VALUES ($1,$2,$3,$4)', [w!.id, orgId, auth.user.id, m.role]);
      await audit(db, { orgId, workspaceId: w!.id, userId: auth.user.id, action: 'workspace.created' });
      return w!;
    });
    return { id: ws.id };
  });

}
