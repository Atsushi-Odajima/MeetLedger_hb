import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, insertTranscript, type TestEnv } from './helpers';
import { describeConfig } from '../src/config';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ env: { LOG_LEVEL: 'debug', OPENAI_API_KEY: 'sk-test-SECRETKEY-123', SESSION_SECRET: 'super-secret-session-value-abcdefghijklmnopqrstuvwxyz' } });
});
afterAll(async () => env?.close());

const MARK = {
  password: 'Pw-MARKER-7f3a correct horse',
  transcript: 'TRANSCRIPT-MARKER-91c 価格は月額9800円に決定',
  notes: 'NOTES-MARKER-55d 社外秘メモ',
  question: 'QUESTION-MARKER-2b7 価格について何を決めた？',
};

describe('#27 secrets and content never appear in logs', () => {
  it('runs a full flow and scans every log line', async () => {
    const c = env.client();
    const r = await c.post('/api/setup', { email: 'sec@example.com', name: 'Sec', password: MARK.password, orgName: 'SecOrg', workspaceName: 'Main' });
    expect(r.status).toBe(200);
    const me = await c.refreshCsrf();
    const ws = me.workspaces[0].id;
    const orgId = me.orgs[0].id;
    // failed login with the password echoed back must not be logged either
    await env.client().post('/api/auth/login', { email: 'sec@example.com', password: MARK.password + 'x' });
    const m = await c.post(`/api/w/${ws}/meetings`, { title: 'Security review' });
    await insertTranscript(env, orgId, m.body.id, [{ speaker: 'Speaker 1', text: MARK.transcript }]);
    await c.put(`/api/w/${ws}/meetings/${m.body.id}/notes`, { body: MARK.notes, baseVersion: 0 });
    await c.post(`/api/w/${ws}/meetings/${m.body.id}/extract`, {});
    await env.worker.drain();
    await c.post(`/api/w/${ws}/meetings/${m.body.id}/ask`, { question: MARK.question });
    await c.post(`/api/w/${ws}/ask`, { question: MARK.question });
    await c.get(`/api/w/${ws}/search?q=${encodeURIComponent('価格')}`);
    const tok = await c.post(`/api/w/${ws}/api-tokens`, { name: 'ci', scopes: ['read'] });
    const token: string | undefined = tok.body?.token;
    // a request that errors with user content in the body
    await c.post(`/api/w/${ws}/meetings`, { title: '', notes: MARK.notes });

    const all = env.logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(MARK)) expect(all.includes(v.split(' ')[0]), `${k} leaked into logs`).toBe(false);
    expect(all).not.toContain('sk-test-SECRETKEY-123');
    expect(all).not.toContain('super-secret-session-value');
    if (token) expect(all).not.toContain(token);
    expect(all).not.toMatch(/ml_sid=[A-Za-z0-9_-]{20,}/);
    expect(all).not.toContain(me.csrfToken);

    // audit + external call records hold metadata only
    const audit = await env.tenantTx(orgId, async (db) => (await db.query('SELECT meta::text AS m FROM audit_events')).rows.map((r) => r.m).join('\n'));
    for (const v of Object.values(MARK)) expect(audit.includes(v.split(' ')[0])).toBe(false);
  });

  it('describeConfig redacts secrets', () => {
    const d = describeConfig(env.config);
    expect(d.OPENAI_API_KEY).toBe('***');
    expect(d.SESSION_SECRET).toBe('***');
    expect(d.MASTER_KEY).toBe('***');
    expect(d.DATABASE_URL).toBe('***');
  });
});

describe('HTTP hardening', () => {
  it('sets security headers and hardened session cookie', async () => {
    const c = env.client();
    const r = await c.post('/api/auth/login', { email: 'sec@example.com', password: MARK.password });
    expect(r.status).toBe(200);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const h = (await c.get('/api/health')).headers;
    expect(String(h['content-security-policy'])).toContain("default-src 'self'");
    expect(String(h['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('search / ask treat SQL and tsquery metacharacters as plain text (no 500, no cross-tenant data)', async () => {
    const c = env.client();
    expect((await c.post('/api/auth/login', { email: 'sec@example.com', password: MARK.password })).status).toBe(200);
    const me = await c.refreshCsrf();
    const ws = me.workspaces[0].id;
    for (const q of ["' OR 1=1 --", "a' | 'b", '!(価格) & <-> :*', "'); DROP TABLE meetings; --", '%_\\']) {
      const r = await c.get(`/api/w/${ws}/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
    }
    const r2 = await c.get(`/api/w/${ws}/meetings?q=${encodeURIComponent("%' OR '1'='1")}`);
    expect(r2.status).toBe(200);
    expect(r2.body.items).toEqual([]);
    const count = await env.pool.query("SELECT to_regclass('public.meetings') IS NOT NULL AS ok");
    expect(count.rows[0].ok).toBe(true);
  });

  it('rate limits login attempts', async () => {
    const c = env.client();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong wrong wrong' })).status;
    expect(last).toBe(429);
  });
});
