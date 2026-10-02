import type { Config } from '../../config';
import { multipartBody, prepareCloudAudio, providerHttpError, toLangParam } from './cloudUtil';
import type { RawSegment, TranscriptionCallCtx, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from './types';
import { PermanentTranscriptionError } from './types';

// OpenAI Speech-to-Text (POST /v1/audio/transcriptions). Model is configurable (OPENAI_TRANSCRIBE_MODEL).
// NOTE (research A, 2026-10-02): OpenAI announced that whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe /
// gpt-4o-transcribe-diarize shut down on 2027-02-26. Successor: gpt-transcribe (diarization support unverified).
// Only *-diarize models return speaker labels (response_format=diarized_json).

const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

type Format = 'diarized_json' | 'verbose_json' | 'json';

export function openAiResponseFormat(model: string): Format {
  if (/diariz/i.test(model)) return 'diarized_json';
  if (/^whisper/i.test(model)) return 'verbose_json';
  return 'json';
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openai';
  readonly isLocal = false;
  constructor(private cfg: Config) {}

  async available() {
    if (!this.cfg.OPENAI_API_KEY) return { ok: false, reason: 'OPENAI_API_KEY が設定されていません' };
    return { ok: true };
  }

  async transcribe(input: TranscriptionInput, call: TranscriptionCallCtx): Promise<TranscriptionResult> {
    if (!this.cfg.OPENAI_API_KEY) throw new PermanentTranscriptionError('OPENAI_API_KEY が設定されていません');
    const model = this.cfg.OPENAI_TRANSCRIBE_MODEL;
    const format = openAiResponseFormat(model);
    const audio = await prepareCloudAudio(input.audioPath, OPENAI_MAX_BYTES - 64 * 1024, this.cfg.FFMPEG_PATH, input.workDir);
    const fields: [string, string][] = [
      ['model', model],
      ['response_format', format],
    ];
    if (format === 'diarized_json') fields.push(['chunking_strategy', 'auto']);
    if (format === 'verbose_json') fields.push(['timestamp_granularities[]', 'segment']);
    const lang = toLangParam(input.language);
    if (lang) fields.push(['language', lang]);
    const mp = multipartBody(fields, { field: 'file', ...audio });
    const res = await call.http.fetch({
      orgId: call.orgId,
      meetingIds: [call.meetingId],
      kind: 'transcription',
      provider: this.id,
      purpose: 'meeting_transcription',
      decision: call.decision,
      url: `${this.cfg.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`,
      init: { method: 'POST', headers: { authorization: `Bearer ${this.cfg.OPENAI_API_KEY}`, 'content-type': mp.contentType }, body: mp.body },
    });
    if (!res.ok) throw providerHttpError('openai', res.status);
    const j: any = await res.json();
    return { provider: this.id, model, isLocal: false, language: j.language ?? lang, ...mapOpenAi(j, format, input.durationMs) };
  }
}

export function mapOpenAi(j: any, format: Format, durationMs: number): { segments: RawSegment[]; diarization: 'provider' | 'none' } {
  const segs: any[] = Array.isArray(j?.segments) ? j.segments : [];
  if (format === 'diarized_json' && segs.length) {
    return {
      diarization: 'provider',
      segments: segs.map((s) => ({ startMs: Math.round(Number(s.start) * 1000), endMs: Math.round(Number(s.end) * 1000), text: String(s.text ?? ''), speaker: s.speaker != null ? String(s.speaker) : null, confidence: null })),
    };
  }
  if (segs.length) {
    return {
      diarization: 'none',
      segments: segs.map((s) => {
        // Whisper's own silence rule: high no_speech_prob + low avg_logprob => no reliable speech (not filled in).
        const silent = Number(s.no_speech_prob) > 0.6 && Number(s.avg_logprob) < -1;
        const conf = typeof s.avg_logprob === 'number' ? Math.max(0, Math.min(1, Math.exp(s.avg_logprob))) : null;
        return { startMs: Math.round(Number(s.start) * 1000), endMs: Math.round(Number(s.end) * 1000), text: silent ? '' : String(s.text ?? ''), confidence: silent ? 0 : conf, speaker: null };
      }),
    };
  }
  // Plain json: one segment without timestamps (the model returns none).
  const text = String(j?.text ?? '');
  return { diarization: 'none', segments: text || durationMs ? [{ startMs: 0, endMs: durationMs, text, confidence: null, speaker: null }] : [] };
}
