import type { Config } from '../../config';
import type { TranscriptionProvider } from './types';

// Placeholder: the owning module registers its providers here.
export function createTranscriptionProviders(_cfg: Config): Map<string, TranscriptionProvider> {
  return new Map();
}
