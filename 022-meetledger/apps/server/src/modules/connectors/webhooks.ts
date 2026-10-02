import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import type { JobRow, Worker } from '../../jobs/queue';
import { permanentError } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import { safeEqual } from '../../lib/crypto';
import { notFound } from '../../lib/errors';
import { body, parse, wsIdParams, wsParams } from '../../lib/http';
import { requireAuth, tenantTx, workspaceCtx } from '../../rbac/access';
import { assertSafeOutboundUrl } from './netguard';
import { connectorSettings, openSecret, sealSecret } from './secrets';

// Outbound webhooks: admin-managed, HMAC-SHA256 signed, delivered by the job worker with retries.
// Payloads carry ids + minimal metadata (no transcript / notes / AI output); receivers fetch details with an API token.

export const WEBHOOK_EVENTS = [
  'meeting.created',
  'meeting.ready',
  'decision.confirmed',
  'decision.changed',
  'action.created',
  'action.updated',
  'commitment.updated',
  'followup.approved',
  'external_write.executed',
  'ping',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const SIGNATURE_HEADER = 'x-meetledger-signature';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` (Stripe-style; replay window enforced by receivers). */
export function signWebhook(secret: string, rawBody: string, unixSeconds: number): string {
  const sig = createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`).digest('hex');
  return `t=${unixSeconds},v1=${sig}`;
}

export function verifyWebhookSignature(secret: string, rawBody: string, header: string, nowSeconds: number, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSec || !parts.v1) return false;
  const expected = signWebhook(secret, rawBody, t).split('v1=')[1];
  return safeEqual(expected, parts.v1);
}

export const newSigningSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

function webhookDto(w: any) {
  let host = '';
  try {
    const u = new URL(w.url);
    host = `${u.protocol}//${u.host}${u.pathname.length > 1 ? '/…' : '/'}`;
  } catch {
    host = '[invalid]';
  }
  return {
    id: w.id,
    url: host,
    events: w.events,
    active: w.active,
    createdAt: new Date(w.created_at).toISOString(),
    lastDelivery: w.last_status ? { status: w.last_delivery_status, httpStatus: w.last_status, at: w.last_at ? new Date(w.last_at).toISOString() : null } : null,
  };
}

/**
 * Records an event for every active webhook subscribed to it and enqueues delivery jobs.
 * Call inside a tenant transaction (other modules: `emitWebhookEvent(db, deps, {orgId, workspaceId}, 'decision.confirmed', {decisionId, meetingId})`).
 * `dedupeKey` makes emission idempotent per webhook.
 */
export async function emitWebhookEvent(
  db: Db,
  deps: Pick<Deps, 'jobs' | 'clock'>,
  scope: { orgId: string; workspaceId: string },
  event: WebhookEvent,
  data: Record<string, unknown>,
  dedupeKey?: string,
): Promise<number> {
  const hooks = await rows<{ id: string }>(db, `SELECT id FROM webhooks WHERE workspace_id=$1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`, [scope.workspaceId, event]);
  let n = 0;
  for (const h of hooks) {
    const key = dedupeKey ?? `${event}:${deps.clock.now().getTime()}:${randomBytes(4).toString('hex')}`;
    const d = await one<{ id: string }>(
      db,
      `INSERT INTO webhook_deliveries(org_id, workspace_id, webhook_id, event, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (webhook_id, dedupe_key) DO NOTHING RETURNING id`,
      [scope.orgId, scope.workspaceId, h.id, event, JSON.stringify({ event, workspaceId: scope.workspaceId, data, createdAt: deps.clock.now().toISOString() }), key],
    );
    if (!d) continue;
    await deps.jobs.enqueue(db, { orgId: scope.orgId, type: 'webhooks.deliver', key: `webhook:${d.id}`, payload: { deliveryId: d.id }, maxAttempts: 5 });
    n++;
  }
  return n;
}

/** Job handler: delivers one webhook (re-validates the URL against SSRF rules right before sending; no redirects). */
export async function deliverWebhook(deps: Deps, job: JobRow) {
  const orgId = job.org_id!;
  const deliveryId = String(job.payload?.deliveryId ?? '');
  const d = await tenantTx(deps, orgId, (db) =>
    one<any>(db, `SELECT d.*, w.url, w.secret_ciphertext, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id=$1`, [deliveryId]),
  );
  if (!d || d.status === 'delivered') return { skipped: true };
  const finish = (status: 'pending' | 'delivered' | 'failed', httpStatus: string) =>
    tenantTx(deps, orgId, (db) =>
      db.query(`UPDATE webhook_deliveries SET status=$2, attempts=attempts+1, last_status=$3, delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END WHERE id=$1`, [
        deliveryId,
        status,
        httpStatus,
      ]),
    );
  if (!d.active) {
    await finish('failed', 'webhook_inactive');
    throw permanentError('webhook inactive');
  }
  try {
    await assertSafeOutboundUrl(d.url, connectorSettings(deps));
  } catch {
    await finish('failed', 'unsafe_url');
    throw permanentError('webhook URL rejected by SSRF guard');
  }
  const secret = openSecret<{ signingSecret: string }>(deps, d.secret_ciphertext)!.signingSecret;
  const raw = JSON.stringify({ id: d.id, ...d.payload });
  const t = Math.floor(deps.clock.now().getTime() / 1000);
  let res: Response;
  try {
    res = await deps.http.fetch({
      orgId,
      kind: 'webhook',
      provider: 'webhook',
      purpose: `webhook:${d.event}`,
      url: d.url,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'MeetLedger-Webhook/1.0',
          'x-meetledger-event': d.event,
          'x-meetledger-delivery': d.id,
          [SIGNATURE_HEADER]: signWebhook(secret, raw, t),
        },
        body: raw,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      },
    });
  } catch {
    const last = job.attempts >= job.max_attempts;
    await finish(last ? 'failed' : 'pending', 'network_error');
    throw new Error('webhook delivery network error');
  }
  if (res.status >= 200 && res.status < 300) {
    await finish('delivered', String(res.status));
    return { delivered: true, status: res.status };
  }
  const last = job.attempts >= job.max_attempts;
  await finish(last ? 'failed' : 'pending', String(res.status));
  throw new Error(`webhook delivery failed with HTTP ${res.status}`);
}

const createSchema = z.object({
  url: z.string().trim().min(8).max(2000),
  events: z.array(z.union([z.enum(WEBHOOK_EVENTS), z.literal('*')])).min(1).max(20),
  description: z.string().trim().max(200).optional(),
});

export function webhookRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/webhooks', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    return ctx.tx(async (db) => {
      const list = await rows<any>(
        db,
        `SELECT w.*, ld.last_status, ld.status AS last_delivery_status, ld.created_at AS last_at
           FROM webhooks w
           LEFT JOIN LATERAL (SELECT last_status, status, created_at FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY created_at DESC LIMIT 1) ld ON true
          WHERE w.workspace_id=$1 ORDER BY w.created_at DESC`,
        [workspaceId],
      );
      return { items: list.map(webhookDto), events: WEBHOOK_EVENTS };
    });
  });

  app.post('/api/w/:workspaceId/webhooks', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const b = body(req, createSchema);
    const u = await assertSafeOutboundUrl(b.url, connectorSettings(deps));
    const secret = newSigningSecret();
    return ctx.tx(async (db) => {
      const w = await one<any>(
        db,
        `INSERT INTO webhooks(org_id, workspace_id, url, secret_ciphertext, events, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.orgId, workspaceId, u.toString(), sealSecret(deps, { signingSecret: secret }), [...new Set(b.events)], ctx.userId],
      );
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'webhook.created', entityType: 'webhook', entityId: w.id, meta: { host: u.host, events: w.events } });
      // The signing secret is shown ONCE (stored encrypted, never returned again).
      return { webhook: webhookDto(w), signingSecret: secret, signatureHeader: SIGNATURE_HEADER };
    });
  });

  app.delete('/api/w/:workspaceId/webhooks/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    return ctx.tx(async (db) => {
      const r = await db.query('DELETE FROM webhooks WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!r.rowCount) throw notFound('Webhook not found');
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'webhook.deleted', entityType: 'webhook', entityId: id });
      return { ok: true };
    });
  });

  app.post('/api/w/:workspaceId/webhooks/:id/test', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    requireAuth(req);
    return ctx.tx(async (db) => {
      const w = await one<any>(db, 'SELECT * FROM webhooks WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!w) throw notFound('Webhook not found');
      const d = await one<{ id: string }>(
        db,
        `INSERT INTO webhook_deliveries(org_id, workspace_id, webhook_id, event, payload, dedupe_key) VALUES ($1,$2,$3,'ping',$4,$5) RETURNING id`,
        [ctx.orgId, workspaceId, id, JSON.stringify({ event: 'ping', workspaceId, data: { webhookId: id }, createdAt: deps.clock.now().toISOString() }), `ping:${deps.clock.now().getTime()}:${randomBytes(4).toString('hex')}`],
      );
      await deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'webhooks.deliver', key: `webhook:${d!.id}`, payload: { deliveryId: d!.id }, maxAttempts: 5 });
      return { deliveryId: d!.id, queued: true };
    });
  });

  app.get('/api/w/:workspaceId/webhooks/:id/deliveries', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    return ctx.tx(async (db) => {
      const list = await rows<any>(
        db,
        `SELECT d.id, d.event, d.status, d.attempts, d.last_status, d.created_at, d.delivered_at FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id WHERE d.webhook_id=$1 AND w.workspace_id=$2 ORDER BY d.created_at DESC LIMIT 100`,
        [id, workspaceId],
      );
      return {
        items: list.map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status,
          attempts: d.attempts,
          httpStatus: d.last_status,
          createdAt: new Date(d.created_at).toISOString(),
          deliveredAt: d.delivered_at ? new Date(d.delivered_at).toISOString() : null,
        })),
      };
    });
  });
}

export function webhookJobs(worker: Worker, deps: Deps) {
  worker.register('webhooks.deliver', (job) => deliverWebhook(deps, job));
}
