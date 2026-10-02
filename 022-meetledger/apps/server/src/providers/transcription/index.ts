import { dirname, join, resolve } from 'node:path';
import type { Config } from '../../config';
import { DeepgramTranscriptionProvider } from './deepgram';
import { FixtureTranscriptionProvider } from './fixture';
import { LocalSherpaProvider } from './localSherpa';
import { OpenAiTranscriptionProvider } from './openai';
import type { TranscriptionProvider } from './types';

export { registerFixtureTranscript, clearFixtureTranscripts, FixtureTranscriptionProvider } from './fixture';
export type { FixtureTranscript } from './fixture';
export { PermanentTranscriptionError } from './types';

/** Directory holding fixture transcripts: `<LOCAL_ASR_MODEL_DIR>/../fixtures/transcripts`. */
export function fixturesDir(cfg: Pick<Config, 'LOCAL_ASR_MODEL_DIR'>): string {
  return join(dirname(resolve(cfg.LOCAL_ASR_MODEL_DIR)), 'fixtures', 'transcripts');
}

/**
 * Transcription providers of this installation. Local: 'local-sherpa' (sherpa-onnx), 'fixture' (deterministic).
 * Cloud: 'openai', 'deepgram' (used only when decideTranscription() allows it; all calls go through deps.http).
 * Optional env (read here, not in config.ts): LOCAL_ASR_NUM_THREADS, LOCAL_ASR_DIARIZATION=auto|on|off.
 */
export function createTranscriptionProviders(cfg: Config): Map<string, TranscriptionProvider> {
  const threads = Number.parseInt(process.env.LOCAL_ASR_NUM_THREADS ?? '', 10);
  const diar = process.env.LOCAL_ASR_DIARIZATION;
  const m = new Map<string, TranscriptionProvider>();
  m.set(
    'local-sherpa',
    new LocalSherpaProvider({
      modelDir: cfg.LOCAL_ASR_MODEL_DIR,
      model: cfg.LOCAL_ASR_MODEL,
      numThreads: Number.isFinite(threads) && threads > 0 ? threads : undefined,
      diarization: diar === 'on' || diar === 'off' ? diar : 'auto',
    }),
  );
  m.set('fixture', new FixtureTranscriptionProvider(fixturesDir(cfg)));
  m.set('openai', new OpenAiTranscriptionProvider(cfg));
  m.set('deepgram', new DeepgramTranscriptionProvider(cfg));
  return m;
}
