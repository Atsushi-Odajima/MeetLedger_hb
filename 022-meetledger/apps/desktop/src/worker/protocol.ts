// Message protocol between main (asrHost.ts) and the ASR utility process (asrWorker.ts).
import type { ModelInfo } from '../shared/ipc';

export type WorkerMethod = 'probe' | 'catalog' | 'download' | 'transcribe';

export interface WorkerRequest {
  id: number;
  method: WorkerMethod;
  params: Record<string, unknown>;
}

export type WorkerMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | { id: number; progress: unknown[] };

export interface ProbeResult {
  module: { ok: boolean; missing: string[]; error: string | null };
  runtime: { ok: boolean; error: string | null };
}

export interface CatalogResult {
  models: ModelInfo[];
}
