import type { FastifyRequest } from 'fastify';
import { roleAtLeast, type Role } from '@meetledger/shared';
import type { AuthInfo, Deps, WsCtx } from '../context';
import { one, withSystem, withTenant, type Db } from '../db/pool';
import { forbidden, notFound, unauthorized } from '../lib/errors';
import { requireScope } from '../auth/sessions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

export function requireAuth(req: FastifyRequest): AuthInfo {
  const auth = (req as any).auth as AuthInfo | null;
  if (!auth) throw unauthorized();
  return auth;
}

/**
 * Resolves the workspace context for the current user and enforces a minimum role.
 * Workspace membership is looked up with a user-scoped system query; every subsequent data access
 * happens inside an RLS-scoped tenant transaction (ctx.tx).
 */
export async function workspaceCtx(deps: Deps, req: FastifyRequest, workspaceId: string, minRole: Role = 'viewer'): Promise<WsCtx> {
  const auth = requireAuth(req);
  if (!isUuid(workspaceId)) throw notFound('Workspace not found');
  if (auth.via === 'token') {
    if (auth.tokenWorkspaceId !== workspaceId) throw forbidden('API token is not valid for this workspace');
    requireScope(auth, roleAtLeast(minRole, 'member') ? 'write' : 'read');
  }
  const row = await withSystem(deps.pool, (db) =>
    one<{ org_id: string; role: Role; org_role: Role | null }>(
      db,
      `SELECT w.org_id, wm.role, om.role AS org_role
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $2
         LEFT JOIN org_members om ON om.org_id = w.org_id AND om.user_id = $2
        WHERE w.id = $1 AND w.deleted_at IS NULL`,
      [workspaceId, auth.user.id],
    ),
  );
  if (!row) throw notFound('Workspace not found');
  // Org owners/admins are at least admin in every workspace of their org.
  let role = row.role;
  if (row.org_role === 'owner') role = 'owner';
  else if (row.org_role === 'admin' && !roleAtLeast(role, 'admin')) role = 'admin';
  // API tokens never exceed 'member' privileges (admin operations require an interactive session).
  if (auth.via === 'token' && roleAtLeast(role, 'admin')) role = 'member';
  if (!roleAtLeast(role, minRole)) throw forbidden(`Requires ${minRole} role`);
  return {
    deps,
    userId: auth.user.id,
    user: auth.user,
    orgId: row.org_id,
    workspaceId,
    role,
    tx: (fn) => withTenant(deps.pool, row.org_id, fn),
  };
}

/**
 * SQL predicate: meeting row `m` is visible to user `$u`.
 * - workspace: every member of the workspace
 * - private:   only the creator
 * - selected:  creator + users listed in meeting_access
 * Admins do NOT automatically see private meetings (privacy first). Callers must also filter m.workspace_id.
 */
export function meetingVisibleSql(alias: string, userParam: string): string {
  return `(${alias}.deleted_at IS NULL AND (${alias}.visibility = 'workspace' OR ${alias}.created_by = ${userParam}
    OR (${alias}.visibility = 'selected' AND EXISTS (SELECT 1 FROM meeting_access ma WHERE ma.meeting_id = ${alias}.id AND ma.user_id = ${userParam}))))`;
}

/** SQL predicate for ledger rows (alias.meeting_id may be NULL = workspace-level item). */
export function itemVisibleSql(alias: string, userParam: string): string {
  return `(${alias}.meeting_id IS NULL OR EXISTS (SELECT 1 FROM meetings vm WHERE vm.id = ${alias}.meeting_id AND ${meetingVisibleSql('vm', userParam)}))`;
}

export interface MeetingAccessRow {
  id: string;
  workspace_id: string;
  org_id: string;
  created_by: string;
  visibility: string;
  ai_enabled: boolean;
  transcription_mode: string;
  status: string;
  title: string;
}

/** Loads a meeting the user can see (404 otherwise — never reveals existence). `write` requires member+. */
export async function loadMeeting(db: Db, ctx: WsCtx, meetingId: string, mode: 'read' | 'write' = 'read'): Promise<MeetingAccessRow & Record<string, any>> {
  if (!isUuid(meetingId)) throw notFound('Meeting not found');
  const m = await one(
    db,
    `SELECT m.* FROM meetings m WHERE m.id = $1 AND m.workspace_id = $2 AND ${meetingVisibleSql('m', '$3')}`,
    [meetingId, ctx.workspaceId, ctx.userId],
  );
  if (!m) throw notFound('Meeting not found');
  if (mode === 'write' && !roleAtLeast(ctx.role, 'member')) throw forbidden('Read-only role');
  return m;
}

export function requireRole(ctx: WsCtx, min: Role) {
  if (!roleAtLeast(ctx.role, min)) throw forbidden(`Requires ${min} role`);
}

/** Tenant transaction for jobs (no user). */
export function tenantTx<T>(deps: Deps, orgId: string, fn: (db: Db) => Promise<T>) {
  return withTenant(deps.pool, orgId, fn);
}
