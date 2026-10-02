import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, insertTranscript, type Client, type TestEnv } from './helpers';
import { FakeAnswerProvider, countRows, fakeCloudResponder, insertDecision, mkMeeting, searchRegistry } from './search-helpers';
import { enqueueMeetingIndex } from '../src/modules/search';

// Installation enables cloud AI + cloud embeddings; the workspace opts in. This proves that AI OFF / confidential
// meetings are still never embedded, never used as ask context and never reach an external provider.
const CLOUD_ENV = { AI_PROVIDER: 'openai', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-a-real-key' };
const cloudAi = new FakeAnswerProvider('openai', false);

let env: TestEnv;
let owner: { client: Client; orgId: string; workspaceId: string; userId: string };
let ws: string;
let orgId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv({ providers: searchRegistry([cloudAi], CLOUD_ENV), env: CLOUD_ENV, now: '2026-10-02T01:00:00Z' });
  env.http.responder = fakeCloudResponder;
  owner = await env.setupOwner('owner@example.com');
  ws = owner.workspaceId;
  orgId = owner.orgId;
  const s = await owner.client.patch(`/api/w/${ws}/settings`, { ai: { provider: 'openai', cloudAllowed: true, embeddings: 'openai' } });
  expect(s.status).toBe(200);

  const on = await mkMeeting(owner.client, ws, { title: 'AI ON 会議', scheduledStart: '2026-09-10T01:00:00Z' });
  const off = await mkMeeting(owner.client, ws, { title: 'AI OFF 会議', aiEnabled: false, scheduledStart: '2026-09-11T01:00:00Z' });
  const conf = await mkMeeting(owner.client, ws, { title: '機密 会議', isConfidential: true, scheduledStart: '2026-09-12T01:00:00Z' });
  Object.assign(ids, { on: on.id, off: off.id, conf: conf.id });
  expect(off.aiEnabled).toBe(false);
  expect(conf.aiEnabled).toBe(false);
  await insertTranscript(env, orgId, on.id, [{ speaker: 'Speaker 1', text: '価格は月額5万円で合意しました。' }]);
  await insertTranscript(env, orgId, off.id, [{ speaker: 'Speaker 1', text: 'AIオフ会議の価格は555円（外部送信禁止）。' }]);
  await insertTranscript(env, orgId, conf.id, [{ speaker: 'Speaker 1', text: '機密会議の価格は666円（外部送信禁止）。' }]);
  await insertDecision(env, orgId, ws, on.id, { text: '価格は月額5万円' });
  await insertDecision(env, orgId, ws, off.id, { text: '価格は555円' });
  await insertDecision(env, orgId, ws, conf.id, { text: '価格は666円' });
  for (const id of [ids.on, ids.off, ids.conf]) await env.tenantTx(orgId, (db) => enqueueMeetingIndex(env.deps, db, orgId, id));
  await env.worker.drain();
});
afterAll(async () => env?.close());

const touches = (meetingIds: string[] | undefined, id: string) => (meetingIds ?? []).includes(id);

describe('#17 AI OFF / Confidential meeting with cloud providers configured', () => {
  it('#17 AI OFF meeting: no ai_chunks and zero external embedding calls (guard proven live for AI ON)', async () => {
    expect(await countRows(env, orgId, 'ai_chunks', ids.off)).toBe(0);
    expect(await countRows(env, orgId, 'ai_chunks', ids.conf)).toBe(0);
    expect(await countRows(env, orgId, 'ai_chunks', ids.on)).toBeGreaterThan(0);
    const models = await env.tenantTx(orgId, async (db) => (await db.query('SELECT DISTINCT embedding_model FROM ai_chunks WHERE meeting_id=$1', [ids.on])).rows.map((r) => r.embedding_model));
    expect(models).toEqual(['text-embedding-3-small']);
    const emb = env.http.byKind('embedding');
    expect(emb.length).toBeGreaterThan(0);
    expect(emb.some((c) => touches(c.meetingIds, ids.on))).toBe(true);
    expect(emb.some((c) => touches(c.meetingIds, ids.off) || touches(c.meetingIds, ids.conf))).toBe(false);
    for (const c of emb) expect(String(c.init?.body)).not.toMatch(/555円|666円/);
    // external_calls audit (metadata only) never mentions the excluded meetings
    const audited = await env.tenantTx(orgId, async (db) => (await db.query('SELECT meeting_id, kind, host FROM external_calls')).rows);
    expect(audited.some((r) => r.meeting_id === ids.off || r.meeting_id === ids.conf)).toBe(false);
    expect(audited.find((r) => r.meeting_id === ids.on)).toMatchObject({ kind: 'embedding', host: 'api.openai.com' });
    // FTS documents are kept for AI OFF meetings (search is not AI)
    expect(await countRows(env, orgId, 'search_docs', ids.off)).toBeGreaterThan(0);
    const s = await owner.client.get(`/api/w/${ws}/search?q=${encodeURIComponent('555円')}`);
    expect(s.body.items.some((h: any) => h.meetingId === ids.off)).toBe(true);
  });

  it('#17 AI OFF meeting is not used in ask contexts and never sent to the cloud AI provider', async () => {
    cloudAi.calls = [];
    const before = env.http.calls.length;
    const r = await owner.client.post(`/api/w/${ws}/ask`, { question: '価格について何を決めた？' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ insufficient: false, provider: 'openai', aiGenerated: true });
    expect(r.body.excludedMeetings).toBe(2); // AI OFF + confidential (both visible to their creator)
    expect(cloudAi.calls).toHaveLength(1);
    expect(cloudAi.calls[0].call.meetingIds).toEqual([ids.on]);
    const sent = JSON.stringify(cloudAi.calls[0].input);
    expect(sent).not.toMatch(/555円|666円/);
    expect(r.body.citations.every((c: any) => c.meetingId === ids.on)).toBe(true);
    const newCalls = env.http.calls.slice(before);
    expect(newCalls.some((c) => touches(c.meetingIds, ids.off) || touches(c.meetingIds, ids.conf))).toBe(false);
    // the question embedding carries no meeting data (meetingIds = [])
    const qEmb = newCalls.filter((c) => c.kind === 'embedding');
    expect(qEmb).toHaveLength(1); // chunks exist for the cloud model, so the question (only) is embedded
    for (const c of qEmb) expect(c.meetingIds).toEqual([]);
    expect(newCalls.filter((c) => c.kind === 'ai').map((c) => c.meetingIds)).toEqual([[ids.on]]);
  });

  it('#17 the external guard rejects AI OFF / confidential meeting data even with an allowing decision', async () => {
    const decision = { allowed: true, provider: 'openai', isLocal: false, reason: 'test' };
    for (const id of [ids.off, ids.conf]) {
      await expect(
        env.deps.http.fetch({ orgId, meetingIds: [id], kind: 'embedding', provider: 'openai', purpose: 'test', url: 'https://api.openai.com/v1/embeddings', decision }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    }
    const n = await env.tenantTx(orgId, async (db) => (await db.query('SELECT count(*)::int n FROM external_calls WHERE meeting_id = ANY($1)', [[ids.off, ids.conf]])).rows[0].n);
    expect(n).toBe(0);
  });

  it('privacy preview shows cloud destinations / hosts for AI ON and none for AI OFF (no content)', async () => {
    const on = await owner.client.get(`/api/w/${ws}/ai/privacy-preview?meetingId=${ids.on}`);
    expect(on.body).toMatchObject({
      ai: { provider: 'openai', destination: 'cloud', host: 'api.openai.com' },
      embedding: { provider: 'openai', destination: 'cloud', host: 'api.openai.com', model: 'text-embedding-3-small' },
      ask: { eligible: true, destination: 'cloud' },
    });
    expect(on.body.embedding.sizes.estimatedChunks).toBeGreaterThan(0);
    expect(JSON.stringify(on.body)).not.toContain('月額5万円');
    const conf = await owner.client.get(`/api/w/${ws}/ai/privacy-preview?meetingId=${ids.conf}`);
    expect(conf.body).toMatchObject({ meeting: { isConfidential: true }, ai: { allowed: false }, embedding: { allowed: false, destination: 'none', host: null }, ask: { eligible: false } });
    const w = await owner.client.get(`/api/w/${ws}/ai/privacy-preview`);
    expect(w.body).toMatchObject({ ask: { destination: 'cloud', host: 'api.openai.com', eligibleMeetings: 1 }, meetings: { aiOff: 2, confidential: 1 } });
  });

  it('#17 turning AI OFF purges the meeting vectors and removes it from ask (no AI call)', async () => {
    const m = await owner.client.get(`/api/w/${ws}/meetings/${ids.on}`);
    const p = await owner.client.patch(`/api/w/${ws}/meetings/${ids.on}`, { aiEnabled: false, version: m.body.version });
    expect(p.status).toBe(200);
    await env.worker.drain();
    expect(await countRows(env, orgId, 'ai_chunks', ids.on)).toBe(0);
    cloudAi.calls = [];
    const before = env.http.calls.length;
    const r = await owner.client.post(`/api/w/${ws}/ask`, { question: '価格について何を決めた？' });
    expect(r.body).toMatchObject({ insufficient: true, answer: '記録からは分かりません', excludedMeetings: 3 });
    expect(cloudAi.calls).toHaveLength(0);
    expect(env.http.calls.slice(before).filter((c) => c.kind === 'ai' || (c.meetingIds ?? []).length > 0)).toEqual([]);
  });
});

describe('ollama embeddings (self-hosted) under the current GuardedHttp', () => {
  it('goes through deps.http with kind embedding + local decision; a guard rejection falls back to local-hash and is reported', async () => {
    const OLLAMA_ENV = { EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: 'http://127.0.0.1:11434' };
    const e2 = await createTestEnv({ providers: searchRegistry([new FakeAnswerProvider()], OLLAMA_ENV), env: OLLAMA_ENV });
    try {
      const o = await e2.setupOwner('ollama-owner@example.com');
      await o.client.patch(`/api/w/${o.workspaceId}/settings`, { ai: { embeddings: 'ollama' } });
      const m = await mkMeeting(o.client, o.workspaceId, { title: 'Ollama 会議' });
      await insertTranscript(e2, o.orgId, m.id, [{ speaker: 'Speaker 1', text: '価格の相談' }]);
      await e2.worker.drain();
      const res = await e2.tenantTx(o.orgId, (db) => enqueueMeetingIndex(e2.deps, db, o.orgId, m.id));
      expect(res.created).toBe(true);
      await e2.worker.drain();
      const calls = e2.http.byKind('embedding');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toMatchObject({ provider: 'ollama', meetingIds: [m.id], decision: { provider: 'ollama', isLocal: true }, url: 'http://127.0.0.1:11434/api/embed' });
      const job = await e2.tenantTx(o.orgId, async (db) => (await db.query("SELECT result FROM jobs WHERE type='index.meeting' AND status='succeeded' ORDER BY created_at DESC LIMIT 1")).rows[0].result);
      expect(job).toMatchObject({ status: 'indexed', aiIndexed: true, embeddingModel: 'local-hash-384' });
      expect(job.embeddingFallback).toMatch(/policy decision/);
      expect(await countRows(e2, o.orgId, 'ai_chunks', m.id)).toBeGreaterThan(0);
    } finally {
      await e2.close();
    }
  });
});
