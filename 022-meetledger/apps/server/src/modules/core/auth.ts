import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MeDto, Role } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows, withSystem, type Db } from '../../db/pool';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { body, parse } from '../../lib/http';
import { createSession, destroySession } from '../../auth/sessions';
import { requireAuth } from '../../rbac/access';
import { audit } from '../../lib/audit';
import { DEFAULT_WS_SETTINGS } from '../../privacy/policy';

const zEmail = z.string().trim().toLowerCase().email().max(254);
const zPassword = z.string().min(10, 'パスワードは10文字以上').max(200);
const zName = z.string().trim().min(1).max(100);

export async function buildMe(deps: Deps, req: FastifyRequest): Promise<MeDto> {
  const auth = requireAuth(req);
  const { orgs, workspaces } = await withSystem(deps.pool, async (db) => ({
    orgs: await rows(
      db,
      `SELECT o.id, o.name, om.role, o.is_sample FROM org_members om JOIN organizations o ON o.id = om.org_id WHERE om.user_id = $1 ORDER BY o.is_sample, o.created_at`,
      [auth.user.id],
    ),
    workspaces: await rows(
      db,
      `SELECT w.id, w.org_id, w.name, wm.role, w.is_sample, om.role AS org_role
         FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
         LEFT JOIN org_members om ON om.org_id = w.org_id AND om.user_id = wm.user_id
        WHERE wm.user_id = $1 ORDER BY w.is_sample, w.created_at`,
      [auth.user.id],
    ),
  }));
  return {
    user: auth.user,
    orgs: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role, isSample: o.is_sample })),
    workspaces: workspaces.map((w) => ({
      id: w.id,
      orgId: w.org_id,
      name: w.name,
      role: (w.org_role === 'owner' ? 'owner' : w.org_role === 'admin' && w.role !== 'owner' ? 'admin' : w.role) as Role,
      isSample: w.is_sample,
    })),
    csrfToken: auth.csrfToken ?? '',
  };
}

/** Creates an org + first workspace owned by userId (system context; used by setup/signup/sample). */
export async function createOrgWithWorkspace(db: Db, userId: string, orgName: string, wsName: string, isSample = false) {
  const org = await one<{ id: string }>(db, 'INSERT INTO organizations(name, is_sample) VALUES ($1,$2) RETURNING id', [orgName, isSample]);
  await db.query('INSERT INTO org_members(org_id, user_id, role) VALUES ($1,$2,$3)', [org!.id, userId, 'owner']);
  const ws = await one<{ id: string }>(db, 'INSERT INTO workspaces(org_id, name, settings, is_sample) VALUES ($1,$2,$3,$4) RETURNING id', [
    org!.id,
    wsName,
    DEFAULT_WS_SETTINGS,
    isSample,
  ]);
  await db.query('INSERT INTO workspace_members(workspace_id, org_id, user_id, role) VALUES ($1,$2,$3,$4)', [ws!.id, org!.id, userId, 'owner']);
  await db.query('INSERT INTO user_prefs(user_id, org_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, org!.id]);
  return { orgId: org!.id, workspaceId: ws!.id };
}

export default async function authRoutes(app: FastifyInstance, deps: Deps) {
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/setup/status', async () => {
    const r = await withSystem(deps.pool, (db) => one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users'));
    return { needsSetup: r!.n === 0, allowSignup: deps.config.ALLOW_SIGNUP, sampleAvailable: deps.config.SAMPLE_WORKSPACE };
  });

  /** First-run setup: only allowed while no user exists. Creates the Owner, organization and first workspace. */
  app.post('/api/setup', loginLimit, async (req, reply) => {
    const b = body(req, z.object({ email: zEmail, name: zName, password: zPassword, orgName: zName, workspaceName: zName.default('Main') }));
    const passwordHash = await hashPassword(b.password);
    const user = await withSystem(deps.pool, async (db) => {
      await db.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const n = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users');
      if (n!.n > 0) throw conflict('Setup already completed');
      const u = await one<{ id: string }>(db, 'INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [b.email, b.name, passwordHash]);
      const { orgId } = await createOrgWithWorkspace(db, u!.id, b.orgName, b.workspaceName);
      await audit(db, { orgId, userId: u!.id, action: 'setup.completed' });
      return u!;
    });
    await createSession(deps, user.id, req, reply);
    return { ok: true };
  });

  app.post('/api/auth/signup', loginLimit, async (req, reply) => {
    if (!deps.config.ALLOW_SIGNUP) throw forbidden('Signup is disabled; ask an admin for an invitation');
    const b = body(req, z.object({ email: zEmail, name: zName, password: zPassword, orgName: zName }));
    const passwordHash = await hashPassword(b.password);
    const user = await withSystem(deps.pool, async (db) => {
      const exists = await one(db, 'SELECT 1 FROM users WHERE email=$1', [b.email]);
      if (exists) throw conflict('Email already registered');
      const u = await one<{ id: string }>(db, 'INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [b.email, b.name, passwordHash]);
      await createOrgWithWorkspace(db, u!.id, b.orgName, 'Main');
      return u!;
    });
    await createSession(deps, user.id, req, reply);
    return { ok: true };
  });

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const b = body(req, z.object({ email: zEmail, password: z.string().max(200) }));
    const u = await withSystem(deps.pool, (db) => one<{ id: string; password_hash: string | null; disabled_at: string | null }>(db, 'SELECT id, password_hash, disabled_at FROM users WHERE email=$1', [b.email]));
    const ok = await verifyPassword(b.password, u?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok || u.disabled_at) throw unauthorized('メールアドレスまたはパスワードが違います');
    await withSystem(deps.pool, (db) => db.query('UPDATE users SET last_login_at = now() WHERE id=$1', [u.id]));
    await createSession(deps, u.id, req, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(deps, req, reply);
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const me = await buildMe(deps, req);
    // The CSRF token is only readable by same-origin JS (it is never put in a cookie).
    return me;
  });

  app.patch('/api/me', async (req) => {
    const auth = requireAuth(req);
    const b = body(req, z.object({ name: zName.optional(), timezone: z.string().max(64).optional(), locale: z.enum(['ja', 'en']).optional() }));
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone });
      } catch {
        throw badRequest('Unknown timezone');
      }
    }
    await withSystem(deps.pool, (db) =>
      db.query('UPDATE users SET name = coalesce($2,name), timezone = coalesce($3,timezone), locale = coalesce($4,locale) WHERE id=$1', [
        auth.user.id,
        b.name ?? null,
        b.timezone ?? null,
        b.locale ?? null,
      ]),
    );
    return { ok: true };
  });

  app.post('/api/auth/change-password', loginLimit, async (req) => {
    const auth = requireAuth(req);
    const b = body(req, z.object({ currentPassword: z.string().max(200), newPassword: zPassword }));
    const u = await withSystem(deps.pool, (db) => one<{ password_hash: string }>(db, 'SELECT password_hash FROM users WHERE id=$1', [auth.user.id]));
    if (!(await verifyPassword(b.currentPassword, u?.password_hash ?? null))) throw forbidden('Current password is wrong');
    const h = await hashPassword(b.newPassword);
    await withSystem(deps.pool, async (db) => {
      await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [auth.user.id, h]);
      await db.query('DELETE FROM sessions WHERE user_id=$1 AND id <> $2', [auth.user.id, auth.sessionId ?? null]);
    });
    return { ok: true };
  });

  // ---- invitations
  app.post('/api/orgs/:orgId/invitations', async (req) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw forbidden('Interactive session required');
    const { orgId } = parse(z.object({ orgId: z.string().uuid() }), req.params);
    const b = body(req, z.object({ email: zEmail, role: z.enum(['admin', 'member', 'viewer']), workspaceId: z.string().uuid() }));
    const token = randomToken(24);
    await withSystem(deps.pool, async (db) => {
      const m = await one<{ role: Role }>(db, 'SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2', [orgId, auth.user.id]);
      const wm = await one<{ role: Role }>(db, 'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND org_id=$3', [b.workspaceId, auth.user.id, orgId]);
      const isAdmin = m?.role === 'owner' || m?.role === 'admin' || wm?.role === 'owner' || wm?.role === 'admin';
      if (!isAdmin) throw forbidden('Requires admin role');
      await db.query(
        `INSERT INTO invitations(org_id, workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days')`,
        [orgId, b.workspaceId, b.email, b.role, sha256(token), auth.user.id],
      );
      await audit(db, { orgId, workspaceId: b.workspaceId, userId: auth.user.id, action: 'invitation.created', meta: { role: b.role } });
    });
    // Invitation links are shown to the admin to share manually; MeetLedger does not email third parties automatically.
    return { inviteUrl: `${deps.config.APP_ORIGIN}/invite?token=${token}`, expiresInDays: 7 };
  });

  app.post('/api/auth/accept-invite', loginLimit, async (req, reply) => {
    const b = body(req, z.object({ token: z.string().min(10).max(200), name: zName.optional(), password: zPassword.optional() }));
    const auth = (req as any).auth as { user: { id: string } } | null;
    const pwHash = b.password ? await hashPassword(b.password) : null;
    const userId = await withSystem(deps.pool, async (db) => {
      const inv = await one<any>(db, 'SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE', [sha256(b.token)]);
      if (!inv) throw notFound('Invitation not found or expired');
      let uid = auth?.user.id ?? null;
      if (!uid) {
        const existing = await one<{ id: string }>(db, 'SELECT id FROM users WHERE email=$1', [inv.email]);
        if (existing) throw conflict('このメールアドレスは登録済みです。ログインしてから招待リンクを開いてください');
        if (!b.name || !pwHash) throw badRequest('name and password are required');
        uid = (await one<{ id: string }>(db, 'INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [inv.email, b.name, pwHash]))!.id;
      }
      await db.query('INSERT INTO org_members(org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [inv.org_id, uid, inv.role]);
      if (inv.workspace_id)
        await db.query('INSERT INTO workspace_members(workspace_id, org_id, user_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role', [
          inv.workspace_id,
          inv.org_id,
          uid,
          inv.role,
        ]);
      await db.query('INSERT INTO user_prefs(user_id, org_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [uid, inv.org_id]);
      await db.query('UPDATE invitations SET accepted_at = now() WHERE id=$1', [inv.id]);
      // People records in this workspace with the same email are linked to the new user.
      if (inv.workspace_id) await db.query('UPDATE people SET user_id=$1 WHERE workspace_id=$2 AND lower(email)=lower($3) AND user_id IS NULL', [uid, inv.workspace_id, inv.email]);
      return uid;
    });
    if (!auth) await createSession(deps, userId, req, reply);
    return { ok: true };
  });

  // ---- org members (owner/admin)
  app.get('/api/orgs/:orgId/members', async (req) => {
    const auth = requireAuth(req);
    const { orgId } = parse(z.object({ orgId: z.string().uuid() }), req.params);
    return withSystem(deps.pool, async (db) => {
      const me = await one(db, 'SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2', [orgId, auth.user.id]);
      if (!me) throw notFound('Organization not found');
      const members = await rows(
        db,
        'SELECT u.id, u.email, u.name, om.role FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id=$1 ORDER BY u.name',
        [orgId],
      );
      return { members };
    });
  });

}
