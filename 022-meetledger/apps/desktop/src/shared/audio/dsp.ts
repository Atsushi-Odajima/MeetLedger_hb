// Streaming DSP used by the recorder's AudioWorklet tap (and unit tests).
// Input: the 2-channel output of the WebAudio ChannelMerger — channel 0 (L) = microphone ("あなた"),
// channel 1 (R) = system audio (other participants) — at the AudioContext rate (usually 48 kHz).
// Output: 16 kHz mono PCM16 for local ASR + a per-100 ms RMS envelope per channel (for speaker attribution).
// Pure TypeScript, no DOM / Node APIs.

import { ASR_SAMPLE_RATE } from './wav';

/** Windowed-sinc (Blackman) low-pass FIR. cutoffHz is relative to sampleRate. Taps normalized to unity DC gain. */
export function designLowpass(sampleRate: number, cutoffHz: number, taps: number): Float32Array {
  if (taps % 2 === 0) taps += 1;
  const h = new Float32Array(taps);
  const fc = cutoffHz / sampleRate; // cycles/sample
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    h[n] = sinc * w;
    sum += h[n]!;
  }
  for (let n = 0; n < taps; n++) h[n] = h[n]! / sum;
  return h;
}

/**
 * Streaming sample-rate converter for downsampling: anti-alias FIR, then fractional-position linear interpolation.
 * Works for any inRate ≥ outRate (48000→16000 hits integer positions, 44100→16000 interpolates).
 * State is carried across calls so block boundaries (128-frame render quanta) are seamless.
 */
export class StreamingResampler {
  private readonly h: Float32Array;
  private readonly step: number;
  private buf: Float32Array;
  private len: number;
  private pos: number;

  constructor(
    readonly inRate: number,
    readonly outRate: number,
    taps = 63,
  ) {
    if (!(inRate > 0 && outRate > 0)) throw new Error('invalid sample rate');
    if (outRate > inRate) throw new Error('StreamingResampler only downsamples');
    this.step = inRate / outRate;
    this.h = inRate === outRate ? Float32Array.of(1) : designLowpass(inRate, 0.45 * outRate, taps);
    const hist = this.h.length - 1;
    this.buf = new Float32Array(Math.max(4096, hist * 4));
    this.len = hist; // history starts as silence
    this.pos = hist;
  }

  private fir(i: number): number {
    const h = this.h;
    const b = this.buf;
    let acc = 0;
    const base = i - (h.length - 1);
    for (let k = 0; k < h.length; k++) acc += h[k]! * b[base + k]!;
    return acc;
  }

  /** Feeds input samples, returns the output samples that became available. */
  process(input: Float32Array): Float32Array {
    if (this.len + input.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + input.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(input, this.len);
    this.len += input.length;

    const maxOut = Math.ceil((this.len - this.pos) / this.step) + 1;
    const out = new Float32Array(Math.max(0, maxOut));
    let n = 0;
    while (true) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      if (frac < 1e-9) {
        if (i >= this.len) break;
        out[n++] = this.fir(i);
      } else {
        if (i + 1 >= this.len) break;
        const a = this.fir(i);
        const b = this.fir(i + 1);
        out[n++] = a + (b - a) * frac;
      }
      this.pos += this.step;
    }
    // drop consumed input but keep FIR history
    const keepFrom = Math.max(0, Math.floor(this.pos) - (this.h.length - 1));
    if (keepFrom > 0) {
      this.buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      this.pos -= keepFrom;
    }
    return out.subarray(0, n);
  }
}

/** Accumulates per-channel RMS over fixed frames (default 100 ms at 16 kHz). */
export class EnvelopeAccumulator {
  private sumL = 0;
  private sumR = 0;
  private count = 0;
  private pending: number[] = [];

  constructor(readonly frameSamples = ASR_SAMPLE_RATE / 10) {}

  push(l: Float32Array, r: Float32Array): void {
    const n = Math.min(l.length, r.length);
    for (let i = 0; i < n; i++) {
      this.sumL += l[i]! * l[i]!;
      this.sumR += r[i]! * r[i]!;
      if (++this.count === this.frameSamples) {
        this.pending.push(Math.sqrt(this.sumL / this.count), Math.sqrt(this.sumR / this.count));
        this.sumL = this.sumR = 0;
        this.count = 0;
      }
    }
  }

  /** Completed frames as interleaved [L0,R0,L1,R1,...]. */
  take(): Float32Array {
    const out = Float32Array.from(this.pending);
    this.pending = [];
    return out;
  }
}

/** WebAudio "speakers" down-mix of a stereo source to mono (what a 1-channel GainNode does): 0.5·(L+R). */
export function downmixStereoToMono(l: Float32Array, r: Float32Array): Float32Array {
  const n = Math.min(l.length, r.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * (l[i]! + r[i]!);
  return out;
}

/**
 * Mix of the two recorder channels for single-pass ASR. Sum (not average) so a single active talker keeps full
 * level; hard-clamped to [-1, 1] (only reachable during loud double-talk).
 */
export function mixForAsr(mic: Float32Array, system: Float32Array): Float32Array {
  const n = Math.min(mic.length, system.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = mic[i]! + system[i]!;
    out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
  }
  return out;
}

/**
 * The full tap used inside the AudioWorklet: stereo (mic L, system R) blocks at `inRate` →
 * 16 kHz mono PCM16 + envelope frames. Kept here (not in the worklet file) so it is unit-testable.
 */
export class PcmTapCore {
  private readonly rl: StreamingResampler;
  private readonly rr: StreamingResampler;
  private readonly env = new EnvelopeAccumulator();
  private pcmParts: Int16Array[] = [];
  private pcmLen = 0;

  constructor(inRate: number) {
    this.rl = new StreamingResampler(inRate, ASR_SAMPLE_RATE);
    this.rr = new StreamingResampler(inRate, ASR_SAMPLE_RATE);
  }

  push(mic: Float32Array, system: Float32Array | null): void {
    const l = this.rl.process(mic);
    const r = this.rr.process(system ?? new Float32Array(mic.length));
    const n = Math.min(l.length, r.length);
    const L = l.subarray(0, n);
    const R = r.subarray(0, n);
    this.env.push(L, R);
    const mono = mixForAsr(L, R);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = mono[i]!;
      pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    this.pcmParts.push(pcm);
    this.pcmLen += n;
  }

  get bufferedSamples(): number {
    return this.pcmLen;
  }

  /** Drains buffered PCM16 (little-endian on all supported CPUs) and completed envelope frames. */
  drain(): { pcm: Int16Array; env: Float32Array } {
    const pcm = new Int16Array(this.pcmLen);
    let off = 0;
    for (const p of this.pcmParts) {
      pcm.set(p, off);
      off += p.length;
    }
    this.pcmParts = [];
    this.pcmLen = 0;
    return { pcm, env: this.env.take() };
  }
}
