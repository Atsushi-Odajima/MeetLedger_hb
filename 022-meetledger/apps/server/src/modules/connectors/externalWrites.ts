import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { body, parse, query, wsIdParams, wsParams } from '../../lib/http';
import { loadMeeting, meetingVisibleSql, requireAuth, workspaceCtx } from '../../rbac/access';
import { roleAtLeast } from '@meetledger/shared';
import { assertSafeOutboundUrl } from './netguard';
import { accessTokenFor } from './oauth';
import { connectorSettings, maskUrl, openSecret, sha256Hex, stableStringify } from './secrets';
import { emitWebhookEvent, signWebhook, SIGNATURE_HEADER } from './webhooks';

// Every write to an external system is a two-phase operation:
//   1. POST /external-writes  → status 'pending_approval' with a full preview (target, rendered text, payload hash). Nothing is sent.
//   2. POST /external-writes/:id/approve (interactive web session only — never an API token / MCP) → executes EXACTLY ONCE.
// Approve claims the row (pending_approval → approved) under a row lock, so concurrent or repeated approvals never re-send.
// A partial unique index on (workspace_id, payload_hash) prevents creating a second live request for the same payload.

export const WRITE_PROVIDERS = ['slack', 'gmail', 'hubspot', 'webhook'] as const;
export type WriteProvider = (typeof WRITE_PROVIDERS)[number];
export const WRITE_KIND: Record<WriteProvider, string> = { slack: 'slack_message', gmail: 'gmail_draft', hubspot: 'hubspot_note', webhook: 'webhook_post' };
/** Write connectors shared by the workspace (created by an admin). Gmail is personal (the user's own mailbox). */
export const SHARED_WRITE_PROVIDERS: string[] = ['slack', 'hubspot', 'webhook'];

const HUBSPOT_ASSOC: Record<string, number> = { contact: 202, company: 190, deal: 214 }; // note→object HUBSPOT_DEFINED type ids (未検証)
const TEXT_LIMIT: Record<WriteProvider, number> = { slack: 40_000, gmail: 100_000, hubspot: 65_000, webhook: 100_000 };
const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

/** Slack mrkdwn escaping: prevents injected mentions (<!channel>, <@U…>) and links from meeting content. */
export const slackEscape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlEscape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface WriteInput {
  text: string;
  subject: string | null;
  to: string[];
  channel: string | null;
  objectType: string | null;
  objectId: string | null;
  meetingId: string | null;
  followupId: string | null;
}

export interface WritePreview {
  provider: WriteProvider;
  kind: string;
  target: string;
  subject: string | null;
  text: string;
  /** Provider request body WITHOUT secrets (shown to the approver). */
  payload: Record<string, unknown>;
  meetingId: string | null;
  followupId: string | null;
  warnings: string[];
  connectorName: string | null;
}

function buildPreview(connector: any, input: WriteInput): { preview: WritePreview; hashBasis: Record<string, unknown> } {
  const provider = connector.provider as WriteProvider;
  const kind = WRITE_KIND[provider];
  const cfg = connector.config ?? {};
  const text = input.text;
  if (!text.trim()) throw badRequest('Text is empty');
  if (text.length > TEXT_LIMIT[provider]) throw badRequest(`Text exceeds ${TEXT_LIMIT[provider]} characters`);
  const base = { provider, kind, subject: input.subject, text, meetingId: input.meetingId, followupId: input.followupId, warnings: [] as string[], connectorName: connector.display_name };
  switch (provider) {
    case 'slack': {
      if (cfg.mode === 'bot') {
        const channel = input.channel ?? cfg.defaultChannel ?? null;
        if (!channel || !/^[#]?[A-Za-z0-9][\w.-]{0,79}$/.test(channel)) throw badRequest('A Slack channel (ID or name) is required');
        const payload = { channel: channel.replace(/^#/, ''), text: slackEscape(input.subject ? `*${input.subject}*\n${text}` : text) };
        return { preview: { ...base, target: `Slack #${payload.channel}`, payload }, hashBasis: { channel: payload.channel } };
      }
      const payload = { text: slackEscape(input.subject ? `*${input.subject}*\n${text}` : text) };
      return { preview: { ...base, target: `Slack: ${cfg.channelLabel ?? 'Incoming Webhook（設定済みチャンネル）'}`, payload }, hashBasis: { channel: cfg.channelLabel ?? null } };
    }
    case 'gmail': {
      const to = [...new Set(input.to.map((t) => t.trim().toLowerCase()))];
      if (!to.length || to.length > 20 || !to.every((t) => EMAIL_RE.test(t))) throw badRequest('1-20 valid recipient addresses are required');
      const subject = input.subject ?? '';
      if (!subject.trim() || /[\r\n]/.test(subject) || subject.length > 200) throw badRequest('A single-line subject (max 200 chars) is required');
      return { preview: { ...base, target: `Gmail下書き → ${to.join(', ')}`, payload: { to, subject, text } }, hashBasis: { to } };
    }
    case 'hubspot': {
      const objectType = input.objectType ?? '';
      const objectId = input.objectId ?? '';
      if (!(objectType in HUBSPOT_ASSOC) || !/^\d{1,20}$/.test(objectId)) throw badRequest('HubSpot objectType (contact|company|deal) and numeric objectId are required');
      const noteBody = `${input.subject ? `<p><strong>${htmlEscape(input.subject)}</strong></p>` : ''}<p>${htmlEscape(text).replace(/\n/g, '<br>')}</p>`;
      const payload = {
        properties: { hs_note_body: noteBody },
        associations: [{ to: { id: objectId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOC[objectType] }] }],
      };
      return { preview: { ...base, target: `HubSpot ${objectType} ${objectId} へのノート`, payload }, hashBasis: { objectType, objectId } };
    }
    case 'webhook': {
      const payload = { event: 'external_write', subject: input.subject, text, meetingId: input.meetingId, followupId: input.followupId };
      return { preview: { ...base, target: `Webhook ${cfg.urlHint ?? ''}`.trim(), payload }, hashBasis: {} };
    }
  }
}

function rfc2822(to: string[], subject: string, text: string): string {
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const lines = [
    `To: ${to.join(', ')}`,
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

interface ExecResult {
  ok: boolean;
  result: Record<string, unknown>;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Executes the approved request via deps.http (kind 'connector'). Stores only ids / status codes, never response bodies. */
async function execute(deps: Deps, orgId: string, connector: any, preview: WritePreview, requestId: string): Promise<ExecResult> {
  const secret = openSecret<Record<string, any>>(deps, connector.secret_ciphertext);
  if (!secret) return { ok: false, result: { error: 'missing_credentials' } };
  const call = (url: string, init: RequestInit, purpose: string) =>
    deps.http.fetch({
      orgId,
      kind: 'connector',
      provider: connector.provider,
      purpose,
      url,
      meetingIds: preview.meetingId ? [preview.meetingId] : undefined,
      init: { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init },
    });
  const json = { 'content-type': 'application/json; charset=utf-8' };
  try {
    switch (connector.provider as WriteProvider) {
      case 'slack': {
        if (connector.config?.mode === 'bot') {
          const res = await call('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { ...json, authorization: `Bearer ${secret.botToken}` }, body: JSON.stringify(preview.payload) }, 'external_write:slack_message');
          const j = await safeJson(res);
          if (res.ok && j?.ok) return { ok: true, result: { ts: j.ts ?? null, channel: j.channel ?? null } };
          return { ok: false, result: { httpStatus: res.status, error: typeof j?.error === 'string' ? j.error.slice(0, 60) : 'slack_error' } };
        }
        const res = await call(secret.webhookUrl, { method: 'POST', headers: json, body: JSON.stringify(preview.payload) }, 'external_write:slack_message');
        return res.ok ? { ok: true, result: { httpStatus: res.status } } : { ok: false, result: { httpStatus: res.status } };
      }
      case 'gmail': {
        const token = await accessTokenFor(deps, orgId, connector);
        const p = preview.payload as { to: string[]; subject: string; text: string };
        const res = await call(
          'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
          { method: 'POST', headers: { ...json, authorization: `Bearer ${token}` }, body: JSON.stringify({ message: { raw: rfc2822(p.to, p.subject, p.text) } }) },
          'external_write:gmail_draft',
        );
        const j = await safeJson(res);
        return res.ok ? { ok: true, result: { draftId: j?.id ?? null } } : { ok: false, result: { httpStatus: res.status } };
      }
      case 'hubspot': {
        const body = { ...preview.payload, properties: { ...(preview.payload.properties as object), hs_timestamp: deps.clock.now().toISOString() } };
        const res = await call('https://api.hubapi.com/crm/v3/objects/notes', { method: 'POST', headers: { ...json, authorization: `Bearer ${secret.accessToken}` }, body: JSON.stringify(body) }, 'external_write:hubspot_note');
        const j = await safeJson(res);
        return res.ok ? { ok: true, result: { noteId: j?.id ?? null } } : { ok: false, result: { httpStatus: res.status } };
      }
      case 'webhook': {
        await assertSafeOutboundUrl(secret.url, connectorSettings(deps));
        const raw = JSON.stringify({ id: requestId, ...preview.payload, createdAt: deps.clock.now().toISOString() });
        const t = Math.floor(deps.clock.now().getTime() / 1000);
        const res = await call(secret.url, { method: 'POST', headers: { ...json, 'x-meetledger-event': 'external_write', [SIGNATURE_HEADER]: signWebhook(secret.signingSecret, raw, t) }, body: raw }, 'external_write:webhook_post');
        return res.status >= 200 && res.status < 300 ? { ok: true, result: { httpStatus: res.status } } : { ok: false, result: { httpStatus: res.status } };
      }
    }
  } catch (e: any) {
    if (e instanceof AppError) return { ok: false, result: { error: e.code } };
    return { ok: false, result: { error: 'network_error' } };
  }
  return { ok: false, result: { error: 'unsupported_provider' } };
}

export function writeRequestDto(r: any) {
  const p = r.preview ?? {};
  return {
    id: r.id,
    connectorId: r.connector_id,
    provider: r.provider,
    kind: r.kind,
    target: r.target,
    status: r.status,
    preview: { subject: p.subject ?? null, text: p.text ?? '', payload: p.payload ?? {}, warnings: p.warnings ?? [], meetingId: p.meetingId ?? null, followupId: p.followupId ?? null, connectorName: p.connectorName ?? null },
    payloadHash: r.payload_hash,
    requestedBy: r.requested_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
    result: r.result ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

const createSchema = z.object({
  connectorId: z.string().uuid(),
  text: z.string().max(100_000).optional(),
  subject: z.string().max(200).optional(),
  followupId: z.string().uuid().optional(),
  meetingId: z.string().uuid().optional(),
  to: z.array(z.string().trim().max(254)).max(20).default([]),
  channel: z.string().trim().max(80).optional(),
  objectType: z.enum(['contact', 'company', 'deal']).optional(),
  objectId: z.string().trim().max(40).optional(),
  acknowledgeConfidential: z.boolean().default(false),
});

/** Visibility of a request for the caller: own requests; admins also see others' (unless they reference a meeting the admin cannot see). */
function visibleRequestSql(alias: string, userParam: string, adminParam: string) {
  return `(${alias}.requested_by = ${userParam} OR (${adminParam}::boolean AND (${alias}.preview->>'meetingId' IS NULL OR EXISTS (
            SELECT 1 FROM meetings vm WHERE vm.id = (${alias}.preview->>'meetingId')::uuid AND ${meetingVisibleSql('vm', userParam)}))))`;
}

async function loadRequest(db: Db, ctx: WsCtx, id: string, lock = false) {
  const isAdmin = roleAtLeast(ctx.role, 'admin');
  const r = await one<any>(
    db,
    `SELECT r.* FROM external_write_requests r WHERE r.id=$1 AND r.workspace_id=$2 AND ${visibleRequestSql('r', '$3', '$4')} ${lock ? 'FOR UPDATE' : ''}`,
    [id, ctx.workspaceId, ctx.userId, isAdmin],
  );
  if (!r) throw notFound('Request not found');
  return r;
}

export function externalWriteRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/external-writes', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ status: z.enum(['pending_approval', 'approved', 'executed', 'rejected', 'failed', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
    return ctx.tx(async (db) => {
      const params: unknown[] = [workspaceId, ctx.userId, roleAtLeast(ctx.role, 'admin'), q.limit];
      let where = `r.workspace_id=$1 AND ${visibleRequestSql('r', '$2', '$3')}`;
      if (q.status) {
        params.push(q.status);
        where += ` AND r.status=$${params.length}`;
      }
      const list = await rows<any>(db, `SELECT r.* FROM external_write_requests r WHERE ${where} ORDER BY r.created_at DESC LIMIT $4`, params);
      return { items: list.map(writeRequestDto) };
    });
  });

  app.post('/api/w/:workspaceId/external-writes', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, createSchema);
    if (!b.text && !b.followupId) throw badRequest('text or followupId is required');
    return ctx.tx(async (db) => {
      const connector = await one<any>(db, `SELECT * FROM connector_accounts WHERE id=$1 AND workspace_id=$2 AND status='active'`, [b.connectorId, workspaceId]);
      if (!connector || !(WRITE_PROVIDERS as readonly string[]).includes(connector.provider)) throw notFound('Connector not found');
      if (!SHARED_WRITE_PROVIDERS.includes(connector.provider) && connector.user_id !== ctx.userId) throw notFound('Connector not found');
      let text = b.text ?? '';
      let subject = b.subject ?? null;
      let meetingId = b.meetingId ?? null;
      if (b.followupId) {
        // Follow-up drafts (followup module) are sent only through this approval flow. Meeting ACL applies.
        const f = await one<any>(
          db,
          `SELECT f.id, f.meeting_id, f.subject, f.body, f.status FROM followup_drafts f JOIN meetings m ON m.id = f.meeting_id
            WHERE f.id=$1 AND m.workspace_id=$2 AND ${meetingVisibleSql('m', '$3')}`,
          [b.followupId, workspaceId, ctx.userId],
        );
        if (!f) throw notFound('Follow-up draft not found');
        if (f.status === 'discarded') throw badRequest('Follow-up draft was discarded');
        text = b.text ?? f.body;
        subject = b.subject ?? f.subject;
        meetingId = f.meeting_id;
      }
      const warnings: string[] = [];
      if (meetingId) {
        const m = await loadMeeting(db, ctx, meetingId, 'read');
        if (m.is_confidential) {
          warnings.push('confidential_meeting');
          if (!b.acknowledgeConfidential) throw conflict('This content comes from a Confidential meeting. Set acknowledgeConfidential to continue.', { code: 'confidential_ack_required' });
        }
      }
      const { preview, hashBasis } = buildPreview(connector, {
        text,
        subject,
        to: b.to,
        channel: b.channel ?? null,
        objectType: b.objectType ?? null,
        objectId: b.objectId ?? null,
        meetingId,
        followupId: b.followupId ?? null,
      });
      preview.warnings.push(...warnings);
      const payloadHash = sha256Hex(stableStringify({ connectorId: connector.id, kind: preview.kind, subject: preview.subject, text: preview.text, ...hashBasis }));
      const existing = await one<any>(
        db,
        `SELECT * FROM external_write_requests WHERE workspace_id=$1 AND payload_hash=$2 AND status IN ('pending_approval','approved','executed')`,
        [workspaceId, payloadHash],
      );
      if (existing) return { request: writeRequestDto(existing), deduplicated: true };
      await db.query('SAVEPOINT ewr');
      try {
        const r = await one<any>(
          db,
          `INSERT INTO external_write_requests(org_id, workspace_id, connector_id, provider, kind, target, preview, payload_hash, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [ctx.orgId, workspaceId, connector.id, connector.provider, preview.kind, preview.target, JSON.stringify(preview), payloadHash, ctx.userId],
        );
        await db.query('RELEASE SAVEPOINT ewr');
        if (b.followupId) await db.query('UPDATE followup_drafts SET external_write_id=$2 WHERE id=$1', [b.followupId, r.id]);
        await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'external_write.requested', entityType: 'external_write', entityId: r.id, meta: { provider: connector.provider, kind: preview.kind } });
        return { request: writeRequestDto(r), deduplicated: false };
      } catch (e: any) {
        await db.query('ROLLBACK TO SAVEPOINT ewr');
        if (e?.code !== '23505') throw e;
        const again = await one<any>(db, `SELECT * FROM external_write_requests WHERE workspace_id=$1 AND payload_hash=$2 AND status IN ('pending_approval','approved','executed')`, [workspaceId, payloadHash]);
        return { request: writeRequestDto(again), deduplicated: true };
      }
    });
  });

  app.post('/api/w/:workspaceId/external-writes/:id/approve', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const auth = requireAuth(req);
    // Approval is a human decision in the web UI: API tokens (incl. MCP clients) can never approve/send.
    if (auth.via !== 'session') throw forbidden('External writes can only be approved from an interactive session');
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    // Phase 1: claim (pending_approval → approved). Row lock ⇒ exactly one approver wins.
    const claimed = await ctx.tx(async (db) => {
      const r = await loadRequest(db, ctx, id, true);
      if (r.requested_by !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw forbidden('Only the requester or an admin can approve');
      if (r.status === 'executed') return { already: r };
      if (r.status !== 'pending_approval') throw conflict(`Request is ${r.status}`, { status: r.status });
      const u = await one<any>(db, `UPDATE external_write_requests SET status='approved', approved_by=$2, approved_at=$3 WHERE id=$1 AND status='pending_approval' RETURNING *`, [
        id,
        ctx.userId,
        deps.clock.now(),
      ]);
      const connector = r.connector_id ? await one<any>(db, `SELECT * FROM connector_accounts WHERE id=$1 AND status='active'`, [r.connector_id]) : null;
      return { row: u, connector };
    });
    if ('already' in claimed) return { request: writeRequestDto(claimed.already), executed: false, alreadyExecuted: true };
    const { row, connector } = claimed as { row: any; connector: any };
    // Phase 2: execute once, outside the transaction.
    const outcome: ExecResult = connector ? await execute(deps, ctx.orgId, connector, row.preview as WritePreview, row.id) : { ok: false, result: { error: 'connector_unavailable' } };
    // Phase 3: record the outcome (a failed request is terminal; create a new request to try again).
    const final = await ctx.tx(async (db) => {
      const f = await one<any>(db, `UPDATE external_write_requests SET status=$2, executed_at=$3, result=$4 WHERE id=$1 RETURNING *`, [
        id,
        outcome.ok ? 'executed' : 'failed',
        outcome.ok ? deps.clock.now() : null,
        JSON.stringify(outcome.result),
      ]);
      await audit(db, {
        orgId: ctx.orgId,
        workspaceId,
        userId: ctx.userId,
        action: outcome.ok ? 'external_write.executed' : 'external_write.failed',
        entityType: 'external_write',
        entityId: id,
        meta: { provider: row.provider, kind: row.kind },
      });
      if (outcome.ok) await emitWebhookEvent(db, deps, { orgId: ctx.orgId, workspaceId }, 'external_write.executed', { requestId: id, provider: row.provider, kind: row.kind }, `ewr:${id}`);
      return f;
    });
    return { request: writeRequestDto(final), executed: outcome.ok, alreadyExecuted: false };
  });

  app.post('/api/w/:workspaceId/external-writes/:id/reject', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    return ctx.tx(async (db) => {
      const r = await loadRequest(db, ctx, id, true);
      if (r.requested_by !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw forbidden('Only the requester or an admin can reject');
      if (r.status !== 'pending_approval') throw conflict(`Request is ${r.status}`, { status: r.status });
      const u = await one<any>(db, `UPDATE external_write_requests SET status='rejected', approved_by=$2, approved_at=$3 WHERE id=$1 RETURNING *`, [id, ctx.userId, deps.clock.now()]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'external_write.rejected', entityType: 'external_write', entityId: id, meta: { provider: r.provider } });
      return { request: writeRequestDto(u) };
    });
  });
}

export { maskUrl };
