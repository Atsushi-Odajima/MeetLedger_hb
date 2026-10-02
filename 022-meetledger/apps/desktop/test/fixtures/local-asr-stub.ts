// TEST FIXTURE ONLY (scripts/build.mjs --local-asr=stub, used by scripts/smoke.mjs). Implements the agreed
// @meetledger/local-asr API without sherpa-onnx so the utility-process plumbing, model download confirmation,
// speaker attribution and POST /transcript/local can be exercised end-to-end. Never shipped.
import fs from 'node:fs';
import path from 'node:path';

export const MODEL_CATALOG = [
  { id: 'stub-ja', name: 'Stub JA model', languages: ['ja'], sizeBytes: 2048, license: 'MIT', attribution: 'MeetLedger test fixture', url: 'https://example.invalid/stub' },
];

export function checkModels(modelDir: string, modelId: string) {
  return { ok: fs.existsSync(path.join(modelDir, modelId, 'ready')) };
}

export async function downloadModel(id: string, modelDir: string, onProgress?: (...a: unknown[]) => void) {
  for (let i = 0; i <= 2048; i += 1024) onProgress?.(i, 2048);
  fs.mkdirSync(path.join(modelDir, id), { recursive: true });
  fs.writeFileSync(path.join(modelDir, id, 'ready'), 'ok');
}

export async function transcribeFile(wavPath: string, opts: { model?: string; language?: string; diarization?: boolean }) {
  const buf = fs.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.readUInt32LE(24) !== 16000 || buf.readUInt16LE(22) !== 1) throw new Error('stub expects 16k mono wav');
  const durationMs = Math.floor(((buf.length - 44) / 2 / 16000) * 1000);
  const segments = [];
  for (let t = 0, n = 1; t + 500 <= durationMs; t += 1000, n++) {
    segments.push({ startMs: t, endMs: Math.min(durationMs, t + 1000), text: `テスト発話${n}`, confidence: 0.9, speaker: n % 2 ? 'S0' : 'S1' });
  }
  return { segments, model: opts.model ?? 'stub-ja', language: opts.language ?? 'ja', diarization: opts.diarization === true };
}
