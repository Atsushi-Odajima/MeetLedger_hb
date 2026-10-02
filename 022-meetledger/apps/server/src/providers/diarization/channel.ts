import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { parseWavHeader, type WavInfo } from '@meetledger/local-asr';

// Channel-based speaker separation for dual-channel captures (desktop companion / browser mixed recording):
//   ch0 = local microphone ("あなた（マイク）" suggestion), ch1 = system / remote participants.
// It is a heuristic (energy comparison per segment). It never assigns a person: only a suggestion for humans.

export const MIC_SUGGESTION = 'あなた（マイク）';
export const REMOTE_SUGGESTION = '相手側（システム音声）';

export type ChannelSide = 'mic' | 'remote' | 'silent';

function readHeader(path: string): WavInfo {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return parseWavHeader(buf.subarray(0, n), fstatSync(fd).size);
  } finally {
    closeSync(fd);
  }
}

/** RMS of both channels for [startMs, endMs) read directly from the stereo PCM16 file (memory-light). */
export function channelRms(path: string, info: WavInfo, startMs: number, endMs: number): [number, number] {
  if (info.channels < 2 || info.bitsPerSample !== 16) return [0, 0];
  const frameBytes = info.channels * 2;
  const totalFrames = Math.floor(info.dataLength / frameBytes);
  const f0 = Math.max(0, Math.min(totalFrames, Math.floor((startMs / 1000) * info.sampleRate)));
  const f1 = Math.max(f0, Math.min(totalFrames, Math.ceil((endMs / 1000) * info.sampleRate)));
  if (f1 <= f0) return [0, 0];
  const fd = openSync(path, 'r');
  try {
    let s0 = 0;
    let s1 = 0;
    const chunkFrames = 16000;
    const buf = Buffer.alloc(chunkFrames * frameBytes);
    for (let f = f0; f < f1; f += chunkFrames) {
      const n = Math.min(chunkFrames, f1 - f);
      const got = readSync(fd, buf, 0, n * frameBytes, info.dataOffset + f * frameBytes);
      for (let i = 0; i + frameBytes <= got; i += frameBytes) {
        const a = buf.readInt16LE(i) / 32768;
        const b = buf.readInt16LE(i + 2) / 32768;
        s0 += a * a;
        s1 += b * b;
      }
    }
    const frames = f1 - f0;
    return [Math.sqrt(s0 / frames), Math.sqrt(s1 / frames)];
  } finally {
    closeSync(fd);
  }
}

const SILENCE_RMS = 10 ** (-50 / 20); // -50 dBFS

/** Classifies each segment by which channel carries more energy. */
export function classifyByChannel(stereoPath: string, segments: { startMs: number; endMs: number }[]): ChannelSide[] {
  const info = readHeader(stereoPath);
  if (info.channels < 2) return segments.map(() => 'silent');
  return segments.map((s) => {
    const [m, r] = channelRms(stereoPath, info, s.startMs, s.endMs);
    if (m < SILENCE_RMS && r < SILENCE_RMS) return 'silent';
    return m >= r ? 'mic' : 'remote';
  });
}

/**
 * Applies channel separation when the provider gave no diarization: mic segments -> "ch0", remote -> "ch1"
 * (silent ones inherit the previous side). Returns provider-style speaker labels.
 */
export function channelSpeakers(sides: ChannelSide[]): string[] {
  let prev: ChannelSide = 'mic';
  return sides.map((s) => {
    const side = s === 'silent' ? prev : s;
    prev = side;
    return side === 'mic' ? 'ch0' : 'ch1';
  });
}

/**
 * With provider diarization AND a stereo source: the speaker cluster whose segments are mostly on the mic channel
 * (> 70% of its speech time) gets the "あなた（マイク）" suggestion. Returns normalized label -> suggestion.
 */
export function micSuggestionForClusters(labels: string[], segments: { startMs: number; endMs: number }[], sides: ChannelSide[]): Map<string, string> {
  const stats = new Map<string, { mic: number; total: number }>();
  labels.forEach((l, i) => {
    const d = Math.max(0, segments[i].endMs - segments[i].startMs);
    const st = stats.get(l) ?? { mic: 0, total: 0 };
    st.total += d;
    if (sides[i] === 'mic') st.mic += d;
    stats.set(l, st);
  });
  let best: string | null = null;
  let bestShare = 0.7;
  for (const [l, st] of stats) {
    const share = st.total ? st.mic / st.total : 0;
    if (share > bestShare) [best, bestShare] = [l, share];
  }
  return best ? new Map([[best, MIC_SUGGESTION]]) : new Map();
}
