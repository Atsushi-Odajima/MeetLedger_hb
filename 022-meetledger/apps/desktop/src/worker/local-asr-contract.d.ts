// Type-only contract of @meetledger/local-asr as agreed with the local-asr engineer (packages/local-asr).
// tsc maps the import to this file (tsconfig "paths"); esbuild bundles the real packages/local-asr/src/index.ts.
// The worker still checks every export at runtime, so a missing/renamed export degrades to
// "端末内文字起こしは利用できません" instead of crashing.

export interface LocalAsrSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  speaker?: string | number;
}

export interface TranscribeFileOptions {
  modelDir: string;
  model?: string;
  numThreads?: number;
  diarization?: boolean;
  language?: string;
}

export interface TranscribeFileResult {
  segments: LocalAsrSegment[];
  model: string;
  language: string;
  diarization: boolean;
}

export declare const MODEL_CATALOG: unknown;
export declare function checkModels(modelDir: string, modelId: string): unknown;
export declare function downloadModel(id: string, modelDir: string, onProgress?: (...args: unknown[]) => void): Promise<unknown>;
export declare function transcribeFile(wav16kMonoPath: string, opts: TranscribeFileOptions): Promise<TranscribeFileResult>;
