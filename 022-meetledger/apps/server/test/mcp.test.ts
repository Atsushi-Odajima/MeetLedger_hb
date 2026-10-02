import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { one, withSystem } from '../src/db/pool';
import { buildProxyServer, connectRemote } from '../src/mcp/proxy';
import { createTestEnv } from './helpers';
import { callTool, createApiToken, injectFetch, mcpRpc } from './connectors-helpers';

// Top-level setup so route-existence guards (it.skipIf) can be evaluated at collection time:
// tools backed by other modules' REST endpoints are skipped (and reported) when those endpoints are not deployed yet.
const env = await createTestEnv();
afterAll(async () => env?.close());
const o = await env.setupOwner('owner@example.com');
const owner = o.client;
const ws = o.workspaceId;
const bob = await env.addUser(owner, o.orgId, ws, 'bob@example.com', 'member');
const ownerToken = await createApiToken(owner, ws, ['read', 'write'], 'owner-rw');
const bobToken = await createApiToken(bob.client, ws, ['read', 'write'], 'bob-rw');
const bobRead = await createApiToken(bob.client, ws, ['read'], 'bob-r');

const routeExists = (method: 'GET' | 'POST', path: string) => env.app.hasRoute({ method, url: `/api/w/:workspaceId${path}` });
const ROUTES = {
  brief: routeExists('GET', '/meetings/:id/brief'),
  decisions: routeExists('GET', '/decisions'),
  actions: routeExists('GET', '/actions'),
  commitments: routeExists('GET', '/commitments'),
  questions: routeExists('GET', '/questions'),
  review: routeExists('GET', '/review'),
  followups: routeExists('POST', '/meetings/:id/followups'),
};

const ALL_TOOLS = [
  'create_meeting',
  'get_meeting_brief',
  'search_meetings',
  'get_current_decisions',
  'get_my_actions',
  'get_commitments',
  'get_open_questions',
  'review_meeting_extractions',
  'draft_followup',
  'prepare_next_meeting',
];
const READ_TOOLS = ['get_meeting_brief', 'search_meetings', 'get_current_decisions', 'get_my_actions', 'get_commitments', 'get_open_questions'];
const WRITE_TOOLS = ['create_meeting', 'review_meeting_extractions', 'draft_followup', 'prepare_next_meeting'];

const meetingCount = async () => (await owner.get(`/api/w/${ws}/meetings?limit=200`)).body.items.length;

describe('MCP endpoint /mcp (Streamable HTTP, stateless, bearer API token)', () => {
  it.each(['legacy', 'modern'] as const)('tools/list includes all 10 tools with explicit annotations (%s protocol era)', async (era) => {
    const r = await mcpRpc(env, bobRead, 'tools/list', {}, { era });
    expect(r.status).toBe(200);
    expect(r.headers['mcp-session-id']).toBeUndefined(); // stateless
    const tools = r.message.result.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations.openWorldHint, t.name).toBe(false);
      expect(typeof t.description).toBe('string');
    }
    for (const n of READ_TOOLS) expect(tools.find((t) => t.name === n).annotations.readOnlyHint, n).toBe(true);
    for (const n of WRITE_TOOLS) {
      const a = tools.find((t) => t.name === n).annotations;
      expect(a.readOnlyHint, n).toBe(false);
      expect(a.destructiveHint, n).toBe(false); // set explicitly (spec default is true)
      expect(typeof a.idempotentHint, n).toBe('boolean');
      expect(tools.find((t) => t.name === n).inputSchema.properties.confirmation_token, n).toBeTruthy();
    }
    expect(tools.find((t) => t.name === 'review_meeting_extractions').annotations.idempotentHint).toBe(true);
    // no send tools
    expect(tools.some((t) => /send|post|email|slack/i.test(t.name))).toBe(false);
  });

  it('modern era: server/discover answers 2026-07-28; legacy initialize negotiates a 2025 version', async () => {
    const d = await mcpRpc(env, bobRead, 'server/discover', {}, { era: 'modern' });
    expect(d.message.result.supportedVersions).toContain('2026-07-28');
    const init = await mcpRpc(env, bobRead, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-like', version: '1' } });
    expect(init.message.result.protocolVersion).toBe('2025-06-18');
    expect(init.message.result.serverInfo.name).toBe('meetledger');
    expect(init.message.result.instructions).toContain('confirmation_token');
  });

  it('requires a bearer API token (401 + WWW-Authenticate); cookie sessions are not accepted; GET/DELETE → 405', async () => {
    const none = await mcpRpc(env, null, 'tools/list', {});
    expect(none.status).toBe(401);
    expect(String(none.headers['www-authenticate'])).toContain('Bearer');
    const invalid = await mcpRpc(env, 'mlt_invalid', 'tools/list', {});
    expect(invalid.status).toBe(401);
    expect(String(invalid.headers['www-authenticate'])).toContain('Bearer');
    const cookie = await env.app.inject({ method: 'POST', url: '/mcp', headers: { cookie: owner.cookie, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(cookie.statusCode).toBe(403); // global CSRF check (no x-csrf-token)
    const cookieCsrf = await env.app.inject({ method: 'POST', url: '/mcp', headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(cookieCsrf.statusCode).toBe(401); // session cookies are never accepted by /mcp
    const get = await env.app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${bobRead}` } });
    expect(get.statusCode).toBe(405);
    // a browser page on another origin cannot drive the endpoint
    const cross = await mcpRpc(env, bobRead, 'tools/list', {}, { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
  });

  it('read tool returns ACL-filtered data: another user\'s private meeting is never returned', async () => {
    const priv = await owner.post(`/api/w/${ws}/meetings`, { title: 'Alpha secret 1on1', meetingType: 'one_on_one' });
    expect(priv.body.visibility).toBe('private');
    await owner.post(`/api/w/${ws}/meetings`, { title: 'Alpha planning', visibility: 'workspace' });
    for (const era of ['legacy', 'modern'] as const) {
      const s = await callTool(env, bobRead, 'search_meetings', { query: 'Alpha' }, era);
      expect(s.isError).toBe(false);
      const titles = s.data.results.map((r: any) => r.title);
      expect(titles).toContain('Alpha planning');
      expect(titles).not.toContain('Alpha secret 1on1');
      expect(JSON.stringify(s.result)).not.toContain(priv.body.id);
    }
    const brief = await callTool(env, bobRead, 'get_meeting_brief', { meeting_id: priv.body.id });
    expect(brief.isError).toBe(true);
    expect(brief.data.error.code).toBe('not_found');
    // the creator sees it through their own token
    const mine = await callTool(env, ownerToken, 'search_meetings', { query: 'Alpha' });
    expect(mine.data.results.map((r: any) => r.title)).toContain('Alpha secret 1on1');
    // tool outputs are minimal: no participant emails, no internal fields
    const b2 = await callTool(env, ownerToken, 'get_meeting_brief', { meeting_id: priv.body.id });
    expect(b2.isError).toBe(false);
    expect(JSON.stringify(b2.data)).not.toMatch(/owner@example\.com|createdBy|org_id/);
  });

  it('write tool without confirmation writes nothing; with a valid confirmation token writes exactly once', async () => {
    const before = await meetingCount();
    const args = { title: 'MCP created meeting', scheduled_start: '2026-10-05T10:00:00+09:00', participants: [{ name: 'Ken', email: 'ken@example.com' }] };
    const p = await callTool(env, bobToken, 'create_meeting', args);
    expect(p.isError).toBe(false);
    expect(p.data.status).toBe('confirmation_required');
    expect(p.data.preview).toMatchObject({ action: 'create_meeting', title: 'MCP created meeting' });
    expect(p.data.confirmation_token).toMatch(/^[0-9a-f-]{36}\./);
    expect(await meetingCount()).toBe(before); // preview wrote nothing

    // confirm=true without a token → nothing written
    const noTok = await callTool(env, bobToken, 'create_meeting', { ...args, confirm: true });
    expect(noTok.isError).toBe(true);
    expect(await meetingCount()).toBe(before);

    const done = await callTool(env, bobToken, 'create_meeting', { ...args, confirm: true, confirmation_token: p.data.confirmation_token });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('created');
    expect(await meetingCount()).toBe(before + 1);
    const created = (await bob.client.get(`/api/w/${ws}/meetings/${done.data.meeting.id}`)).body;
    expect(created.source).toBe('mcp');
    expect(created.createdBy).toBe(bob.userId);

    // replay of the same token → rejected, still exactly one meeting
    const replay = await callTool(env, bobToken, 'create_meeting', { ...args, confirm: true, confirmation_token: p.data.confirmation_token });
    expect(replay.isError).toBe(true);
    expect(replay.data.error.code).toBe('invalid_confirmation');
    expect(await meetingCount()).toBe(before + 1);
    const row = await withSystem(env.pool, (db) => one<any>(db, 'SELECT used_at, tool FROM mcp_confirmations WHERE id=$1', [p.data.confirmation_token.split('.')[0]]));
    expect(row.used_at).toBeTruthy();
    expect(row.tool).toBe('create_meeting');
  });

  it('expired, foreign, altered or read-only confirmations are rejected and write nothing', async () => {
    const before = await meetingCount();
    const args = { title: 'Guarded meeting' };
    const p = await callTool(env, bobToken, 'create_meeting', args);
    const token = p.data.confirmation_token;
    // foreign: another user (owner) presents bob's token with identical arguments
    const foreign = await callTool(env, ownerToken, 'create_meeting', { ...args, confirm: true, confirmation_token: token });
    expect(foreign.data.error.code).toBe('invalid_confirmation');
    // altered arguments
    const altered = await callTool(env, bobToken, 'create_meeting', { title: 'Something else', confirm: true, confirmation_token: token });
    expect(altered.data.error.code).toBe('invalid_confirmation');
    // other tool
    const otherTool = await callTool(env, bobToken, 'prepare_next_meeting', { meeting_id: p.data.preview?.series_id ?? '00000000-0000-4000-8000-000000000000', create: true, scheduled_start: '2026-10-09T10:00:00+09:00', confirm: true, confirmation_token: token });
    expect(otherTool.isError).toBe(true);
    // forged signature
    const forged = await callTool(env, bobToken, 'create_meeting', { ...args, confirm: true, confirmation_token: `${token.split('.')[0]}.AAAA` });
    expect(forged.data.error.code).toBe('invalid_confirmation');
    // expired (10 min TTL)
    env.clock.advance(11 * 60_000);
    const expired = await callTool(env, bobToken, 'create_meeting', { ...args, confirm: true, confirmation_token: token });
    expect(expired.data.error.code).toBe('invalid_confirmation');
    expect(await meetingCount()).toBe(before);
    // read-only token: write tools refuse even the preview step
    const ro = await callTool(env, bobRead, 'create_meeting', args);
    expect(ro.isError).toBe(true);
    expect(ro.data.error.code).toBe('insufficient_scope');
    expect(await meetingCount()).toBe(before);
  });

  it('prepare_next_meeting: read-only overview, then two-step creation of the next meeting in the series', async () => {
    const series = await owner.post(`/api/w/${ws}/series`, { title: 'Weekly sync' });
    expect(series.status).toBe(200);
    const seriesId = series.body.id ?? series.body.series?.id;
    const m = await owner.post(`/api/w/${ws}/meetings`, { title: 'Weekly sync #1', seriesId, scheduledStart: '2026-10-01T01:00:00Z' });
    const overview = await callTool(env, ownerToken, 'prepare_next_meeting', { meeting_id: m.body.id });
    expect(overview.isError).toBe(false);
    expect(overview.data.series.id).toBe(seriesId);
    const before = await meetingCount();
    const args = { meeting_id: m.body.id, create: true, scheduled_start: '2026-10-08T10:00:00+09:00' };
    const p = await callTool(env, ownerToken, 'prepare_next_meeting', args);
    expect(p.data.status).toBe('confirmation_required');
    expect(await meetingCount()).toBe(before);
    const done = await callTool(env, ownerToken, 'prepare_next_meeting', { ...args, confirm: true, confirmation_token: p.data.confirmation_token });
    expect(done.isError).toBe(false);
    expect(done.data.meeting.series_id).toBe(seriesId);
    expect(await meetingCount()).toBe(before + 1);
  });

  it.skipIf(!ROUTES.brief)('get_meeting_brief uses the brief endpoint (followup module)', async () => {
    const m = await owner.post(`/api/w/${ws}/meetings`, { title: 'Brief target' });
    const r = await callTool(env, ownerToken, 'get_meeting_brief', { meeting_id: m.body.id });
    expect(r.isError).toBe(false);
    expect(r.data.brief).toBeTruthy();
  });

  it.skipIf(!ROUTES.decisions)('get_current_decisions returns current decisions, ACL-filtered (ledger module)', async () => {
    const priv = await owner.post(`/api/w/${ws}/meetings`, { title: 'Pricing 1on1', meetingType: 'one_on_one' });
    const pub = await owner.post(`/api/w/${ws}/meetings`, { title: 'Roadmap', visibility: 'workspace' });
    expect((await owner.post(`/api/w/${ws}/decisions`, { text: 'Secret pricing decision', meetingId: priv.body.id })).status).toBe(200);
    expect((await owner.post(`/api/w/${ws}/decisions`, { text: 'Public roadmap decision', meetingId: pub.body.id })).status).toBe(200);
    const r = await callTool(env, bobRead, 'get_current_decisions', {});
    expect(r.isError).toBe(false);
    const texts = r.data.decisions.map((d: any) => d.text);
    expect(texts).toContain('Public roadmap decision');
    expect(texts).not.toContain('Secret pricing decision');
    expect(Object.keys(r.data.decisions[0]).sort()).toEqual(['decided_at', 'id', 'meeting_id', 'review_state', 'source', 'status', 'text', 'topic']);
    const mine = await callTool(env, ownerToken, 'get_current_decisions', {});
    expect(mine.data.decisions.map((d: any) => d.text)).toContain('Secret pricing decision');
  });

  it.skipIf(!ROUTES.actions)('get_my_actions returns my action items (ledger module)', async () => {
    const r = await callTool(env, bobRead, 'get_my_actions', {});
    expect(r.isError).toBe(false);
    expect(Array.isArray(r.data.actions)).toBe(true);
  });

  it.skipIf(!ROUTES.commitments)('get_commitments returns commitments (ledger module)', async () => {
    const r = await callTool(env, bobRead, 'get_commitments', { direction: 'all' });
    expect(r.isError).toBe(false);
    expect(Array.isArray(r.data.commitments)).toBe(true);
  });

  it.skipIf(!ROUTES.questions)('get_open_questions returns open questions (ledger module)', async () => {
    const r = await callTool(env, bobRead, 'get_open_questions', {});
    expect(r.isError).toBe(false);
    expect(Array.isArray(r.data.questions)).toBe(true);
  });

  it.skipIf(!ROUTES.review)('review_meeting_extractions: list is read-only; accept needs confirmation and then confirms the candidate once (ledger module)', async () => {
    const m = await owner.post(`/api/w/${ws}/meetings`, { title: 'Review target', visibility: 'workspace' });
    const cand = await env.tenantTx(o.orgId, async (db) =>
      (
        await db.query(
          `INSERT INTO decisions(org_id, workspace_id, meeting_id, text, review_state, extracted_by, ai_provider) VALUES ($1,$2,$3,'AI candidate: ship v2 in Nov','candidate','ai','local-rules') RETURNING id`,
          [o.orgId, ws, m.body.id],
        )
      ).rows[0].id as string,
    );
    const state = async () => (await env.tenantTx(o.orgId, (db) => db.query('SELECT review_state FROM decisions WHERE id=$1', [cand]))).rows[0].review_state;
    const l = await callTool(env, bobToken, 'review_meeting_extractions', { meeting_id: m.body.id });
    expect(l.isError).toBe(false);
    expect(l.data.candidates.find((c: any) => c.id === cand)).toMatchObject({ type: 'decision', text: 'AI candidate: ship v2 in Nov' });
    const args = { meeting_id: m.body.id, action: 'accept', items: [{ type: 'decision', id: cand }] };
    const p = await callTool(env, bobToken, 'review_meeting_extractions', args);
    expect(p.data.status).toBe('confirmation_required');
    expect(p.data.preview.items[0]).toMatchObject({ id: cand, text: 'AI candidate: ship v2 in Nov', found_in_review_inbox: true });
    expect(await state()).toBe('candidate'); // nothing changed by the preview
    const done = await callTool(env, bobToken, 'review_meeting_extractions', { ...args, confirm: true, confirmation_token: p.data.confirmation_token });
    expect(done.isError).toBe(false);
    expect(done.data.results).toEqual([{ type: 'decision', id: cand, ok: true }]);
    expect(await state()).toBe('confirmed');
    const replay = await callTool(env, bobToken, 'review_meeting_extractions', { ...args, confirm: true, confirmation_token: p.data.confirmation_token });
    expect(replay.data.error.code).toBe('invalid_confirmation');
  });

  it.skipIf(!ROUTES.followups)('draft_followup: preview writes no draft; confirmed call creates a draft only (followup module)', async () => {
    const m = await owner.post(`/api/w/${ws}/meetings`, { title: 'Follow-up target' });
    const p = await callTool(env, ownerToken, 'draft_followup', { meeting_id: m.body.id, kind: 'internal_recap' });
    expect(p.data.status).toBe('confirmation_required');
    const n0 = await withSystem(env.pool, (db) => one<any>(db, 'SELECT count(*)::int AS n FROM followup_drafts WHERE meeting_id=$1', [m.body.id]));
    expect(n0.n).toBe(0);
    const d = await callTool(env, ownerToken, 'draft_followup', { meeting_id: m.body.id, kind: 'internal_recap', confirm: true, confirmation_token: p.data.confirmation_token });
    expect(d.isError).toBe(false);
    const n1 = await withSystem(env.pool, (db) => one<any>(db, 'SELECT count(*)::int AS n, max(status) AS s FROM followup_drafts WHERE meeting_id=$1', [m.body.id]));
    expect(n1.n).toBe(1);
    expect(n1.s).toBe('draft'); // never sent
  });

  it('tools whose backing module is missing answer feature_unavailable instead of failing', async () => {
    const pairs: [keyof typeof ROUTES, string, Record<string, unknown>][] = [
      ['decisions', 'get_current_decisions', {}],
      ['actions', 'get_my_actions', {}],
      ['commitments', 'get_commitments', {}],
      ['questions', 'get_open_questions', {}],
      ['review', 'review_meeting_extractions', {}],
    ];
    for (const [route, tool, args] of pairs) {
      if (ROUTES[route]) continue;
      const r = await callTool(env, bobRead, tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.data.error.code, tool).toBe('feature_unavailable');
    }
  });

  it('stdio proxy mirrors the remote tool list (incl. annotations) and forwards calls with the user token', async () => {
    const client = await connectRemote({ url: 'http://localhost:8787', token: bobRead, fetch: injectFetch(env) });
    const server = await buildProxyServer(client);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const pending = new Map<number, (m: any) => void>();
    clientSide.onmessage = (m: any) => pending.get(m.id)?.(m);
    await clientSide.start();
    const rpc = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<any>((resolve) => {
        pending.set(id, resolve);
        void clientSide.send({ jsonrpc: '2.0', id, method, params } as any);
      });
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('meetledger');
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);
    const list = await rpc(2, 'tools/list', {});
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    expect(list.result.tools.find((t: any) => t.name === 'create_meeting').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const call = await rpc(3, 'tools/call', { name: 'search_meetings', arguments: { query: 'Alpha' } });
    const titles = call.result.structuredContent.results.map((r: any) => r.title);
    expect(titles).toContain('Alpha planning');
    expect(titles).not.toContain('Alpha secret 1on1');
    await clientSide.close();
    await client.close();
  });
});

describe('MCP route availability report', () => {
  it('lists REST routes owned by other modules (skipped tool tests when false)', () => {
    // Visible in the test output for the hand-off report.
    console.info('[mcp] backing routes present:', JSON.stringify(ROUTES));
    expect(Object.keys(ROUTES).length).toBe(7);
  });
});
