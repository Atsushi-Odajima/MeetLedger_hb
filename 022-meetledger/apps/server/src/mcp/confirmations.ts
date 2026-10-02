import type { Deps } from '../context';
import { one, withTenant } from '../db/pool';
import { hmac, safeEqual } from '../lib/crypto';
import { isUuid } from '../rbac/access';
import { sha256Hex, stableStringify } from '../modules/connectors/secrets';

// Two-step confirmation for MCP write tools.
// Step 1 (no confirm): the tool returns a preview + confirmation_token and writes NOTHING.
// Step 2 (confirm:true + token): executes once. The token is bound to user + tool + arguments hash (+ workspace),
// expires after 10 minutes, is single-use (used_at) and carries an HMAC so ids alone are not usable.

export const CONFIRMATION_TTL_MS = 10 * 60_000;

export interface ConfirmScope {
  orgId: string;
  userId: string;
  workspaceId: string;
}

/** Hash of the tool arguments excluding the confirmation fields themselves. */
export function argsHash(scope: ConfirmScope, args: Record<string, unknown>): string {
  const { confirm: _c, confirmation_token: _t, ...rest } = args;
  return sha256Hex(stableStringify({ workspaceId: scope.workspaceId, args: rest }));
}

const sign = (deps: Deps, id: string, scope: ConfirmScope, tool: string, hash: string) => hmac(deps.config.SESSION_SECRET, `mcp-confirm:${id}:${scope.userId}:${scope.workspaceId}:${tool}:${hash}`);

export async function issueConfirmation(deps: Deps, scope: ConfirmScope, tool: string, args: Record<string, unknown>, preview: unknown) {
  const hash = argsHash(scope, args);
  const expiresAt = new Date(deps.clock.now().getTime() + CONFIRMATION_TTL_MS);
  const row = await withTenant(deps.pool, scope.orgId, (db) =>
    one<{ id: string }>(db, 'INSERT INTO mcp_confirmations(org_id, user_id, tool, args_hash, preview, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
      scope.orgId,
      scope.userId,
      tool,
      hash,
      JSON.stringify({ workspaceId: scope.workspaceId, preview }),
      expiresAt,
    ]),
  );
  return { token: `${row!.id}.${sign(deps, row!.id, scope, tool, hash)}`, expiresAt: expiresAt.toISOString() };
}

export type ConsumeResult = { ok: true } | { ok: false; reason: 'malformed' | 'invalid' };

/** Atomically validates and consumes a confirmation token (single use). */
export async function consumeConfirmation(deps: Deps, scope: ConfirmScope, tool: string, args: Record<string, unknown>, token: string): Promise<ConsumeResult> {
  const [id, sig] = String(token).split('.');
  if (!isUuid(id) || !sig) return { ok: false, reason: 'malformed' };
  const hash = argsHash(scope, args);
  // Signature binds the token to this user, workspace, tool and exact arguments (foreign / altered tokens fail here).
  if (!safeEqual(sig, sign(deps, id, scope, tool, hash))) return { ok: false, reason: 'invalid' };
  const used = await withTenant(deps.pool, scope.orgId, (db) =>
    one<{ id: string }>(
      db,
      `UPDATE mcp_confirmations SET used_at=$6 WHERE id=$1 AND user_id=$2 AND tool=$3 AND args_hash=$4 AND used_at IS NULL AND expires_at > $5 RETURNING id`,
      [id, scope.userId, tool, hash, deps.clock.now(), deps.clock.now()],
    ),
  );
  return used ? { ok: true } : { ok: false, reason: 'invalid' };
}
