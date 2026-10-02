// Fallback converter (used only when the AudioWorklet tap is unavailable): decodes the recorded stereo
// opus/webm with WebAudio and resamples it with an OfflineAudioContext to 16 kHz, then produces the same
// outputs as the live tap — mono PCM16 for ASR and the per-100 ms [L,R] envelope. No ffmpeg binary is bundled
// (avoids GPL ffmpeg builds and ~70 MB per platform). Memory grows with duration, hence the cap.

import { EnvelopeAccumulator, mixForAsr } from '../../shared/audio/dsp';
import { ASR_SAMPLE_RATE, encodeWavMono16, floatToPcm16 } from '../../shared/audio/wav';

export const MAX_FALLBACK_SECONDS = 90 * 60;

export interface ConvertedAudio {
  pcm: Int16Array;
  env: Float32Array;
  durationMs: number;
  channels: number;
}

export async function convertToAsrPcm(blob: Blob): Promise<ConvertedAudio> {
  const bytes = await blob.arrayBuffer();
  const decoder = new OfflineAudioContext(2, 1, 48_000);
  const decoded = await decoder.decodeAudioData(bytes);
  if (decoded.duration > MAX_FALLBACK_SECONDS) throw new Error(`変換できる長さは ${MAX_FALLBACK_SECONDS / 60} 分までです`);
  const frames = Math.max(1, Math.ceil(decoded.duration * ASR_SAMPLE_RATE));
  const off = new OfflineAudioContext(2, frames, ASR_SAMPLE_RATE);
  off.destination.channelCount = 2;
  off.destination.channelCountMode = 'explicit';
  off.destination.channelInterpretation = 'discrete'; // keep mic (L) / system (R) apart; the context resamples
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.channelInterpretation = 'discrete';
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const L = rendered.getChannelData(0);
  const R = decoded.numberOfChannels > 1 ? rendered.getChannelData(1) : new Float32Array(L.length);
  const env = new EnvelopeAccumulator();
  env.push(L, R);
  return { pcm: floatToPcm16(mixForAsr(L, R)), env: env.take(), durationMs: Math.round(decoded.duration * 1000), channels: decoded.numberOfChannels };
}

/** Same conversion, packaged as a complete 16 kHz mono WAV file (for window.meetledgerDesktop.transcribeLocal). */
export async function convertToAsrWav(blob: Blob): Promise<Uint8Array> {
  const c = await convertToAsrPcm(blob);
  const f = new Float32Array(c.pcm.length);
  for (let i = 0; i < f.length; i++) f[i] = c.pcm[i]! / 0x8000;
  return encodeWavMono16(f, ASR_SAMPLE_RATE);
}
