import { describe, expect, it } from 'vitest';
import { ASR_SAMPLE_RATE, WAV_HEADER_BYTES, encodeWavMono16, floatToPcm16, isAsrWav, parseWavHeader, wavHeader } from '../src/shared/audio/wav';
import { EnvelopeAccumulator, PcmTapCore, StreamingResampler, designLowpass, downmixStereoToMono, mixForAsr } from '../src/shared/audio/dsp';

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** frequency estimate from positive-going zero crossings */
function freqOf(x: Float32Array, rate: number): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) c++;
  return (c * rate) / x.length;
}

function resampleInBlocks(r: StreamingResampler, x: Float32Array, block: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += block) parts.push(r.process(x.subarray(i, Math.min(x.length, i + block))));
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('WAV encoder / parser', () => {
  it('writes a canonical 16 kHz mono PCM16 header', () => {
    const h = wavHeader(32000, 16000, 1, 16);
    const v = new DataView(h.buffer);
    expect(h.byteLength).toBe(WAV_HEADER_BYTES);
    expect(String.fromCharCode(...h.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 32000);
    expect(String.fromCharCode(...h.subarray(8, 16))).toBe('WAVEfmt ');
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(32000);
  });

  it('round-trips encode → parse and clamps samples', () => {
    const wav = encodeWavMono16(Float32Array.from([0, 1, -1, 2, -2, 0.5, NaN]), ASR_SAMPLE_RATE);
    const info = parseWavHeader(wav)!;
    expect(info).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataOffset: 44, dataBytes: 14 });
    expect(isAsrWav(info)).toBe(true);
    const dv = new DataView(wav.buffer, 44);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => dv.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0]);
  });

  it('parses files with extra chunks before data and rejects non-PCM', () => {
    const fmt = wavHeader(4, 48000, 2, 16);
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // "LIST", size 3 + pad
    const file = new Uint8Array(36 + list.length + 8 + 4);
    file.set(fmt.subarray(0, 36), 0);
    file.set(list, 36);
    file.set(fmt.subarray(36, 44), 36 + list.length);
    const info = parseWavHeader(file)!;
    expect(info.dataOffset).toBe(36 + list.length + 8);
    expect(info.channels).toBe(2);
    expect(isAsrWav(info)).toBe(false);
    const float = wavHeader(4, 16000, 1, 32);
    new DataView(float.buffer).setUint16(20, 3, true); // IEEE float
    expect(parseWavHeader(float)).toBeNull();
    expect(parseWavHeader(new TextEncoder().encode('OggS....WAVE'))).toBeNull();
  });

  it('floatToPcm16 maps full scale asymmetrically', () => {
    expect(Array.from(floatToPcm16(Float32Array.from([1, -1, 0])))).toEqual([32767, -32768, 0]);
  });
});

describe('streaming resampler (48 kHz / 44.1 kHz → 16 kHz)', () => {
  it('low-pass has unity DC gain and is symmetric', () => {
    const h = designLowpass(48000, 7200, 63);
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    for (let i = 0; i < h.length; i++) expect(h[i]).toBeCloseTo(h[h.length - 1 - i]!, 7);
  });

  it('keeps a 1 kHz tone (frequency + level) and produces 1/3 of the samples', () => {
    const x = sine(1000, 48000, 1);
    const y = new StreamingResampler(48000, 16000).process(x);
    expect(Math.abs(y.length - 16000)).toBeLessThanOrEqual(1);
    const steady = y.subarray(200);
    expect(freqOf(steady, 16000)).toBeGreaterThan(990);
    expect(freqOf(steady, 16000)).toBeLessThan(1010);
    expect(rms(steady)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('suppresses content above the new Nyquist (no aliasing of a 12 kHz tone)', () => {
    const y = new StreamingResampler(48000, 16000).process(sine(12000, 48000, 1));
    expect(rms(y.subarray(200))).toBeLessThan(0.01); // < -37 dB relative to 0.35 RMS input
  });

  it('block-wise processing (128-frame render quanta) equals one-shot processing', () => {
    const x = sine(440, 48000, 0.5);
    const a = new StreamingResampler(48000, 16000).process(x);
    const b = resampleInBlocks(new StreamingResampler(48000, 16000), x, 128);
    expect(b.length).toBe(a.length);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('handles non-integer ratios (44.1 kHz)', () => {
    const x = sine(1000, 44100, 1);
    const y = resampleInBlocks(new StreamingResampler(44100, 16000), x, 128);
    expect(Math.abs(y.length - 16000)).toBeLessThanOrEqual(2);
    expect(freqOf(y.subarray(200), 16000)).toBeGreaterThan(990);
    expect(freqOf(y.subarray(200), 16000)).toBeLessThan(1010);
    expect(rms(y.subarray(200))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('refuses upsampling', () => {
    expect(() => new StreamingResampler(8000, 16000)).toThrow();
  });
});

describe('channel mixing math', () => {
  it('stereo source down-mix to mono follows WebAudio "speakers" rule 0.5·(L+R)', () => {
    expect(Array.from(downmixStereoToMono(Float32Array.from([1, 0.5, -1]), Float32Array.from([1, -0.5, 0])))).toEqual([1, 0, -0.5]);
  });

  it('ASR mix sums mic and system (single talker keeps full level) and clamps double-talk', () => {
    expect(Array.from(mixForAsr(Float32Array.from([0.5, 0, 0.8, -0.9]), Float32Array.from([0, 0.25, 0.8, -0.9])))).toEqual([0.5, 0.25, 1, -1]);
  });

  it('envelope accumulator produces per-frame [L,R] RMS', () => {
    const env = new EnvelopeAccumulator(4);
    env.push(Float32Array.from([1, 1, 1, 1, 0.5, 0.5]), Float32Array.from([0, 0, 0, 0, 0, 0]));
    expect(Array.from(env.take())).toEqual([1, 0]);
    env.push(Float32Array.from([0.5, 0.5]), Float32Array.from([0.5, 0.5]));
    const f = Array.from(env.take());
    expect(f[0]).toBeCloseTo(0.5, 6);
    expect(f[1]).toBeCloseTo(Math.sqrt(0.125), 6);
  });

  it('PcmTapCore: mic on L / system on R → 16 kHz PCM16 + envelope that keeps the channels apart', () => {
    const core = new PcmTapCore(48000);
    const mic = sine(500, 48000, 1, 0.5);
    const silent = new Float32Array(mic.length);
    for (let i = 0; i < mic.length; i += 128) core.push(mic.subarray(i, i + 128), i < 24000 ? silent.subarray(i, i + 128) : sine(700, 48000, 128 / 48000, 0.3));
    const { pcm, env } = core.drain();
    expect(Math.abs(pcm.length - 16000)).toBeLessThanOrEqual(1);
    expect(env.length).toBe(20); // 10 frames × [L,R]
    // first half: system silent; second half: system active
    expect(env[1]).toBeLessThan(1e-3);
    expect(env[3]).toBeLessThan(1e-3);
    expect(env[19]).toBeGreaterThan(0.1);
    for (let f = 1; f < 10; f++) expect(env[2 * f]).toBeCloseTo(0.5 / Math.SQRT2, 1);
    expect(Math.max(...Array.from(pcm.subarray(100, 7000)).map(Math.abs))).toBeGreaterThan(15000);
  });
});
