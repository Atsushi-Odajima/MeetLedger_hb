import type { ExternalHttp } from '../../privacy/externalHttp';
import type { PolicyDecision } from '../../privacy/policy';

export interface TranscriptionInput {
  /** 16 kHz mono 16-bit PCM WAV produced by the audio pipeline. */
  audioPath: string;
  /** Optional 16 kHz stereo WAV (ch0 = local mic, ch1 = system/remote) for channel-based speaker separation. */
  stereoPath?: string | null;
  durationMs: number;
  language: 'ja' | 'en' | 'auto';
  /** Scratch directory owned by the job (deleted afterwards). Providers may write derived files here. */
  workDir?: string;
}

export interface RawSegment {
  startMs: number;
  endMs: number;
  /** Text exactly as recognized. Unintelligible audio MUST stay "[inaudible]" (never filled in). */
  text: string;
  confidence?: number | null;
  /** Provider speaker label (e.g. "A", "speaker_0"). Normalized later to "Speaker N". */
  speaker?: string | null;
}

export interface TranscriptionResult {
  provider: string;
  model?: string | null;
  isLocal: boolean;
  language?: string | null;
  segments: RawSegment[];
  /** Whether segments carry provider diarization. */
  diarization: 'provider' | 'none';
  /** Non-content notes for quality flags (e.g. diarization unavailable). */
  notes?: string[];
}

export interface TranscriptionCallCtx {
  http: ExternalHttp;
  orgId: string;
  meetingId: string;
  decision: PolicyDecision;
}

export interface TranscriptionProvider {
  id: string;
  isLocal: boolean;
  available(): Promise<{ ok: boolean; reason?: string }>;
  transcribe(input: TranscriptionInput, call: TranscriptionCallCtx): Promise<TranscriptionResult>;
}

/** Error that must not be retried (bad credentials, unsupported input, policy). Recognized by the job worker. */
export class PermanentTranscriptionError extends Error {
  readonly permanent = true;
}
