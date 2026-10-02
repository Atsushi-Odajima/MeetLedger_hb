// Cloud / self-hosted LLM adapters. All requests go through call.http.fetch (privacy guard + external_calls audit).
// Model ids are configurable with AI_MODEL (applies to the provider selected by AI_PROVIDER).
import type { AiProviderId } from '@meetledger/shared';
import type { Config } from '../../config';
import type { AiCallCtx, AiProvider, AnswerInput, AnswerOutput, ExtractionInput, ExtractionOutput } from './types';
import {
  AI_TIMEOUT_MS,
  ANSWER_SCHEMA,
  EXTRACTION_SCHEMA,
  aiFetch,
  buildAnswerPrompt,
  buildExtractionPrompt,
  checkedJson,
  parseAnswerJson,
  parseExtractionJson,
  parseJsonText,
  providerError,
} from './llm';

/** Defaults when AI_MODEL is not set. OpenAI/Ollama ids are taken from docs/research (not verified against the live API): set AI_MODEL explicitly. */
export const DEFAULT_MODELS: Record<'openai' | 'anthropic' | 'ollama', string> = {
  openai: 'gpt-6.1-sol',
  anthropic: 'claude-opus-5-5',
  ollama: 'qwen3:8b',
};

export function modelFor(cfg: Config, id: 'openai' | 'anthropic' | 'ollama'): string {
  return cfg.AI_PROVIDER === id && cfg.AI_MODEL ? cfg.AI_MODEL : DEFAULT_MODELS[id];
}

abstract class JsonLlmProvider implements AiProvider {
  abstract readonly id: AiProviderId;
  abstract readonly isLocal: boolean;
  constructor(public readonly model: string) {}
  abstract available(): Promise<{ ok: boolean; reason?: string }>;
  /** Returns the model's JSON text for the given prompt and JSON schema. */
  protected abstract completeJson(system: string, user: string, schemaName: string, schema: object, call: AiCallCtx): Promise<string>;

  async extract(input: ExtractionInput, call: AiCallCtx): Promise<ExtractionOutput> {
    const p = buildExtractionPrompt(input);
    const text = await this.completeJson(p.system, p.user, 'meetledger_extraction', EXTRACTION_SCHEMA, call);
    return parseExtractionJson(parseJsonText(text), p.refs, this.model);
  }

  async answer(input: AnswerInput, call: AiCallCtx): Promise<AnswerOutput> {
    const p = buildAnswerPrompt(input);
    const text = await this.completeJson(p.system, p.user, 'meetledger_answer', ANSWER_SCHEMA, call);
    return parseAnswerJson(parseJsonText(text), p.refs, this.model);
  }
}

// ---------------------------------------------------------------- OpenAI (Responses API, structured output)
export class OpenAiProvider extends JsonLlmProvider {
  readonly id = 'openai' as const;
  readonly isLocal = false;
  constructor(private cfg: Config) {
    super(modelFor(cfg, 'openai'));
  }
  async available() {
    return this.cfg.OPENAI_API_KEY ? { ok: true } : { ok: false, reason: 'OPENAI_API_KEY が設定されていません' };
  }
  protected async completeJson(system: string, user: string, schemaName: string, schema: object, call: AiCallCtx) {
    const res = await aiFetch(call, 'openai', `${this.cfg.OPENAI_BASE_URL.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: this.model,
        instructions: system,
        input: [{ role: 'user', content: user }],
        text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
        // Do not keep the conversation on OpenAI's side.
        store: false,
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    const data = await checkedJson(res, 'openai');
    if (data?.status && data.status !== 'completed') throw providerError(`openai response status ${String(data.status).slice(0, 30)}`, false);
    if (typeof data?.output_text === 'string') return data.output_text;
    let text = '';
    for (const item of Array.isArray(data?.output) ? data.output : []) {
      if (item?.type !== 'message') continue;
      for (const c of Array.isArray(item.content) ? item.content : []) {
        if (c?.type === 'refusal') throw providerError('openai refused the request', true);
        if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    }
    if (!text) throw providerError('openai returned no output text', false);
    return text;
  }
}

// ---------------------------------------------------------------- Anthropic (Messages API, output_config.format json_schema)
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export class AnthropicProvider extends JsonLlmProvider {
  readonly id = 'anthropic' as const;
  readonly isLocal = false;
  constructor(private cfg: Config) {
    super(modelFor(cfg, 'anthropic'));
  }
  async available() {
    return this.cfg.ANTHROPIC_API_KEY ? { ok: true } : { ok: false, reason: 'ANTHROPIC_API_KEY が設定されていません' };
  }
  protected async completeJson(system: string, user: string, _schemaName: string, schema: object, call: AiCallCtx) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.cfg.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    };
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
    };
    if (ANTHROPIC_FALLBACK_MODELS.has(this.model)) {
      // On a safety decline the API re-runs the request on a fallback Claude model (same provider; no extra data leaves).
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    const res = await aiFetch(call, 'anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    const data = await checkedJson(res, 'anthropic');
    if (data?.stop_reason === 'refusal') throw providerError('anthropic declined the request', true);
    if (data?.stop_reason === 'max_tokens') throw providerError('anthropic output was truncated (max_tokens)', false);
    let text = '';
    for (const b of Array.isArray(data?.content) ? data.content : []) if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
    if (!text) throw providerError('anthropic returned no text', false);
    return text;
  }
}

// ---------------------------------------------------------------- Ollama (self-hosted, /api/chat with JSON schema format)
export class OllamaProvider extends JsonLlmProvider {
  readonly id = 'ollama' as const;
  readonly isLocal = true;
  constructor(private cfg: Config) {
    super(modelFor(cfg, 'ollama'));
  }
  async available() {
    return this.cfg.OLLAMA_URL ? { ok: true } : { ok: false, reason: 'OLLAMA_URL が設定されていません' };
  }
  protected async completeJson(system: string, user: string, _schemaName: string, schema: object, call: AiCallCtx) {
    const base = this.cfg.OLLAMA_URL.replace(/\/$/, '');
    let host = 'ollama';
    try {
      host = new URL(base).host;
    } catch {
      /* keep */
    }
    // Ollama is an operator-hosted LLM reached over HTTP. GuardedHttp only lets content-bearing calls through for
    // non-local decisions, so the call is declared as a network transfer to OLLAMA_URL (the guard still re-checks AI OFF /
    // confidential in the DB and records the call in external_calls). See docs/AI_EXTRACTION.md.
    const viaHttp: AiCallCtx = { ...call, decision: { ...call.decision, isLocal: false, reason: `${call.decision.reason} / Ollama HTTP (${host})` } };
    const res = await aiFetch(viaHttp, 'ollama', `${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: schema,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    const data = await checkedJson(res, 'ollama');
    const text = data?.message?.content;
    if (typeof text !== 'string' || !text) throw providerError('ollama returned no content', false);
    return text;
  }
}
