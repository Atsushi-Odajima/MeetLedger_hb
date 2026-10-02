import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { roleAtLeast } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows } from '../../db/pool';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { body, parse, wsIdParams, wsParams } from '../../lib/http';
import { requireAuth, workspaceCtx } from '../../rbac/access';

// API tokens for MCP clients / integrations. Shown ONCE at creation; only sha256(token) is stored.
// Pinned to one workspace (and its org). Scopes: ['read'] or ['read','write'] — enforced by workspaceCtx
// (minRole member ⇒ 'write' scope). A token never exceeds the 'member' role and can never manage tokens,
// approve external writes or perform admin operations (interactive session required).

export const TOKEN_PREFIX = 'mlt_';
const MAX_ACTIVE_PER_USER = 20;

function requireSession(req: FastifyRequest) {
  const auth = requireAuth(req);
  if (auth.via !== 'session') throw forbidden('API tokens can only be managed from an interactive session');
  return auth;
}

function tokenDto(t: any) {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes,
    userId: t.user_id,
    userName: t.user_name ?? undefined,
    createdAt: new Date(t.created_at).toISOString(),
    lastUsedAt: t.last_used_at ? new Date(t.last_used_at).toISOString() : null,
    expiresAt: t.expires_at ? new Date(t.expires_at).toISOString() : null,
    revokedAt: t.revoked_at ? new Date(t.revoked_at).toISOString() : null,
  };
}

export function apiTokenRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/api-tokens', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    requireSession(req);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const isAdmin = roleAtLeast(ctx.role, 'admin');
    return ctx.tx(async (db) => {
      const list = await rows<any>(
        db,
        `SELECT t.id, t.name, t.scopes, t.user_id, t.created_at, t.last_used_at, t.expires_at, t.revoked_at, u.name AS user_name
           FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.workspace_id=$1 AND (t.user_id=$2 OR $3::boolean) ORDER BY t.created_at DESC LIMIT 200`,
        [workspaceId, ctx.userId, isAdmin],
      );
      return { items: list.map(tokenDto) };
    });
  });

  app.post('/api/w/:workspaceId/api-tokens', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    requireSession(req);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const b = body(
      req,
      z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(['read', 'write'])).min(1).max(2).default(['read']),
        expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
      }),
    );
    const scopes = b.scopes.includes('write') ? ['read', 'write'] : ['read'];
    if (scopes.includes('write') && !roleAtLeast(ctx.role, 'member')) throw badRequest('Viewers can only create read-only tokens');
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const expires = b.expiresInDays ? new Date(deps.clock.now().getTime() + b.expiresInDays * 86400_000) : null;
    return ctx.tx(async (db) => {
      const active = await one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM api_tokens WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [workspaceId, ctx.userId],
      );
      if ((active?.n ?? 0) >= MAX_ACTIVE_PER_USER) throw conflict(`At most ${MAX_ACTIVE_PER_USER} active tokens per user`);
      const t = await one<any>(
        db,
        `INSERT INTO api_tokens(org_id, workspace_id, user_id, name, token_hash, scopes, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, name, scopes, user_id, created_at, last_used_at, expires_at, revoked_at`,
        [ctx.orgId, workspaceId, ctx.userId, b.name, sha256(token), scopes, expires],
      );
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'api_token.created', entityType: 'api_token', entityId: t.id, meta: { scopes } });
      // The plaintext token is returned exactly once.
      return { token, apiToken: tokenDto(t) };
    });
  });

  app.delete('/api/w/:workspaceId/api-tokens/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    requireSession(req);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const isAdmin = roleAtLeast(ctx.role, 'admin');
    return ctx.tx(async (db) => {
      const t = await one<any>(
        db,
        `UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id=$1 AND workspace_id=$2 AND (user_id=$3 OR $4::boolean)
         RETURNING id, name, scopes, user_id, created_at, last_used_at, expires_at, revoked_at`,
        [id, workspaceId, ctx.userId, isAdmin],
      );
      if (!t) throw notFound('Token not found');
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'api_token.revoked', entityType: 'api_token', entityId: id });
      return { apiToken: tokenDto(t) };
    });
  });
}
