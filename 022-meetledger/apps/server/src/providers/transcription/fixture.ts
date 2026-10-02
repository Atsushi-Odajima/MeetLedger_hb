import { wavPcmSha256 } from '@meetledger/local-asr';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawSegment, TranscriptionCallCtx, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from './types';
import { PermanentTranscriptionError } from './types';

/** Fixture transcript format (`<fixturesDir>/<sha256-of-normalized-PCM>.json`). */
export interface FixtureTranscript {
  language?: string | null;
  model?: string | null;
  diarization?: 'provider' | 'none';
  segments: RawSegment[];
}

// Test/demo registry: sha256 of the normalized 16 kHz mono PCM payload -> transcript. '*' = default for any input.
const registry = new Map<string, FixtureTranscript>();

export function registerFixtureTranscript(pcmSha256: string | '*', t: FixtureTranscript) {
  registry.set(pcmSha256, t);
}
export function clearFixtureTranscripts() {
  registry.clear();
}

/**
 * Deterministic local provider for tests, demos and E2E. Looks up the transcript by the SHA-256 of the normalized PCM
 * (see wavPcmSha256) in the registry, then in `<LOCAL_ASR_MODEL_DIR>/../fixtures/transcripts/<sha>.json`.
 * Never makes network calls and never invents text: a missing fixture is a permanent error.
 */
export class FixtureTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'fixture';
  readonly isLocal = true;
  /** Number of transcribe() invocations (tests assert idempotency with it). */
  calls = 0;
  constructor(private fixturesDir: string) {}

  async available() {
    return { ok: true };
  }

  lookup(sha: string): FixtureTranscript | null {
    const hit = registry.get(sha);
    if (hit) return hit;
    const file = join(this.fixturesDir, `${sha}.json`);
    if (/^[0-9a-f]{64}$/.test(sha) && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as FixtureTranscript;
    return registry.get('*') ?? null;
  }

  async transcribe(input: TranscriptionInput, _call: TranscriptionCallCtx): Promise<TranscriptionResult> {
    this.calls++;
    const sha = wavPcmSha256(input.audioPath);
    const t = this.lookup(sha);
    if (!t) throw new PermanentTranscriptionError(`fixture transcript not found for input ${sha.slice(0, 12)}…`);
    return {
      provider: this.id,
      model: t.model ?? 'fixture',
      isLocal: true,
      language: t.language ?? (input.language === 'auto' ? null : input.language),
      diarization: t.diarization ?? (t.segments.some((s) => s.speaker) ? 'provider' : 'none'),
      segments: t.segments.map((s) => ({ ...s })),
    };
  }
}
