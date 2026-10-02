// Notification inbox (user-level across organizations) and per-organization notification preferences.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps, WsCtx } from '../../context';
import { one, rows, withSystem, type Db } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';
import { body, iso, parse, query, wsParams, zIso, zUuid } from '../../lib/http';
import { requireScope } from '../../auth/sessions';
import { requireAuth, workspaceCtx } from '../../rbac/access';
import { hhmm, safeTz } from './util';

function notificationDto(n: any) {
  return {
    id: n.id,
    orgId: n.org_id,
    orgName: n.org_name ?? null,
    workspaceId: n.workspace_id,
    kind: n.kind,
    entityType: n.entity_type,
    entityId: n.entity_id,
    title: n.title,
    body: n.body,
    link: n.link,
    deliveredAt: iso(n.delivered_at),
    readAt: iso(n.read_at),
    createdAt: iso(n.created_at),
  };
}

export async function loadPrefs(db: Db, ctx: Pick<WsCtx, 'orgId' | 'userId' | 'user' | 'deps'>) {
  await db.query('INSERT INTO user_prefs(user_id, org_id, timezone) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ctx.userId, ctx.orgId, safeTz(ctx.user.timezone)]);
  const p = await one<any>(db, 'SELECT * FROM user_prefs WHERE user_id=$1 AND org_id=$2', [ctx.userId, ctx.orgId]);
  const u = await one<{ timezone: string }>(db, 'SELECT timezone FROM users WHERE id=$1', [ctx.userId]);
  const tz = safeTz(p.timezone_set ? p.timezone : (u?.timezone ?? ctx.user.timezone));
  return {
    timezone: tz,
    timezoneSource: p.timezone_set ? 'notification_settings' : 'profile',
    quietStartMin: p.quiet_start_min,
    quietEndMin: p.quiet_end_min,
    quietStart: hhmm(p.quiet_start_min),
    quietEnd: hhmm(p.quiet_end_min),
    emailEnabled: p.email_enabled,
    maxPerHour: p.max_per_hour,
    briefLeadMin: p.brief_lead_min,
    emailDriver: ctx.deps.config.EMAIL_DRIVER,
    updatedAt: iso(p.updated_at),
  };
}

const zHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export default async function notificationRoutes(app: FastifyInstance, deps: Deps) {
  // ---- inbox: the caller's own notifications only (system context filtered by user_id + current memberships)
  app.get('/api/notifications', async (req) => {
    const auth = requireAuth(req);
    requireScope(auth, 'read');
    const q = query(
      req,
      z.object({
        unread: z.enum(['0', '1', 'true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: zIso.optional(),
      }),
    );
    const unread = q.unread === '1' || q.unread === 'true';
    return withSystem(deps.pool, async (db) => {
      const params: unknown[] = [auth.user.id];
      const cond = [
        'n.user_id = $1',
        "n.status = 'delivered'",
        '(n.workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id))',
      ];
      // API tokens are pinned to one organization.
      if (auth.via === 'token') {
        params.push(auth.tokenOrgId);
        cond.push(`n.org_id = $${params.length}`);
      }
      const unreadCount = await one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM notifications n JOIN org_members om ON om.org_id = n.org_id AND om.user_id = n.user_id WHERE ${cond.join(' AND ')} AND n.read_at IS NULL`,
        params,
      );
      if (unread) cond.push('n.read_at IS NULL');
      if (q.before) {
        params.push(q.before);
        cond.push(`n.delivered_at < $${params.length}`);
      }
      params.push(q.limit + 1);
      const list = await rows(
        db,
        `SELECT n.*, o.name AS org_name FROM notifications n
           JOIN org_members om ON om.org_id = n.org_id AND om.user_id = n.user_id
           JOIN organizations o ON o.id = n.org_id
          WHERE ${cond.join(' AND ')}
          ORDER BY n.delivered_at DESC NULLS LAST, n.id DESC LIMIT $${params.length}`,
        params,
      );
      const page = list.slice(0, q.limit);
      const digestIds = page.filter((n) => n.kind === 'digest').map((n) => n.id);
      const children = digestIds.length
        ? await rows(db, 'SELECT id, digest_id, kind, title, link, entity_type, entity_id FROM notifications WHERE user_id = $1 AND digest_id = ANY($2::uuid[]) ORDER BY scheduled_for', [
            auth.user.id,
            digestIds,
          ])
        : [];
      return {
        items: page.map((n) => ({
          ...notificationDto(n),
          items:
            n.kind === 'digest'
              ? children.filter((c) => c.digest_id === n.id).map((c) => ({ id: c.id, kind: c.kind, title: c.title, link: c.link, entityType: c.entity_type, entityId: c.entity_id }))
              : undefined,
        })),
        unreadCount: unreadCount?.n ?? 0,
        nextCursor: list.length > q.limit ? iso(page[page.length - 1].delivered_at) : null,
      };
    });
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const auth = requireAuth(req);
    requireScope(auth, 'write');
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const now = deps.clock.now();
    return withSystem(deps.pool, async (db) => {
      const r = await db.query(
        `UPDATE notifications SET read_at = coalesce(read_at, $3) WHERE id = $1 AND user_id = $2 AND status = 'delivered' ${auth.via === 'token' ? 'AND org_id = $4' : ''} RETURNING id`,
        auth.via === 'token' ? [id, auth.user.id, now, auth.tokenOrgId] : [id, auth.user.id, now],
      );
      if (!r.rowCount) throw notFound('Notification not found');
      await db.query('UPDATE notifications SET read_at = coalesce(read_at, $3) WHERE digest_id = $1 AND user_id = $2', [id, auth.user.id, now]);
      return { ok: true };
    });
  });

  app.post('/api/notifications/read-all', async (req) => {
    const auth = requireAuth(req);
    requireScope(auth, 'write');
    const now = deps.clock.now();
    return withSystem(deps.pool, async (db) => {
      const r = await db.query(
        `UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL AND status IN ('delivered','digested') ${auth.via === 'token' ? 'AND org_id = $3' : ''}`,
        auth.via === 'token' ? [auth.user.id, now, auth.tokenOrgId] : [auth.user.id, now],
      );
      return { ok: true, updated: r.rowCount ?? 0 };
    });
  });

  // ---- preferences (per user per organization)
  app.get('/api/w/:workspaceId/notification-prefs', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx((db) => loadPrefs(db, ctx));
  });

  app.put('/api/w/:workspaceId/notification-prefs', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const auth = requireAuth(req);
    requireScope(auth, 'write');
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const b = body(
      req,
      z.object({
        /** null ⇒ follow the profile time zone again. */
        timezone: z.string().max(64).nullable().optional(),
        quietStartMin: z.number().int().min(0).max(1439).optional(),
        quietEndMin: z.number().int().min(0).max(1439).optional(),
        quietStart: zHHMM.optional(),
        quietEnd: zHHMM.optional(),
        emailEnabled: z.boolean().optional(),
        maxPerHour: z.number().int().min(1).max(60).optional(),
        briefLeadMin: z.number().int().min(0).max(1440).optional(),
      }),
    );
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone });
      } catch {
        throw badRequest('Unknown timezone');
      }
    }
    const qs = b.quietStart !== undefined ? toMin(b.quietStart) : b.quietStartMin;
    const qe = b.quietEnd !== undefined ? toMin(b.quietEnd) : b.quietEndMin;
    return ctx.tx(async (db) => {
      await loadPrefs(db, ctx);
      await db.query(
        `UPDATE user_prefs SET
            timezone = CASE WHEN $3::boolean THEN coalesce($4, timezone) ELSE timezone END,
            timezone_set = CASE WHEN $3::boolean THEN $4::text IS NOT NULL ELSE timezone_set END,
            quiet_start_min = coalesce($5, quiet_start_min), quiet_end_min = coalesce($6, quiet_end_min),
            email_enabled = coalesce($7, email_enabled), max_per_hour = coalesce($8, max_per_hour), brief_lead_min = coalesce($9, brief_lead_min),
            updated_at = now()
          WHERE user_id = $1 AND org_id = $2`,
        [ctx.userId, ctx.orgId, b.timezone !== undefined, b.timezone ?? null, qs ?? null, qe ?? null, b.emailEnabled ?? null, b.maxPerHour ?? null, b.briefLeadMin ?? null],
      );
      return loadPrefs(db, ctx);
    });
  });
}
