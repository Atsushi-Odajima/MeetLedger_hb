import type { AiCallCtx } from '../ai/types';

export interface EmbeddingProvider {
  id: string;
  isLocal: boolean;
  model: string;
  dims: number;
  /** Honest, human readable description (shown in the AI privacy preview). */
  description?: string;
  /**
   * Returns one L2-normalized vector per input text. Remote providers MUST send through `call.http.fetch`
   * (kind 'embedding', with `call.decision` and `call.meetingIds`) so the privacy guard can re-check the meetings.
   */
  embed(texts: string[], call: AiCallCtx): Promise<number[][]>;
}
