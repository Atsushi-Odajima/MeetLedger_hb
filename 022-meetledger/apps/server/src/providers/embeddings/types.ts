import type { AiCallCtx } from '../ai/types';

export interface EmbeddingProvider {
  id: string;
  isLocal: boolean;
  model: string;
  dims: number;
  embed(texts: string[], call: AiCallCtx): Promise<number[][]>;
}
