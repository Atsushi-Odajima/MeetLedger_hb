import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { roleAtLeast } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, withSystem, withTenant, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { body, parse, query, wsIdParams, wsParams, zIso } from '../../lib/http';
import { requireAuth, workspaceCtx } from '../../rbac/access';
import { CALENDAR_PROVIDERS, icsToEvents, fetchIcs, type CalendarRange, type ConnectorRow } from './calendar';
import { SHARED_WRITE_PROVIDERS } from './externalWrites';
import { assertSafeOutboundUrl } from './netguard';
import { exchangeCode, hashState, providerDef, revokeTokens, startAuthorization, type OAuthProvider } from './oauth';
import { connectorSettings, maskUrl, openSecret, sealSecret } from './secrets';
import { defaultRange, importEvents, listPreview, MAX_RANGE_DAYS, refreshConnector, storePreview } from './sync';
import { newSigningSecret, SIGNATURE_HEADER } from './webhooks';

const PROVIDER_LABEL: Record<string, string> = {
  google_calendar: 'Google Calendar',
  microsoft_calendar: 'Microsoft 365 / Outlook Calendar',
  ics: 'iCalendar (.ics)',
  slack: 'Slack',
  gmail: 'Gmail（下書き）',
  hubspot: 'HubSpot',
  webhook: 'Webhook',
};

/** Config keys that are safe to return (never credentials or full URLs). */
const SAFE_CONFIG_KEYS = ['autoImport', 'autoImportEnabledBy', 'autoImportEnabledAt', 'calendarId', 'mode', 'channelLabel', 'defaultChannel', 'urlHint', 'source'];

export function connectorDto(r: any, userId: string) {
  const cfg = r.config ?? {};
  return {
    id: r.id,
    provider: r.provider,
    kind: (CALENDAR_PROVIDERS as readonly string[]).includes(r.provider) ? 'calendar' : 'write',
    displayName: r.display_name ?? PROVIDER_LABEL[r.provider] ?? r.provider,
    status: r.status,
    scopes: r.scopes ?? [],
    owned: r.user_id === userId,
    shared: SHARED_WRITE_PROVIDERS.includes(r.provider),
    config: Object.fromEntries(Object.entries(cfg).filter(([k]) => SAFE_CONFIG_KEYS.includes(k))),
    hasCredentials: !!r.secret_ciphertext,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rangeFrom(deps: Deps, q: { from?: string; to?: string }): CalendarRange {
  const def = defaultRange(deps.clock.now());
  const from = q.from ? new Date(q.from) : def.from;
  const to = q.to ? new Date(q.to) : q.from ? new Date(from.getTime() + 31 * 86400_000) : def.to;
  if (!(to > from)) throw badRequest('`to` must be after `from`');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400_000) throw badRequest(`Range is limited to ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

async function loadConnector(db: Db, ctx: WsCtx, id: string, mode: 'owner' | 'owner_or_admin' | 'visible'): Promise<ConnectorRow & Record<string, any>> {
  const r = await one<any>(db, 'SELECT * FROM connector_accounts WHERE id=$1 AND workspace_id=$2', [id, ctx.workspaceId]);
  if (!r) throw notFound('Connector not found');
  const isOwner = r.user_id === ctx.userId;
  const isAdmin = roleAtLeast(ctx.role, 'admin');
  const shared = SHARED_WRITE_PROVIDERS.includes(r.provider);
  const ok = mode === 'owner' ? isOwner : mode === 'owner_or_admin' ? isOwner || isAdmin : isOwner || isAdmin || shared;
  // Personal calendar connectors are private to their owner (404 for everybody else).
  if (!ok) throw notFound('Connector not found');
  return r;
}

const rangeQuery = z.object({ from: zIso.optional(), to: zIso.optional() });

// (plain union: zod v4 discriminatedUnion does not allow the two Slack modes to share provider='slack')
const writeConnectorSchema = z.union([
  z.object({
    provider: z.literal('slack'),
    displayName: z.string().trim().min(1).max(100).optional(),
    mode: z.literal('incoming_webhook'),
    webhookUrl: z.string().trim().regex(/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/, 'Slack Incoming Webhook URL (https://hooks.slack.com/services/...) expected'),
    channelLabel: z.string().trim().max(80).optional(),
  }),
  z.object({
    provider: z.literal('slack'),
    displayName: z.string().trim().min(1).max(100).optional(),
    mode: z.literal('bot'),
    botToken: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]+$/, 'Slack bot token (xoxb-...) expected'),
    defaultChannel: z.string().trim().max(80).optional(),
  }),
  z.object({
    provider: z.literal('hubspot'),
    displayName: z.string().trim().min(1).max(100).optional(),
    accessToken: z.string().trim().min(10).max(500),
  }),
  z.object({
    provider: z.literal('webhook'),
    displayName: z.string().trim().min(1).max(100).optional(),
    url: z.string().trim().min(8).max(2000),
  }),
]);

function oauthRedirect(deps: Deps, reply: FastifyReply, params: Record<string, string>) {
  const q = new URLSearchParams(params).toString();
  return reply.redirect(`${deps.config.APP_ORIGIN.replace(/\/$/, '')}/settings/connectors?${q}`, 302);
}

export function connectorRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------- list / create / patch / delete
  app.get('/api/w/:workspaceId/connectors', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const isAdmin = roleAtLeast(ctx.role, 'admin');
    return ctx.tx(async (db) => {
      const list = await rows<any>(
        db,
        `SELECT * FROM connector_accounts WHERE workspace_id=$1 AND (user_id=$2 OR provider = ANY($3) OR $4::boolean) ORDER BY created_at`,
        [workspaceId, ctx.userId, SHARED_WRITE_PROVIDERS, isAdmin],
      );
      return {
        items: list.map((r) => connectorDto(r, ctx.userId)),
        available: {
          google_calendar: !!(deps.config.GOOGLE_CLIENT_ID && deps.config.GOOGLE_CLIENT_SECRET),
          microsoft_calendar: !!(deps.config.MICROSOFT_CLIENT_ID && deps.config.MICROSOFT_CLIENT_SECRET),
          gmail: !!(deps.config.GOOGLE_CLIENT_ID && deps.config.GOOGLE_CLIENT_SECRET),
          ics: true,
          slack: true,
          hubspot: true,
          webhook: true,
        },
      };
    });
  });

  /** Admin: register a shared write connector with pasted credentials (stored encrypted; never returned). */
  app.post('/api/w/:workspaceId/connectors', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const b = body(req, writeConnectorSchema);
    let secret: Record<string, unknown>;
    let config: Record<string, unknown> = {};
    let scopes: string[] = [];
    let signingSecret: string | undefined;
    if (b.provider === 'slack' && b.mode === 'incoming_webhook') {
      secret = { webhookUrl: b.webhookUrl };
      config = { mode: 'incoming_webhook', channelLabel: b.channelLabel ?? null };
      scopes = ['incoming-webhook'];
    } else if (b.provider === 'slack' && b.mode === 'bot') {
      secret = { botToken: b.botToken };
      config = { mode: 'bot', defaultChannel: b.defaultChannel ?? null };
      scopes = ['chat:write'];
    } else if (b.provider === 'hubspot') {
      secret = { accessToken: b.accessToken };
      scopes = ['crm.objects.contacts.write'];
    } else {
      const u = await assertSafeOutboundUrl((b as { url: string }).url, connectorSettings(deps));
      signingSecret = newSigningSecret();
      secret = { url: u.toString(), signingSecret };
      config = { urlHint: maskUrl(u.toString()) };
    }
    return ctx.tx(async (db) => {
      const r = await one<any>(
        db,
        `INSERT INTO connector_accounts(org_id, workspace_id, user_id, provider, display_name, status, scopes, secret_ciphertext, config)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8) RETURNING *`,
        [ctx.orgId, workspaceId, ctx.userId, b.provider, b.displayName ?? PROVIDER_LABEL[b.provider], scopes, sealSecret(deps, secret), config],
      );
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'connector.created', entityType: 'connector', entityId: r.id, meta: { provider: b.provider } });
      return { connector: connectorDto(r, ctx.userId), ...(signingSecret ? { signingSecret, signatureHeader: SIGNATURE_HEADER } : {}) };
    });
  });

  app.patch('/api/w/:workspaceId/connectors/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        displayName: z.string().trim().min(1).max(100).optional(),
        autoImport: z.boolean().optional(),
        calendarId: z.string().trim().min(1).max(300).optional(),
        channelLabel: z.string().trim().max(80).optional(),
        defaultChannel: z.string().trim().max(80).optional(),
      }),
    );
    return ctx.tx(async (db) => {
      const r = await loadConnector(db, ctx, id, 'owner_or_admin');
      const cfg = { ...(r.config ?? {}) };
      const isCalendar = (CALENDAR_PROVIDERS as readonly string[]).includes(r.provider);
      if (b.autoImport !== undefined) {
        // Automatic meeting creation is an admin decision (default OFF).
        if (!roleAtLeast(ctx.role, 'admin')) throw forbidden('Only admins can change automatic import');
        if (!isCalendar) throw badRequest('autoImport applies to calendar connectors only');
        cfg.autoImport = b.autoImport;
        cfg.autoImportEnabledBy = b.autoImport ? ctx.userId : null;
        cfg.autoImportEnabledAt = b.autoImport ? deps.clock.now().toISOString() : null;
      }
      if (b.calendarId !== undefined) {
        if (r.provider !== 'google_calendar' || r.user_id !== ctx.userId) throw badRequest('calendarId applies to your own Google Calendar connector');
        cfg.calendarId = b.calendarId;
      }
      if (b.channelLabel !== undefined || b.defaultChannel !== undefined) {
        if (r.provider !== 'slack' || !roleAtLeast(ctx.role, 'admin')) throw badRequest('Slack settings can only be changed by admins');
        if (b.channelLabel !== undefined) cfg.channelLabel = b.channelLabel;
        if (b.defaultChannel !== undefined) cfg.defaultChannel = b.defaultChannel;
      }
      const u = await one<any>(db, 'UPDATE connector_accounts SET display_name=coalesce($2, display_name), config=$3 WHERE id=$1 RETURNING *', [id, b.displayName ?? null, cfg]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'connector.updated', entityType: 'connector', entityId: id, meta: { fields: Object.keys(b) } });
      return { connector: connectorDto(u, ctx.userId) };
    });
  });

  app.delete('/api/w/:workspaceId/connectors/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const r = await ctx.tx((db) => loadConnector(db, ctx, id, 'owner_or_admin'));
    if (SHARED_WRITE_PROVIDERS.includes(r.provider) && !roleAtLeast(ctx.role, 'admin')) throw forbidden('Only admins can remove shared connectors');
    await revokeTokens(deps, ctx.orgId, r);
    await ctx.tx(async (db) => {
      await db.query('DELETE FROM connector_accounts WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'connector.deleted', entityType: 'connector', entityId: id, meta: { provider: r.provider } });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------- ICS (no OAuth)
  app.post('/api/w/:workspaceId/connectors/ics', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const settings = connectorSettings(deps);
    const b = body(
      req,
      z
        .object({
          url: z.string().trim().max(2000).optional(),
          content: z.string().max(20_000_000).optional(),
          name: z.string().trim().min(1).max(100).optional(),
          from: zIso.optional(),
          to: zIso.optional(),
        })
        .refine((v) => !!v.url !== !!v.content, { message: 'Provide exactly one of url or content' }),
    );
    const range = rangeFrom(deps, b);
    const tz = ctx.user.timezone || 'Asia/Tokyo';
    let text: string;
    let secret: Record<string, unknown> | null = null;
    let config: Record<string, unknown>;
    if (b.url) {
      const safe = await assertSafeOutboundUrl(b.url.replace(/^webcals?:\/\//i, 'https://'), settings);
      text = await fetchIcs(deps, ctx.orgId, safe.toString());
      // A private ICS address is effectively a password: stored encrypted, only a masked hint is shown.
      secret = { url: safe.toString() };
      config = { source: 'url', urlHint: maskUrl(safe.toString()) };
    } else {
      text = b.content!;
      config = { source: 'upload' };
    }
    const parsed = icsToEvents(text, range, tz, settings.icsMaxBytes);
    return ctx.tx(async (db) => {
      const r = await one<any>(
        db,
        `INSERT INTO connector_accounts(org_id, workspace_id, user_id, provider, display_name, status, scopes, secret_ciphertext, config, last_sync_at)
         VALUES ($1,$2,$3,'ics',$4,'active','{}',$5,$6,$7) RETURNING *`,
        [ctx.orgId, workspaceId, ctx.userId, b.name ?? parsed.calendarName ?? 'iCalendar', secret ? sealSecret(deps, secret) : null, config, deps.clock.now()],
      );
      await storePreview(db, r, range, parsed.events, deps.clock.now());
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'connector.created', entityType: 'connector', entityId: r.id, meta: { provider: 'ics', source: config.source } });
      return { connector: connectorDto(r, ctx.userId), range: { from: range.from.toISOString(), to: range.to.toISOString() }, truncated: !!parsed.truncated, events: await listPreview(db, ctx, r.id, range) };
    });
  });

  // ------------------------------------------------------------- OAuth (Google / Microsoft / Gmail)
  app.get('/api/w/:workspaceId/connectors/:id/start', async (req) => {
    const { workspaceId, id: provider } = parse(z.object({ workspaceId: z.string().uuid(), id: z.enum(['google_calendar', 'microsoft_calendar', 'gmail']) }), req.params);
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw forbidden('Connecting an account requires an interactive session');
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const q = query(req, z.object({ calendarList: z.enum(['0', '1']).optional() }));
    const r = await startAuthorization(deps, ctx, provider as OAuthProvider, { calendarList: q.calendarList === '1' });
    return { authorizeUrl: r.authorizeUrl, scopes: r.scopes, redirectUri: `${deps.config.APP_ORIGIN.replace(/\/$/, '')}/api/connectors/oauth/callback` };
  });

  // logLevel 'warn': the request URL carries the one-time authorization code — keep it out of the info request logs.
  app.get('/api/connectors/oauth/callback', { logLevel: 'warn' }, async (req, reply) => {
    const q = query(req, z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(100).optional() }));
    const auth = (req as any).auth;
    if (!q.state) return oauthRedirect(deps, reply, { error: 'invalid_state' });
    // Auth lookup of the state (system context, by hash only) → then all work in the tenant context.
    const st = await withSystem(deps.pool, (db) => one<{ org_id: string }>(db, 'SELECT org_id FROM connector_oauth_states WHERE state_hash=$1', [hashState(q.state!)]));
    if (!st) return oauthRedirect(deps, reply, { error: 'invalid_state' });
    const row = await withTenant(deps.pool, st.org_id, (db) =>
      one<any>(db, `UPDATE connector_oauth_states SET used_at=now() WHERE state_hash=$1 AND used_at IS NULL AND expires_at > $2 RETURNING *`, [hashState(q.state!), deps.clock.now()]),
    );
    if (!row) return oauthRedirect(deps, reply, { error: 'invalid_state' });
    // The browser that finishes the flow must be the same logged-in user who started it (prevents account-linking CSRF).
    if (!auth || auth.via !== 'session' || auth.user.id !== row.user_id) {
      await withTenant(deps.pool, row.org_id, (db) =>
        audit(db, { orgId: row.org_id, workspaceId: row.workspace_id, userId: auth?.user?.id ?? null, action: 'connector.oauth_state_mismatch', meta: { provider: row.provider } }),
      );
      return oauthRedirect(deps, reply, { error: 'invalid_state' });
    }
    if (q.error || !q.code) return oauthRedirect(deps, reply, { error: q.error === 'access_denied' ? 'access_denied' : 'authorization_failed' });
    let ctx: WsCtx;
    try {
      ctx = await workspaceCtx(deps, req, row.workspace_id, 'member');
    } catch {
      return oauthRedirect(deps, reply, { error: 'forbidden' });
    }
    const provider = row.provider as OAuthProvider;
    const def = providerDef(deps, provider, { calendarList: (row.scopes ?? []).length > 1 });
    def.scopes = row.scopes;
    let exchanged;
    try {
      const verifier = openSecret<{ v: string }>(deps, row.verifier_ciphertext)!.v;
      exchanged = await exchangeCode(deps, row.org_id, def, q.code, verifier, row.redirect_uri, row.scopes);
    } catch (e) {
      return oauthRedirect(deps, reply, { error: e instanceof AppError ? e.code : 'token_exchange_failed' });
    }
    const { tokens, scopes } = exchanged;
    const connectorId = await ctx.tx(async (db) => {
      const sealed = sealSecret(deps, tokens as unknown as Record<string, unknown>);
      const existing = await one<{ id: string }>(db, `SELECT id FROM connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND provider=$3 ORDER BY created_at LIMIT 1`, [
        row.workspace_id,
        ctx.userId,
        provider,
      ]);
      const expires = tokens.expiresAt ? new Date(tokens.expiresAt) : null;
      const id = existing
        ? (await one<{ id: string }>(db, `UPDATE connector_accounts SET secret_ciphertext=$2, scopes=$3, status='active', last_error=NULL, expires_at=$4 WHERE id=$1 RETURNING id`, [existing.id, sealed, scopes, expires]))!.id
        : (
            await one<{ id: string }>(
              db,
              `INSERT INTO connector_accounts(org_id, workspace_id, user_id, provider, display_name, status, scopes, secret_ciphertext, config, expires_at)
               VALUES ($1,$2,$3,$4,$5,'active',$6,$7,'{}',$8) RETURNING id`,
              [row.org_id, row.workspace_id, ctx.userId, provider, PROVIDER_LABEL[provider], scopes, sealed, expires],
            )
          )!.id;
      await audit(db, { orgId: row.org_id, workspaceId: row.workspace_id, userId: ctx.userId, action: 'connector.connected', entityType: 'connector', entityId: id, meta: { provider, scopes } });
      return id;
    });
    return oauthRedirect(deps, reply, { connected: provider, connectorId });
  });

  // ------------------------------------------------------------- preview / sync / import (owner only)
  app.post('/api/w/:workspaceId/connectors/:id/sync', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const settings = connectorSettings(deps);
    const b = body(req, z.object({ from: zIso.optional(), to: zIso.optional(), content: z.string().max(20_000_000).optional() }));
    const range = rangeFrom(deps, b);
    const r = await ctx.tx((db) => loadConnector(db, ctx, id, 'owner'));
    if (!(CALENDAR_PROVIDERS as readonly string[]).includes(r.provider)) throw badRequest('Not a calendar connector');
    const tz = ctx.user.timezone || 'Asia/Tokyo';
    let truncated = false;
    if (r.provider === 'ics' && r.config?.source === 'upload') {
      // Upload-based ICS: refreshing means uploading the file again (the file itself is not stored).
      if (b.content) {
        const parsed = icsToEvents(b.content, range, tz, settings.icsMaxBytes);
        truncated = !!parsed.truncated;
        await ctx.tx(async (db) => {
          await storePreview(db, r, range, parsed.events, deps.clock.now());
          await db.query('UPDATE connector_accounts SET last_sync_at=$2, last_error=NULL WHERE id=$1', [id, deps.clock.now()]);
        });
      }
    } else {
      truncated = (await refreshConnector(deps, r, range, tz)).truncated;
    }
    return ctx.tx(async (db) => ({ range: { from: range.from.toISOString(), to: range.to.toISOString() }, truncated, events: await listPreview(db, ctx, id, range) }));
  });

  app.get('/api/w/:workspaceId/connectors/:id/events', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const range = rangeFrom(deps, query(req, rangeQuery));
    return ctx.tx(async (db) => {
      await loadConnector(db, ctx, id, 'owner');
      return { range: { from: range.from.toISOString(), to: range.to.toISOString() }, events: await listPreview(db, ctx, id, range) };
    });
  });

  app.post('/api/w/:workspaceId/connectors/:id/import', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        eventIds: z.array(z.string().uuid()).min(1).max(200),
        visibility: z.enum(['private', 'workspace', 'selected']).optional(),
        meetingType: z.enum(['sales', 'client', 'internal', 'one_on_one', 'project', 'interview', 'workshop', 'other']).optional(),
        projectId: z.string().uuid().nullable().optional(),
      }),
    );
    return ctx.tx(async (db) => {
      const r = await loadConnector(db, ctx, id, 'owner');
      if (!(CALENDAR_PROVIDERS as readonly string[]).includes(r.provider)) throw badRequest('Not a calendar connector');
      return importEvents(db, ctx, id, b.eventIds, { visibility: b.visibility, meetingType: b.meetingType, projectId: b.projectId ?? null });
    });
  });
}
