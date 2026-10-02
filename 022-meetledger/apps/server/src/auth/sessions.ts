import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps, AuthInfo } from '../context';
import { one, withSystem } from '../db/pool';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';

export const SESSION_COOKIE = 'ml_sid';

export async function createSession(deps: Deps, userId: string, req: FastifyRequest, reply: FastifyReply) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + deps.config.SESSION_TTL_HOURS * 3600_000);
  await withSystem(deps.pool, (db) =>
    db.query('INSERT INTO sessions(user_id, token_hash, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      userId,
      sha256(token),
      csrf,
      req.ip,
      String(req.headers['user-agent'] ?? '').slice(0, 300),
      expires,
    ]),
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires,
  });
  return { csrfToken: csrf };
}

export async function destroySession(deps: Deps, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await withSystem(deps.pool, (db) => db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves the caller from session cookie or Bearer API token. Returns null when anonymous. */
export async function authenticate(deps: Deps, req: FastifyRequest): Promise<AuthInfo | null> {
  const authz = req.headers.authorization;
  if (authz?.startsWith('Bearer ')) {
    const raw = authz.slice(7).trim();
    const row = await withSystem(deps.pool, (db) =>
      one(
        db,
        `UPDATE api_tokens t SET last_used_at = now()
           FROM users u
          WHERE t.token_hash = $1 AND u.id = t.user_id AND t.revoked_at IS NULL AND u.disabled_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
        RETURNING t.org_id, t.workspace_id, t.scopes, u.id, u.email, u.name, u.timezone, u.locale`,
        [sha256(raw)],
      ),
    );
    if (!row) throw unauthorized('Invalid API token');
    return {
      user: { id: row.id, email: row.email, name: row.name, timezone: row.timezone, locale: row.locale },
      via: 'token',
      tokenOrgId: row.org_id,
      tokenWorkspaceId: row.workspace_id,
      scopes: row.scopes,
    };
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const row = await withSystem(deps.pool, (db) =>
    one(
      db,
      `UPDATE sessions s SET last_seen_at = now()
         FROM users u
        WHERE s.token_hash = $1 AND u.id = s.user_id AND s.expires_at > now() AND u.disabled_at IS NULL
      RETURNING s.id AS session_id, s.csrf_token, u.id, u.email, u.name, u.timezone, u.locale`,
      [sha256(token)],
    ),
  );
  if (!row) return null;
  return {
    user: { id: row.id, email: row.email, name: row.name, timezone: row.timezone, locale: row.locale },
    via: 'session',
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
  };
}

/**
 * CSRF defense for cookie sessions (OWASP): SameSite=Lax cookie + required custom header carrying the per-session
 * token + Origin check. Bearer-token requests are not cookie-authenticated and skip this check.
 */
export function checkCsrf(deps: Deps, req: FastifyRequest, auth: AuthInfo | null) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== deps.config.APP_ORIGIN) throw forbidden('Cross-origin request rejected');
  if (!auth || auth.via !== 'session') return;
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !auth.csrfToken || !safeEqual(header, auth.csrfToken)) throw forbidden('CSRF token missing or invalid');
}

export function requireScope(auth: AuthInfo, scope: 'read' | 'write') {
  if (auth.via === 'token' && !auth.scopes?.includes(scope)) throw forbidden(`API token lacks '${scope}' scope`);
}
