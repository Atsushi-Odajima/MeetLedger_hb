// Channel-based speaker attribution for on-device transcripts (pure; unit tested).
// The recorder keeps mic (L) and system audio (R) separate only long enough to compute a per-100 ms RMS envelope;
// ASR runs once on the mono mix. Each ASR segment is then attributed by comparing the (level-normalized) energy of
// the two channels during that segment:
//   mic clearly louder    → "あなた" (the person at this computer)
//   system clearly louder → the other side ("相手" or "相手1/2/..." when the ASR diarization separated them)
//   ambiguous             → diarization label or "不明"
// When no system audio was captured, nothing can be inferred from channels and diarization labels are kept.

export const SPEAKER_SELF = 'あなた';
export const SPEAKER_REMOTE = '相手';
export const SPEAKER_UNKNOWN = '不明';

export interface Envelope {
  /** Interleaved [L0,R0,L1,R1,...] RMS per frame. */
  frames: Float32Array;
  frameMs: number;
}

export interface AttributableSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  speaker?: string;
}

export interface AttributionOptions {
  systemAudioCaptured: boolean;
  /** dB margin required to decide (default 6 dB). */
  marginDb?: number;
  /** Channel considered silent overall below this active level (RMS). */
  silenceRms?: number;
}

/** Robust "active level" of one channel: 90th percentile of non-silent frames. */
export function activeLevel(frames: Float32Array, channel: 0 | 1, floor = 1e-4): number {
  const vals: number[] = [];
  for (let i = channel; i < frames.length; i += 2) if (frames[i]! > floor) vals.push(frames[i]!);
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))]!;
}

/** Mean power of each channel over [startMs, endMs). */
export function segmentPower(env: Envelope, startMs: number, endMs: number): { l: number; r: number; frames: number } {
  const total = env.frames.length / 2;
  const a = Math.max(0, Math.floor(startMs / env.frameMs));
  const b = Math.min(total, Math.max(a + 1, Math.ceil(endMs / env.frameMs)));
  let l = 0;
  let r = 0;
  let n = 0;
  for (let f = a; f < b; f++) {
    l += env.frames[2 * f]! ** 2;
    r += env.frames[2 * f + 1]! ** 2;
    n++;
  }
  return n === 0 ? { l: 0, r: 0, frames: 0 } : { l: l / n, r: r / n, frames: n };
}

function diarizedLabel(raw: string | undefined, map: Map<string, string>, prefix: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  let label = map.get(raw);
  if (!label) {
    label = `${prefix}${map.size + 1}`;
    map.set(raw, label);
  }
  return label;
}

export function attributeSpeakers<T extends AttributableSegment>(segments: T[], env: Envelope | null, opts: AttributionOptions): T[] {
  const margin = opts.marginDb ?? 6;
  const silence = opts.silenceRms ?? 0.003;
  const remoteMap = new Map<string, string>();
  const anyMap = new Map<string, string>();

  const levelL = env ? activeLevel(env.frames, 0) : 0;
  const levelR = env ? activeLevel(env.frames, 1) : 0;
  const channelsUsable = !!env && opts.systemAudioCaptured && levelL > silence && levelR > silence;

  return segments.map((s) => {
    if (!channelsUsable || !env) {
      // No channel information: keep the ASR's own diarization (renamed to neutral labels) or nothing.
      const label = diarizedLabel(s.speaker, anyMap, '話者');
      const { speaker: _drop, ...rest } = s;
      return (label ? { ...rest, speaker: label } : rest) as T;
    }
    const p = segmentPower(env, s.startMs, s.endMs);
    // normalize each channel by its own active level so mic gain vs. digital loopback level does not bias the decision
    const ln = p.l / (levelL * levelL);
    const rn = p.r / (levelR * levelR);
    const db = 10 * Math.log10((ln + 1e-9) / (rn + 1e-9));
    let speaker: string;
    if (db >= margin) speaker = SPEAKER_SELF;
    else if (db <= -margin) speaker = diarizedLabel(s.speaker, remoteMap, SPEAKER_REMOTE) ?? SPEAKER_REMOTE;
    else speaker = diarizedLabel(s.speaker, anyMap, '話者') ?? SPEAKER_UNKNOWN;
    return { ...s, speaker };
  });
}
