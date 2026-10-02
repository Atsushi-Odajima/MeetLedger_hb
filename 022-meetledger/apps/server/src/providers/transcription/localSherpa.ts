import { localAsrAvailable, transcribeFile } from '@meetledger/local-asr';
import { resolve } from 'node:path';
import type { TranscriptionCallCtx, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from './types';
import { PermanentTranscriptionError } from './types';

export interface LocalSherpaOptions {
  modelDir: string;
  model: string;
  numThreads?: number;
  /** 'auto' (default): diarize when the diarization models are installed; 'on' / 'off'. */
  diarization?: 'auto' | 'on' | 'off';
}

/**
 * On-server transcription with sherpa-onnx (SenseVoice + Silero VAD, optional pyannote/CAM++ diarization).
 * Audio is processed in-process; no network call is made (call.http is intentionally unused).
 */
export class LocalSherpaProvider implements TranscriptionProvider {
  readonly id = 'local-sherpa';
  readonly isLocal = true;
  constructor(private o: LocalSherpaOptions) {}

  async available() {
    return localAsrAvailable(resolve(this.o.modelDir), this.o.model);
  }

  async transcribe(input: TranscriptionInput, _call: TranscriptionCallCtx): Promise<TranscriptionResult> {
    const a = await this.available();
    if (!a.ok) throw new PermanentTranscriptionError(`ローカル文字起こしを実行できません: ${a.reason}`);
    const diar = this.o.diarization ?? 'auto';
    const r = await transcribeFile(input.audioPath, {
      modelDir: resolve(this.o.modelDir),
      model: this.o.model,
      numThreads: this.o.numThreads,
      language: input.language,
      diarization: diar !== 'off',
    });
    const notes: string[] = [];
    if (r.diarizationError) notes.push(diar === 'auto' && /missing/.test(r.diarizationError) ? 'diarization_models_missing' : 'diarization_failed');
    return {
      provider: this.id,
      model: `sherpa-onnx/${r.model}`,
      isLocal: true,
      language: r.language,
      diarization: r.diarization,
      segments: r.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, confidence: s.confidence ?? null, speaker: s.speaker ?? null })),
      notes,
    };
  }
}
