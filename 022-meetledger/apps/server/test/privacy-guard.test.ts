import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { GuardedHttp } from '../src/privacy/externalHttp';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

describe('GuardedHttp policy enforcement', () => {
  it('blocks content calls without decision, AI-OFF meetings, and local decisions to remote hosts', async () => {
    const a = await env.setupOwner('guard@example.com');
    const on = await a.client.post(`/api/w/${a.workspaceId}/meetings`, { title: 'AI on' });
    const off = await a.client.post(`/api/w/${a.workspaceId}/meetings`, { title: 'AI off', aiEnabled: false });
    let fetched = 0;
    const g = new GuardedHttp(env.pool, (async () => {
      fetched++;
      return new Response('{}');
    }) as any, ['ollama.internal:11434']);
    const cloud = { allowed: true, provider: 'openai', isLocal: false, reason: '' };
    const local = { allowed: true, provider: 'ollama', isLocal: true, reason: '' };
    const base = { orgId: a.orgId, kind: 'ai' as const, provider: 'x', purpose: 't' };
    await expect(g.fetch({ ...base, url: 'https://api.example.com', meetingIds: [on.body.id] })).rejects.toThrow(/policy decision/);
    await expect(g.fetch({ ...base, url: 'https://api.example.com', decision: cloud, meetingIds: [off.body.id] })).rejects.toThrow(/AI OFF/);
    await expect(g.fetch({ ...base, url: 'https://api.example.com', decision: local, meetingIds: [on.body.id] })).rejects.toThrow(/remote host/);
    // AI OFF also blocks local AI processing
    await expect(g.fetch({ ...base, url: 'http://127.0.0.1:11434/api/chat', decision: local, meetingIds: [off.body.id] })).rejects.toThrow(/AI OFF/);
    expect(fetched).toBe(0);
    await g.fetch({ ...base, url: 'http://ollama.internal:11434/api/chat', decision: local, meetingIds: [on.body.id] });
    await g.fetch({ ...base, url: 'https://api.example.com/v1', decision: cloud, meetingIds: [on.body.id] });
    expect(fetched).toBe(2);
    const rows = await env.tenantTx(a.orgId, async (db) => (await db.query('SELECT host FROM external_calls')).rows);
    expect(rows.map((r) => r.host)).toEqual(['api.example.com']); // on-premise call is not a third-party transfer
  });
});
