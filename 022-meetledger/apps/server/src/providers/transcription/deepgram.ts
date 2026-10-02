import type { Config } from '../../config';
import { prepareCloudAudio, providerHttpError } from './cloudUtil';
import type { RawSegment, TranscriptionCallCtx, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from './types';
import { PermanentTranscriptionError } from './types';

// Deepgram pre-recorded STT (POST /v1/listen). Model configurable via DEEPGRAM_MODEL (default nova-3).
// mip_opt_out=true opts out of Deepgram's Model Improvement Program for every request.

const DEEPGRAM_MAX_BYTES = 200 * 1024 * 1024;

export function deepgramUrl(base: string, model: string, language: 'ja' | 'en' | 'auto'): string {
  const u = new URL(`${base.replace(/\/$/, '')}/listen`);
  u.searchParams.set('model', model);
  u.searchParams.set('diarize', 'true');
  u.searchParams.set('punctuate', 'true');
  u.searchParams.set('smart_format', 'true');
  u.searchParams.set('utterances', 'true');
  u.searchParams.set('mip_opt_out', 'true');
  u.searchParams.set('language', language === 'auto' ? 'multi' : language);
  return u.toString();
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'deepgram';
  readonly isLocal = false;
  readonly model: string;
  readonly baseUrl: string;
  constructor(private cfg: Config) {
    // Optional env (not part of config.ts): DEEPGRAM_MODEL, DEEPGRAM_BASE_URL (e.g. https://api.eu.deepgram.com/v1).
    this.model = process.env.DEEPGRAM_MODEL || 'nova-3';
    this.baseUrl = process.env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com/v1';
  }

  async available() {
    if (!this.cfg.DEEPGRAM_API_KEY) return { ok: false, reason: 'DEEPGRAM_API_KEY が設定されていません' };
    return { ok: true };
  }

  async transcribe(input: TranscriptionInput, call: TranscriptionCallCtx): Promise<TranscriptionResult> {
    if (!this.cfg.DEEPGRAM_API_KEY) throw new PermanentTranscriptionError('DEEPGRAM_API_KEY が設定されていません');
    const audio = await prepareCloudAudio(input.audioPath, DEEPGRAM_MAX_BYTES, this.cfg.FFMPEG_PATH, input.workDir);
    const res = await call.http.fetch({
      orgId: call.orgId,
      meetingIds: [call.meetingId],
      kind: 'transcription',
      provider: this.id,
      purpose: 'meeting_transcription',
      decision: call.decision,
      url: deepgramUrl(this.baseUrl, this.model, input.language),
      init: { method: 'POST', headers: { authorization: `Token ${this.cfg.DEEPGRAM_API_KEY}`, 'content-type': audio.mime }, body: audio.data },
    });
    if (!res.ok) throw providerHttpError('deepgram', res.status);
    const j: any = await res.json();
    const ch = j?.results?.channels?.[0];
    const language = ch?.detected_language ?? (input.language === 'auto' ? null : input.language);
    return { provider: this.id, model: this.model, isLocal: false, language, ...mapDeepgram(j, input.durationMs) };
  }
}

export function mapDeepgram(j: any, durationMs: number): { segments: RawSegment[]; diarization: 'provider' | 'none' } {
  const utts: any[] = j?.results?.utterances ?? [];
  if (utts.length) {
    return {
      diarization: utts.some((u) => u.speaker != null) ? 'provider' : 'none',
      segments: utts.map((u) => ({
        startMs: Math.round(Number(u.start) * 1000),
        endMs: Math.round(Number(u.end) * 1000),
        text: String(u.transcript ?? ''),
        confidence: typeof u.confidence === 'number' ? u.confidence : null,
        speaker: u.speaker != null ? `speaker_${u.speaker}` : null,
      })),
    };
  }
  // Fallback: group words by speaker turns.
  const words: any[] = j?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  if (words.length) {
    const out: RawSegment[] = [];
    let confSum = 0;
    let n = 0;
    for (const w of words) {
      const spk = w.speaker != null ? `speaker_${w.speaker}` : null;
      const last = out[out.length - 1];
      const word = String(w.punctuated_word ?? w.word ?? '');
      if (last && last.speaker === spk && Number(w.start) * 1000 - last.endMs < 1500) {
        last.text += ` ${word}`;
        last.endMs = Math.round(Number(w.end) * 1000);
        confSum += Number(w.confidence ?? 0);
        n++;
        last.confidence = confSum / n;
      } else {
        confSum = Number(w.confidence ?? 0);
        n = 1;
        out.push({ startMs: Math.round(Number(w.start) * 1000), endMs: Math.round(Number(w.end) * 1000), text: word, confidence: confSum, speaker: spk });
      }
    }
    return { diarization: out.some((s) => s.speaker) ? 'provider' : 'none', segments: out };
  }
  const text = String(j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '');
  return { diarization: 'none', segments: text ? [{ startMs: 0, endMs: durationMs, text, confidence: null, speaker: null }] : [] };
}
