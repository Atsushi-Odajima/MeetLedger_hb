import type { AiProviderId } from '@meetledger/shared';
import { loadConfig } from '../src/config';
import { MapRegistry } from '../src/providers/registry';
import { createEmbeddingProviders } from '../src/providers/embeddings';
import { hashEmbed } from '../src/providers/embeddings/localHash';
import type { AiCallCtx, AiProvider, AnswerInput, AnswerOutput } from '../src/providers/ai/types';
import type { ExternalCall } from '../src/privacy/externalHttp';
import { enqueueMeetingIndex } from '../src/modules/search';
import type { Client, TestEnv } from './helpers';

/** Default fake behaviour: answer from the given contexts and cite all of them (insufficient when none). */
export function citeAll(input: AnswerInput): AnswerOutput {
  if (!input.contexts.length) return { answer: '', citedRefs: [], insufficient: true };
  return {
    answer: `記録によると: ${input.contexts.map((c) => `${c.text.split('\n')[0].slice(0, 60)} [${c.ref}]`).join(' / ')}`,
    citedRefs: input.contexts.map((c) => c.ref),
    insufficient: false,
    model: 'fake',
  };
}

/**
 * Fake AI provider for answer(). A cloud fake (isLocal=false) performs a guarded external call through call.http
 * exactly like a real cloud provider would, so the privacy guard (AI OFF / confidential re-check) is exercised.
 */
export class FakeAnswerProvider implements AiProvider {
  calls: { input: AnswerInput; call: AiCallCtx }[] = [];
  model = 'fake-answer';
  constructor(
    public id: AiProviderId = 'local-rules',
    public isLocal = true,
    public behavior: (input: AnswerInput) => AnswerOutput = citeAll,
  ) {}
  async available() {
    return { ok: true };
  }
  async extract(): Promise<never> {
    throw new Error('extract is not used by search tests');
  }
  async answer(input: AnswerInput, call: AiCallCtx): Promise<AnswerOutput> {
    this.calls.push({ input, call });
    if (!this.isLocal) {
      const res = await call.http.fetch({
        orgId: call.orgId,
        meetingIds: call.meetingIds,
        kind: 'ai',
        provider: this.id,
        purpose: call.purpose,
        decision: call.decision,
        url: 'https://api.openai.com/v1/chat/completions',
        init: { method: 'POST', body: JSON.stringify({ contexts: input.contexts.length }) },
      });
      if (!res.ok) throw new Error(`fake cloud ai failed ${res.status}`);
    }
    return this.behavior(input);
  }
}

export function searchRegistry(ai: AiProvider[], env: Record<string, string> = {}) {
  const cfg = loadConfig({ NODE_ENV: 'test', ...env });
  return new MapRegistry(new Map(), new Map(ai.map((p) => [p.id, p])), createEmbeddingProviders(cfg));
}

/** FakeHttp responder that mimics the OpenAI embeddings API (deterministic vectors, no network). */
export function fakeCloudResponder(call: ExternalCall): Response {
  if (call.kind === 'embedding') {
    const body = JSON.parse(String(call.init?.body ?? '{}'));
    const input: string[] = body.input ?? [];
    return new Response(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: hashEmbed(t, 64) })) }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
}

export async function mkMeeting(c: Client, ws: string, body: Record<string, unknown>) {
  const r = await c.post(`/api/w/${ws}/meetings`, { visibility: 'workspace', ...body });
  if (r.status !== 200) throw new Error(`meeting create failed ${r.status} ${r.raw}`);
  return r.body;
}

export async function reindex(env: TestEnv, orgId: string, meetingId: string) {
  await env.tenantTx(orgId, (db) => enqueueMeetingIndex(env.deps, db, orgId, meetingId));
  await env.worker.drain();
}

export async function insertDecision(
  env: TestEnv,
  orgId: string,
  ws: string,
  meetingId: string | null,
  f: { text: string; reviewState?: string; status?: string; ownerPersonId?: string | null; projectId?: string | null; startMs?: number; endMs?: number; reason?: string },
) {
  return env.tenantTx(orgId, async (db) => {
    const r = await db.query(
      `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, text, reason, review_state, status, owner_person_id, source_start_ms, source_end_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [orgId, ws, meetingId, f.projectId ?? null, f.text, f.reason ?? null, f.reviewState ?? 'confirmed', f.status ?? 'active', f.ownerPersonId ?? null, f.startMs ?? null, f.endMs ?? null],
    );
    return r.rows[0].id as string;
  });
}

export async function insertCommitment(
  env: TestEnv,
  orgId: string,
  ws: string,
  meetingId: string,
  f: { description: string; status?: string; byPersonId?: string | null; toText?: string | null; dueDate?: string | null },
) {
  return env.tenantTx(orgId, async (db) => {
    const r = await db.query(
      `INSERT INTO commitments(org_id, workspace_id, meeting_id, description, status, promised_by_person_id, promised_to_text, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [orgId, ws, meetingId, f.description, f.status ?? 'open', f.byPersonId ?? null, f.toText ?? null, f.dueDate ?? null],
    );
    return r.rows[0].id as string;
  });
}

export async function insertSummary(env: TestEnv, orgId: string, meetingId: string, executive: string) {
  return env.tenantTx(orgId, async (db) => {
    const r = await db.query(
      `INSERT INTO summaries(org_id, meeting_id, version, provider, sections) VALUES ($1,$2,1,'local-rules',$3) RETURNING id`,
      [orgId, meetingId, { executive, topics: [{ title: executive.slice(0, 20), evidence: { segmentIds: [], quote: 'x' } }], risks: [] }],
    );
    return r.rows[0].id as string;
  });
}

export async function countRows(env: TestEnv, orgId: string, table: 'ai_chunks' | 'search_docs', meetingId: string): Promise<number> {
  return env.tenantTx(orgId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE meeting_id=$1`, [meetingId])).rows[0].n);
}
