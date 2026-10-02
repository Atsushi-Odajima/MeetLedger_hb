import type { Config } from '../../config';
import type { Deps } from '../../context';
import { safeErrorMessage } from '../../lib/logger';
import { decideEmbedding, type MeetingPolicyInput, type PolicyDecision, type WorkspaceSettings } from '../../privacy/policy';
import { LocalHashEmbeddingProvider, LOCAL_HASH_MODEL } from '../../providers/embeddings/localHash';
import type { EmbeddingProvider } from '../../providers/embeddings/types';

const builtinLocal = new LocalHashEmbeddingProvider();

/**
 * Workspace embedding decision = decideEmbedding (workspace opt-in) AND the installation enabling that provider
 * (EMBEDDING_PROVIDER), mirroring how AI providers are gated. Falls back to the local lexical hash embedding.
 */
export function embeddingDecision(s: WorkspaceSettings, cfg: Config): PolicyDecision {
  const d = decideEmbedding(s);
  if (d.provider !== 'local-hash' && cfg.EMBEDDING_PROVIDER !== d.provider) {
    return { allowed: true, provider: 'local-hash', isLocal: true, reason: `${d.provider} embedding はこのインストールで有効化されていません（local-hash を使用）` };
  }
  return d;
}

/** Per meeting: AI OFF / confidential meetings are never embedded (not part of the AI index at all). */
export function meetingEmbeddingDecision(m: MeetingPolicyInput & { deleted_at?: unknown }, s: WorkspaceSettings, cfg: Config): PolicyDecision {
  if (m.deleted_at) return { allowed: false, provider: 'none', isLocal: true, reason: '削除済みMeetingはindex対象外です' };
  if (!m.ai_enabled) return { allowed: false, provider: 'none', isLocal: true, reason: 'このMeetingはAI OFFです（AI index・AI検索の対象外）' };
  if (m.is_confidential) return { allowed: false, provider: 'none', isLocal: true, reason: 'Confidential MeetingはAI index対象外です' };
  return embeddingDecision(s, cfg);
}

export function aiEligible(m: { ai_enabled: boolean; is_confidential: boolean; deleted_at?: unknown }): boolean {
  return !!m.ai_enabled && !m.is_confidential && !m.deleted_at;
}

export function embeddingProviderFor(deps: Deps, decision: PolicyDecision): EmbeddingProvider {
  if (!decision.allowed || decision.provider === 'none') return builtinLocal;
  try {
    return deps.providers.embeddings(decision.provider);
  } catch {
    try {
      return deps.providers.embeddings('local-hash');
    } catch {
      return builtinLocal;
    }
  }
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  provider: string;
  fallbackReason?: string;
}

/**
 * Embeds texts with the decided provider. On any failure (policy denial by the guard, network, bad response)
 * it falls back to the local lexical hash embedding so the index stays usable; the fallback is reported in the
 * job result (never silently claims the cloud model was used).
 */
export async function embedTexts(
  deps: Deps,
  decision: PolicyDecision,
  texts: string[],
  call: { orgId: string; meetingIds: string[]; purpose: string },
): Promise<EmbedResult> {
  const p = embeddingProviderFor(deps, decision);
  try {
    const vectors = await p.embed(texts, { http: deps.http, orgId: call.orgId, meetingIds: call.meetingIds, decision, purpose: call.purpose });
    if (vectors.length !== texts.length) throw new Error('embedding count mismatch');
    return { vectors, model: p.model, provider: p.id };
  } catch (e) {
    const reason = safeErrorMessage(e);
    deps.log.warn({ provider: p.id, purpose: call.purpose, count: texts.length, err: reason }, 'embedding failed; using local-hash fallback');
    return { vectors: await builtinLocal.embed(texts), model: LOCAL_HASH_MODEL, provider: 'local-hash', fallbackReason: reason };
  }
}

export const localHashProvider = builtinLocal;
