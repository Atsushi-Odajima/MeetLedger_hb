import type { Config } from '../../config';
import type { EmbeddingProvider } from './types';

// Placeholder: the owning module registers its providers here.
export function createEmbeddingProviders(_cfg: Config): Map<string, EmbeddingProvider> {
  return new Map();
}
