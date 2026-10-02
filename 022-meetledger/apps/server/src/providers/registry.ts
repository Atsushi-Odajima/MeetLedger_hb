import type { Config } from '../config';
import type { AiProvider } from './ai/types';
import type { EmbeddingProvider } from './embeddings/types';
import type { TranscriptionProvider } from './transcription/types';
import { createTranscriptionProviders } from './transcription';
import { createAiProviders } from './ai';
import { createEmbeddingProviders } from './embeddings';

export interface ProviderRegistry {
  transcription(id: string): TranscriptionProvider;
  ai(id: string): AiProvider;
  embeddings(id: string): EmbeddingProvider;
  list(): { transcription: string[]; ai: string[]; embeddings: string[] };
}

export class MapRegistry implements ProviderRegistry {
  constructor(
    public t: Map<string, TranscriptionProvider>,
    public a: Map<string, AiProvider>,
    public e: Map<string, EmbeddingProvider>,
  ) {}
  transcription(id: string) {
    const p = this.t.get(id);
    if (!p) throw new Error(`transcription provider '${id}' is not configured`);
    return p;
  }
  ai(id: string) {
    const p = this.a.get(id);
    if (!p) throw new Error(`AI provider '${id}' is not configured`);
    return p;
  }
  embeddings(id: string) {
    const p = this.e.get(id);
    if (!p) throw new Error(`embedding provider '${id}' is not configured`);
    return p;
  }
  list() {
    return { transcription: [...this.t.keys()], ai: [...this.a.keys()], embeddings: [...this.e.keys()] };
  }
}

export function createProviders(cfg: Config): MapRegistry {
  return new MapRegistry(createTranscriptionProviders(cfg), createAiProviders(cfg), createEmbeddingProviders(cfg));
}
