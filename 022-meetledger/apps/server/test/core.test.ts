import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

describe('core: setup, auth, CSRF, RBAC, meetings', () => {
  it('first-run setup creates owner and blocks a second setup', async () => {
    const { client, workspaceId } = await env.setupOwner('owner@example.com');
    const again = await env.client().post('/api/setup', { email: 'x@example.com', name: 'X', password: 'correct horse battery', orgName: 'X' });
    expect(again.status).toBe(409);
    const ws = await client.get(`/api/w/${workspaceId}`);
    expect(ws.status).toBe(200);
    expect(ws.body.settings.defaults.transcriptionMode).toBe('local');
    expect(ws.body.processing.ai.isLocal).toBe(true);
  });

  it('rejects state-changing requests without CSRF token', async () => {
    const c = env.client();
    await c.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const me = await c.get('/api/me');
    const ws = me.body.workspaces[0].id;
    const noCsrf = await c.post(`/api/w/${ws}/meetings`, { title: 'x' });
    expect(noCsrf.status).toBe(403);
    c.csrf = me.body.csrfToken;
    const ok = await c.post(`/api/w/${ws}/meetings`, { title: 'x' });
    expect(ok.status).toBe(200);
    const evil = await c.req('POST', `/api/w/${ws}/meetings`, { title: 'y' }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
  });

  it('wrong password is rejected with a generic message', async () => {
    const r = await env.client().post('/api/auth/login', { email: 'owner@example.com', password: 'wrong password!!' });
    expect(r.status).toBe(401);
  });

  it('meeting visibility: private / selected / workspace and viewer is read-only', async () => {
    const c = env.client();
    await c.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const me = await c.refreshCsrf();
    const orgId = me.orgs[0].id;
    const ws = me.workspaces[0].id;
    const bob = await env.addUser(c, orgId, ws, 'bob@example.com', 'member');
    const vic = await env.addUser(c, orgId, ws, 'vic@example.com', 'viewer');

    const priv = await c.post(`/api/w/${ws}/meetings`, { title: '1on1 private', meetingType: 'one_on_one' });
    expect(priv.body.visibility).toBe('private');
    const sel = await c.post(`/api/w/${ws}/meetings`, { title: 'Selected', visibility: 'selected', accessUserIds: [bob.userId] });
    const pub = await c.post(`/api/w/${ws}/meetings`, { title: 'Weekly', visibility: 'workspace' });

    expect((await bob.client.get(`/api/w/${ws}/meetings/${priv.body.id}`)).status).toBe(404);
    expect((await bob.client.get(`/api/w/${ws}/meetings/${sel.body.id}`)).status).toBe(200);
    expect((await vic.client.get(`/api/w/${ws}/meetings/${sel.body.id}`)).status).toBe(404);
    expect((await vic.client.get(`/api/w/${ws}/meetings/${pub.body.id}`)).status).toBe(200);
    const list = await bob.client.get(`/api/w/${ws}/meetings`);
    const titles = list.body.items.map((m: any) => m.title);
    expect(titles).toContain('Selected');
    expect(titles).not.toContain('1on1 private');
    // viewer cannot create or edit
    expect((await vic.client.post(`/api/w/${ws}/meetings`, { title: 'nope' })).status).toBe(403);
    expect((await vic.client.patch(`/api/w/${ws}/meetings/${pub.body.id}`, { title: 'n', version: 1 })).status).toBe(403);
  });

  it('optimistic concurrency on meeting edits and notes', async () => {
    const c = env.client();
    await c.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const me = await c.refreshCsrf();
    const ws = me.workspaces[0].id;
    const m = await c.post(`/api/w/${ws}/meetings`, { title: 'Concurrency' });
    const p1 = await c.patch(`/api/w/${ws}/meetings/${m.body.id}`, { title: 'A', version: m.body.version });
    expect(p1.status).toBe(200);
    const stale = await c.patch(`/api/w/${ws}/meetings/${m.body.id}`, { title: 'B', version: m.body.version });
    expect(stale.status).toBe(409);
    const n1 = await c.put(`/api/w/${ws}/meetings/${m.body.id}/notes`, { body: 'first', baseVersion: 0 });
    expect(n1.body.version).toBe(1);
    const n2 = await c.put(`/api/w/${ws}/meetings/${m.body.id}/notes`, { body: 'offline edit', baseVersion: 0 });
    expect(n2.status).toBe(409);
    expect(n2.body.error.details.serverBody).toBe('first');
  });

  it('consent is required before recording; notes-only works without it', async () => {
    const c = env.client();
    await c.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const me = await c.refreshCsrf();
    const ws = me.workspaces[0].id;
    const m = await c.post(`/api/w/${ws}/meetings`, { title: 'Consent' });
    expect((await c.post(`/api/w/${ws}/meetings/${m.body.id}/start`, { capture: 'browser_mic' })).status).toBe(409);
    expect((await c.post(`/api/w/${ws}/meetings/${m.body.id}/start`, { capture: 'notes_only' })).status).toBe(200);
    await c.post(`/api/w/${ws}/meetings/${m.body.id}/consent`, { kind: 'recording', state: 'notified', method: 'verbal' });
    const started = await c.post(`/api/w/${ws}/meetings/${m.body.id}/start`, { capture: 'browser_mic' });
    expect(started.status).toBe(200);
    expect(started.body.consentState).toBe('notified');
  });

  it('confidential preset forces AI OFF and local transcription', async () => {
    const c = env.client();
    await c.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const me = await c.refreshCsrf();
    const ws = me.workspaces[0].id;
    const m = await c.post(`/api/w/${ws}/meetings`, { title: 'Board', isConfidential: true, transcriptionMode: 'cloud', aiEnabled: true, audioRetention: '30d' });
    expect(m.body.aiEnabled).toBe(false);
    expect(m.body.transcriptionMode).toBe('local');
    expect(m.body.audioRetention).toBe('until_processed');
    expect(m.body.visibility).toBe('private');
    expect(m.body.privacy.ai.allowed).toBe(false);
  });
});
