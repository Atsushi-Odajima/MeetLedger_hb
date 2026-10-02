import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, rows, withSystem } from '../src/db/pool';
import { isPrivateAddress } from '../src/modules/connectors/netguard';
import { verifyWebhookSignature } from '../src/modules/connectors/webhooks';
import { createTestEnv, type Client, type TestEnv } from './helpers';
import { bearer, createApiToken, fakeDns, json, routeResponder } from './connectors-helpers';

let env: TestEnv;
let owner: Client;
let ws: string;
let orgId: string;
let member: { client: Client; userId: string };
let viewer: { client: Client; userId: string };

beforeAll(async () => {
  env = await createTestEnv();
  const o = await env.setupOwner('owner@example.com');
  owner = o.client;
  ws = o.workspaceId;
  orgId = o.orgId;
  member = await env.addUser(owner, orgId, ws, 'member@example.com', 'member');
  viewer = await env.addUser(owner, orgId, ws, 'viewer@example.com', 'viewer');
  fakeDns({
    'hooks.example.com': ['93.184.216.34'],
    'rebind.example.com': ['93.184.216.35'],
    'private.example.com': ['192.168.1.10'],
    'v6private.example.com': ['fd00::1'],
    'mixed.example.com': ['93.184.216.36', '127.0.0.1'],
  });
});
afterAll(async () => env?.close());

const slackCalls = () => env.http.calls.filter((c) => c.url.startsWith('https://hooks.slack.com/'));

describe('external writes: preview + explicit approval, executed exactly once', () => {
  let slackId: string;

  it('admin registers a Slack incoming webhook connector; credentials are encrypted and never returned', async () => {
    const hook = 'https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX';
    expect((await member.client.post(`/api/w/${ws}/connectors`, { provider: 'slack', mode: 'incoming_webhook', webhookUrl: hook })).status).toBe(403);
    const r = await owner.post(`/api/w/${ws}/connectors`, { provider: 'slack', mode: 'incoming_webhook', webhookUrl: hook, channelLabel: '#sales' });
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain('XXXXSECRETXXXX');
    slackId = r.body.connector.id;
    const row = await withSystem(env.pool, (db) => one<any>(db, 'SELECT secret_ciphertext, config FROM connector_accounts WHERE id=$1', [slackId]));
    expect(row.secret_ciphertext).not.toContain('XXXXSECRETXXXX');
    expect(JSON.stringify(row.config)).not.toContain('XXXXSECRETXXXX');
    // shared write connector is visible to members, without credentials
    const list = await member.client.get(`/api/w/${ws}/connectors`);
    expect(list.body.items.find((c: any) => c.id === slackId).shared).toBe(true);
    expect(list.raw).not.toContain('XXXXSECRETXXXX');
  });

  it('#20 connector write requires approval: no external call before approve; exactly one after; re-approve does not resend; reject → none', async () => {
    env.http.responder = routeResponder({ 'https://hooks.slack.com/services/': () => new Response('ok', { status: 200 }) });
    const text = '決定事項: 価格は据え置き <!channel> @here';
    const created = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: slackId, text });
    expect(created.status).toBe(200);
    const req = created.body.request;
    expect(req.status).toBe('pending_approval');
    expect(req.target).toBe('Slack: #sales');
    expect(req.preview.text).toBe(text);
    expect(req.preview.payload.text).toBe('決定事項: 価格は据え置き &lt;!channel&gt; @here'); // mention injection neutralized
    expect(req.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(slackCalls()).toHaveLength(0); // nothing sent yet

    // the same payload cannot be queued twice
    const dup = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: slackId, text });
    expect(dup.body.deduplicated).toBe(true);
    expect(dup.body.request.id).toBe(req.id);

    // API tokens (MCP / integrations) can never approve
    const token = await createApiToken(member.client, ws, ['read', 'write']);
    expect((await bearer(env, token).post(`/api/w/${ws}/external-writes/${req.id}/approve`)).status).toBe(403);
    // viewers / other members cannot approve someone else's request
    expect((await viewer.client.post(`/api/w/${ws}/external-writes/${req.id}/approve`)).status).toBe(403);
    const m2 = await env.addUser(owner, orgId, ws, 'member2@example.com', 'member');
    expect((await m2.client.post(`/api/w/${ws}/external-writes/${req.id}/approve`)).status).toBe(404);
    expect(slackCalls()).toHaveLength(0);

    // concurrent approvals → exactly one external call
    const [a1, a2] = await Promise.all([member.client.post(`/api/w/${ws}/external-writes/${req.id}/approve`), member.client.post(`/api/w/${ws}/external-writes/${req.id}/approve`)]);
    expect([a1.status, a2.status].sort()).toEqual([200, 409]);
    expect(slackCalls()).toHaveLength(1);
    const sent = slackCalls()[0];
    expect(sent.kind).toBe('connector');
    expect(JSON.parse(String(sent.init?.body))).toEqual({ text: '決定事項: 価格は据え置き &lt;!channel&gt; @here' });

    // approving again later does not resend
    const again = await member.client.post(`/api/w/${ws}/external-writes/${req.id}/approve`);
    expect(again.status).toBe(200);
    expect(again.body.alreadyExecuted).toBe(true);
    expect(again.body.request.status).toBe('executed');
    expect(slackCalls()).toHaveLength(1);
    // executed payload cannot be re-queued either
    expect((await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: slackId, text })).body.deduplicated).toBe(true);

    // reject → never sent
    const r2 = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: slackId, text: 'もう一件' });
    const rej = await member.client.post(`/api/w/${ws}/external-writes/${r2.body.request.id}/reject`);
    expect(rej.body.request.status).toBe('rejected');
    expect((await member.client.post(`/api/w/${ws}/external-writes/${r2.body.request.id}/approve`)).status).toBe(409);
    expect(slackCalls()).toHaveLength(1);

    const audit = await withSystem(env.pool, (db) => rows<any>(db, `SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at`, [req.id]));
    expect(audit.map((a) => a.action)).toEqual(['external_write.requested', 'external_write.executed']);
  });

  it('failed delivery is recorded and terminal (no automatic resend)', async () => {
    env.http.responder = routeResponder({ 'https://hooks.slack.com/services/': () => new Response('no_service', { status: 404 }) });
    const r = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: slackId, text: 'will fail' });
    const a = await member.client.post(`/api/w/${ws}/external-writes/${r.body.request.id}/approve`);
    expect(a.body.executed).toBe(false);
    expect(a.body.request.status).toBe('failed');
    expect(a.body.request.result).toEqual({ httpStatus: 404 });
    const n = slackCalls().length;
    expect((await member.client.post(`/api/w/${ws}/external-writes/${r.body.request.id}/approve`)).status).toBe(409);
    expect(slackCalls().length).toBe(n);
  });

  it('Slack bot (chat.postMessage), HubSpot note and confidential-meeting acknowledgement', async () => {
    env.http.responder = routeResponder({
      'https://slack.com/api/chat.postMessage': json({ ok: true, ts: '1700000000.0001', channel: 'C123' }),
      'https://api.hubapi.com/crm/v3/objects/notes': json({ id: '987654' }, 201),
    });
    const bot = await owner.post(`/api/w/${ws}/connectors`, { provider: 'slack', mode: 'bot', botToken: 'xoxb-1-2-SECRETBOT', defaultChannel: 'C123' });
    const hs = await owner.post(`/api/w/${ws}/connectors`, { provider: 'hubspot', accessToken: 'pat-na1-SECRET-HUBSPOT' });
    const m = await member.client.post(`/api/w/${ws}/meetings`, { title: 'Board', isConfidential: true });
    const noAck = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: bot.body.connector.id, text: 'recap', meetingId: m.body.id });
    expect(noAck.status).toBe(409);
    const w1 = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: bot.body.connector.id, text: 'recap', meetingId: m.body.id, acknowledgeConfidential: true });
    expect(w1.body.request.preview.warnings).toContain('confidential_meeting');
    expect(w1.body.request.target).toBe('Slack #C123');
    const a1 = await member.client.post(`/api/w/${ws}/external-writes/${w1.body.request.id}/approve`);
    expect(a1.body.request.status).toBe('executed');
    expect(a1.body.request.result).toEqual({ ts: '1700000000.0001', channel: 'C123' });
    const botCall = env.http.calls.find((c) => c.url === 'https://slack.com/api/chat.postMessage')!;
    expect((botCall.init?.headers as any).authorization).toBe('Bearer xoxb-1-2-SECRETBOT');
    expect(botCall.meetingIds).toEqual([m.body.id]);

    const w2 = await member.client.post(`/api/w/${ws}/external-writes`, { connectorId: hs.body.connector.id, text: '次回までに見積\n<b>x</b>', objectType: 'contact', objectId: '1234' });
    expect(w2.body.request.preview.payload.properties.hs_note_body).toBe('<p>次回までに見積<br>&lt;b&gt;x&lt;/b&gt;</p>');
    const a2 = await member.client.post(`/api/w/${ws}/external-writes/${w2.body.request.id}/approve`);
    expect(a2.body.request.result).toEqual({ noteId: '987654' });
    const hsCall = env.http.calls.find((c) => c.url === 'https://api.hubapi.com/crm/v3/objects/notes')!;
    const hsBody = JSON.parse(String(hsCall.init?.body));
    expect(hsBody.associations[0].to.id).toBe('1234');
    expect(hsBody.properties.hs_timestamp).toBeTruthy();
    // list: own requests for members; never includes credentials
    const list = await member.client.get(`/api/w/${ws}/external-writes`);
    expect(list.body.items.length).toBeGreaterThanOrEqual(4);
    expect(list.raw).not.toMatch(/SECRETBOT|SECRET-HUBSPOT|XXXXSECRET/);
    expect((await viewer.client.get(`/api/w/${ws}/external-writes`)).body.items).toHaveLength(0);
  });
});

describe('outbound webhooks: SSRF guard + HMAC signature + retries', () => {
  it('address classification covers private, loopback, link-local, CGNAT, ULA and mapped IPv6', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.0.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('webhook URLs must be https and must not target private ranges (unless explicitly allowed by env)', async () => {
    const bad = [
      'http://hooks.example.com/x',
      'ftp://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://2130706433/x', // 127.0.0.1 in decimal
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5:8443/x',
      'https://localhost/x',
      'https://metadata.google.internal/x',
      'https://private.example.com/x',
      'https://v6private.example.com/x',
      'https://mixed.example.com/x',
      'https://user:pass@hooks.example.com/x',
      'https://unknown-host.example.com/x',
    ];
    for (const url of bad) {
      const r = await owner.post(`/api/w/${ws}/webhooks`, { url, events: ['meeting.ready'] });
      expect(r.status, url).toBe(400);
    }
    // members cannot manage webhooks
    expect((await member.client.post(`/api/w/${ws}/webhooks`, { url: 'https://hooks.example.com/x', events: ['meeting.ready'] })).status).toBe(403);
    // explicit opt-in for private targets (self-hosted intranet receivers)
    (env.config as any).CONNECTOR_ALLOW_PRIVATE_NETWORKS = '1';
    const allowed = await owner.post(`/api/w/${ws}/webhooks`, { url: 'https://private.example.com/hook', events: ['meeting.ready'] });
    expect(allowed.status).toBe(200);
    delete (env.config as any).CONNECTOR_ALLOW_PRIVATE_NETWORKS;
    await owner.del(`/api/w/${ws}/webhooks/${allowed.body.webhook.id}`);
  });

  it('deliveries are HMAC-SHA256 signed, secret shown once and stored encrypted, retried on failure, re-validated before sending', async () => {
    const created = await owner.post(`/api/w/${ws}/webhooks`, { url: 'https://hooks.example.com/meetledger', events: ['meeting.ready', 'decision.confirmed'] });
    expect(created.status).toBe(200);
    const secret = created.body.signingSecret as string;
    expect(secret).toMatch(/^whsec_/);
    const id = created.body.webhook.id;
    const row = await withSystem(env.pool, (db) => one<any>(db, 'SELECT secret_ciphertext FROM webhooks WHERE id=$1', [id]));
    expect(row.secret_ciphertext).not.toContain(secret);
    const list = await owner.get(`/api/w/${ws}/webhooks`);
    expect(list.raw).not.toContain(secret);

    let attempts = 0;
    env.http.responder = routeResponder({
      'https://hooks.example.com/meetledger': () => (++attempts === 1 ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 })),
    });
    // emit through the public API used by other modules
    const { emitWebhookEvent } = await import('../src/modules/connectors');
    await env.tenantTx(orgId, (db) => emitWebhookEvent(db, env.deps, { orgId, workspaceId: ws }, 'decision.confirmed', { decisionId: 'd-1', meetingId: 'm-1' }, 'decision.confirmed:d-1'));
    // same dedupe key → no second delivery
    await env.tenantTx(orgId, (db) => emitWebhookEvent(db, env.deps, { orgId, workspaceId: ws }, 'decision.confirmed', { decisionId: 'd-1', meetingId: 'm-1' }, 'decision.confirmed:d-1'));
    // not subscribed → nothing
    await env.tenantTx(orgId, (db) => emitWebhookEvent(db, env.deps, { orgId, workspaceId: ws }, 'action.updated', { actionId: 'a-1' }));
    await env.worker.drain();
    expect(attempts).toBe(1); // first attempt failed (503) → retried later with backoff
    let d = await owner.get(`/api/w/${ws}/webhooks/${id}/deliveries`);
    expect(d.body.items).toHaveLength(1);
    expect(d.body.items[0]).toMatchObject({ status: 'pending', httpStatus: '503', attempts: 1 });
    await withSystem(env.pool, (db) => db.query(`UPDATE jobs SET run_after = now() WHERE type='webhooks.deliver'`));
    await env.worker.drain();
    expect(attempts).toBe(2);
    d = await owner.get(`/api/w/${ws}/webhooks/${id}/deliveries`);
    expect(d.body.items[0]).toMatchObject({ status: 'delivered', httpStatus: '200', attempts: 2 });

    const call = env.http.calls.filter((c) => c.url === 'https://hooks.example.com/meetledger').at(-1)!;
    expect(call.kind).toBe('webhook');
    expect((call.init as any).redirect).toBe('manual');
    const headers = call.init?.headers as Record<string, string>;
    const raw = String(call.init?.body);
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ event: 'decision.confirmed', workspaceId: ws, data: { decisionId: 'd-1' } });
    expect(headers['x-meetledger-event']).toBe('decision.confirmed');
    const now = Math.floor(env.clock.now().getTime() / 1000);
    expect(verifyWebhookSignature(secret, raw, headers['x-meetledger-signature'], now)).toBe(true);
    expect(verifyWebhookSignature(secret, raw.replace('d-1', 'd-2'), headers['x-meetledger-signature'], now)).toBe(false);
    expect(verifyWebhookSignature('whsec_wrong', raw, headers['x-meetledger-signature'], now)).toBe(false);
    expect(verifyWebhookSignature(secret, raw, headers['x-meetledger-signature'], now + 3600)).toBe(false); // replay window

    // DNS rebinding: the host now resolves to a private address → delivery refused permanently, nothing sent
    const reb = await owner.post(`/api/w/${ws}/webhooks`, { url: 'https://rebind.example.com/hook', events: ['ping'] });
    fakeDns({ 'hooks.example.com': ['93.184.216.34'], 'rebind.example.com': ['127.0.0.1'] });
    const before = env.http.calls.length;
    const t = await owner.post(`/api/w/${ws}/webhooks/${reb.body.webhook.id}/test`);
    expect(t.status).toBe(200);
    await env.worker.drain();
    expect(env.http.calls.length).toBe(before);
    const rd = await owner.get(`/api/w/${ws}/webhooks/${reb.body.webhook.id}/deliveries`);
    expect(rd.body.items[0]).toMatchObject({ status: 'failed', httpStatus: 'unsafe_url' });
  });
});

describe('API tokens', () => {
  it('shown once, stored as sha256, scoped (read token cannot write), pinned to a workspace, revocable; tokens cannot manage tokens', async () => {
    const r = await member.client.post(`/api/w/${ws}/api-tokens`, { name: 'codex', scopes: ['read'] });
    expect(r.status).toBe(200);
    const token = r.body.token as string;
    expect(token).toMatch(/^mlt_/);
    expect(r.body.apiToken.scopes).toEqual(['read']);
    const stored = await withSystem(env.pool, (db) => one<any>(db, 'SELECT token_hash FROM api_tokens WHERE id=$1', [r.body.apiToken.id]));
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = await member.client.get(`/api/w/${ws}/api-tokens`);
    expect(listed.raw).not.toContain(token);
    expect(listed.raw).not.toContain(stored.token_hash);

    const rc = bearer(env, token);
    expect((await rc.get(`/api/w/${ws}/meetings`)).status).toBe(200);
    expect((await rc.post(`/api/w/${ws}/meetings`, { title: 'via read token' })).status).toBe(403); // read token cannot write
    expect((await rc.post(`/api/w/${ws}/api-tokens`, { name: 'x', scopes: ['read', 'write'] })).status).toBe(403); // no token minting with tokens
    expect((await rc.get(`/api/w/${ws}/api-tokens`)).status).toBe(403);

    const wt = await createApiToken(member.client, ws, ['write']);
    const wc = bearer(env, wt);
    const created = await wc.post(`/api/w/${ws}/meetings`, { title: 'via write token' });
    expect(created.status).toBe(200);
    // token never exceeds member: admin-only endpoints refused even for an owner's token
    const ot = await createApiToken(owner, ws, ['read', 'write']);
    expect((await bearer(env, ot).post(`/api/w/${ws}/webhooks`, { url: 'https://hooks.example.com/x', events: ['ping'] })).status).toBe(403);

    // pinned to its workspace
    const other = await env.createTenant('tenantb@example.com');
    expect((await rc.get(`/api/w/${other.workspaceId}/meetings`)).status).toBe(403);
    // viewers may only create read-only tokens
    expect((await viewer.client.post(`/api/w/${ws}/api-tokens`, { name: 'v', scopes: ['read', 'write'] })).status).toBe(400);

    // revoke
    expect((await member.client.del(`/api/w/${ws}/api-tokens/${r.body.apiToken.id}`)).status).toBe(200);
    expect((await rc.get(`/api/w/${ws}/meetings`)).status).toBe(401);
    // other members cannot revoke someone else's token
    expect((await viewer.client.del(`/api/w/${ws}/api-tokens/${r.body.apiToken.id}`)).status).toBe(404);
  });
});
