import type { Config } from '../../config';
import type { AiCallCtx } from '../ai/types';
import type { EmbeddingProvider } from './types';

const BATCH = 64;

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 ? v.map((x) => x / n) : v;
}

function permanent(message: string) {
  return Object.assign(new Error(message), { permanent: true });
}

function assertVectors(vs: unknown, expected: number, provider: string): number[][] {
  if (!Array.isArray(vs) || vs.length !== expected) throw new Error(`${provider} embeddings: unexpected response shape`);
  const dims = Array.isArray(vs[0]) ? vs[0].length : 0;
  for (const v of vs) {
    if (!Array.isArray(v) || v.length !== dims || !dims || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`${provider} embeddings: invalid vector`);
  }
  return (vs as number[][]).map(normalize);
}

/**
 * OpenAI text-embedding-3-small. Cloud: only used when the workspace allows cloud AI and the installation enables it.
 * Every request goes through `call.http` (privacy guard re-checks AI OFF / confidential for `call.meetingIds`).
 * Error messages never include response bodies (they may echo content).
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly isLocal = false;
  readonly model = 'text-embedding-3-small';
  readonly dims = 1536;
  readonly description = 'OpenAI text-embedding-3-small (cloud)';
  constructor(private cfg: Pick<Config, 'OPENAI_API_KEY' | 'OPENAI_BASE_URL'>) {}

  async embed(texts: string[], call: AiCallCtx): Promise<number[][]> {
    if (!texts.length) return [];
    if (!this.cfg.OPENAI_API_KEY) throw permanent('OPENAI_API_KEY is not configured');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await call.http.fetch({
        orgId: call.orgId,
        meetingIds: call.meetingIds,
        kind: 'embedding',
        provider: 'openai',
        purpose: call.purpose,
        decision: call.decision,
        url: `${this.cfg.OPENAI_BASE_URL.replace(/\/+$/, '')}/embeddings`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: this.model, input: batch, encoding_format: 'float' }),
        },
      });
      if (!res.ok) throw new Error(`OpenAI embeddings failed (HTTP ${res.status})`);
      const j: any = await res.json().catch(() => null);
      const data: any[] = Array.isArray(j?.data) ? [...j.data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)) : [];
      out.push(...assertVectors(data.map((d) => d?.embedding), batch.length, 'OpenAI'));
    }
    return out;
  }
}

/**
 * Ollama embeddings on a self-hosted server (OLLAMA_URL, normally loopback / LAN). Data stays inside the
 * installation, but the request still goes through `call.http` with kind 'embedding' and the (local) decision.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';
  readonly isLocal = true;
  readonly dims = 768;
  readonly description: string;
  constructor(
    private cfg: Pick<Config, 'OLLAMA_URL'>,
    readonly model = 'nomic-embed-text',
  ) {
    this.description = `Ollama ${model} (self-hosted, ${safeHost(cfg.OLLAMA_URL)})`;
  }

  async embed(texts: string[], call: AiCallCtx): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await call.http.fetch({
        orgId: call.orgId,
        meetingIds: call.meetingIds,
        kind: 'embedding',
        provider: 'ollama',
        purpose: call.purpose,
        decision: call.decision,
        url: `${this.cfg.OLLAMA_URL.replace(/\/+$/, '')}/api/embed`,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, input: batch }) },
      });
      if (!res.ok) throw new Error(`Ollama embeddings failed (HTTP ${res.status})`);
      const j: any = await res.json().catch(() => null);
      out.push(...assertVectors(j?.embeddings, batch.length, 'Ollama'));
    }
    return out;
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
