import type { Config } from '../../config';
import type { EmbeddingProvider } from './types';
import { LocalHashEmbeddingProvider } from './localHash';
import { OllamaEmbeddingProvider, OpenAiEmbeddingProvider } from './remote';

export { LocalHashEmbeddingProvider, hashEmbed, cosine, LOCAL_HASH_MODEL, LOCAL_HASH_DIMS } from './localHash';
export { OpenAiEmbeddingProvider, OllamaEmbeddingProvider } from './remote';

/**
 * All embedding providers known to this installation. Which one is USED is a policy decision
 * (workspace settings.ai.embeddings + cloudAllowed + installation EMBEDDING_PROVIDER), see modules/search/embed.ts.
 */
export function createEmbeddingProviders(cfg: Config): Map<string, EmbeddingProvider> {
  const m = new Map<string, EmbeddingProvider>();
  m.set('local-hash', new LocalHashEmbeddingProvider());
  m.set('openai', new OpenAiEmbeddingProvider(cfg));
  m.set('ollama', new OllamaEmbeddingProvider(cfg));
  return m;
}
