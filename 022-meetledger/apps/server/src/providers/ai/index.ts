import type { Config } from '../../config';
import type { AiProvider } from './types';

// Placeholder: the owning module registers its providers here.
export function createAiProviders(_cfg: Config): Map<string, AiProvider> {
  return new Map();
}
