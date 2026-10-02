// Minimal RIFF/WAVE (PCM) helpers shared by renderer, worklet and main. Pure, environment-neutral.

export const WAV_HEADER_BYTES = 44;
export const ASR_SAMPLE_RATE = 16_000;

/** 44-byte canonical PCM WAV header. `dataBytes` may be 0 for a streaming placeholder (patched at the end). */
export function wavHeader(dataBytes: number, sampleRate: number, channels: number, bitsPerSample = 16): Uint8Array {
  const buf = new ArrayBuffer(WAV_HEADER_BYTES);
  const v = new DataView(buf);
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM fmt chunk size
  v.setUint16(20, 1, true); // format = PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

/** Parses a PCM WAV header (walks chunks, so LIST/fact chunks before "data" are fine). Returns null if not PCM WAV. */
export function parseWavHeader(bytes: Uint8Array): WavInfo | null {
  if (bytes.byteLength < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.byteLength) return null;
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels < 1 || fmt.sampleRate < 1 || (fmt.bits !== 16 && fmt.bits !== 8 && fmt.bits !== 24 && fmt.bits !== 32)) return null;
      const frameBytes = (fmt.bits / 8) * fmt.channels;
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataOffset: body,
        dataBytes: size,
        durationMs: Math.round(((size / frameBytes) * 1000) / fmt.sampleRate),
      };
    }
    off = body + size + (size % 2); // chunks are word aligned
  }
  return null;
}

export function isAsrWav(info: WavInfo | null): boolean {
  return !!info && info.sampleRate === ASR_SAMPLE_RATE && info.channels === 1 && info.bitsPerSample === 16;
}

/** Float [-1,1] → little-endian PCM16 (clamped, rounded). */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]!;
    if (!(s === s)) s = 0; // NaN guard
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Encodes mono float samples as a complete 16-bit PCM WAV file. */
export function encodeWavMono16(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = floatToPcm16(samples);
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  out.set(wavHeader(pcm.byteLength, sampleRate, 1, 16), 0);
  // Int16Array is platform-endian; every supported target (x64/arm64) is little-endian, but be explicit:
  const dv = new DataView(out.buffer, WAV_HEADER_BYTES);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i]!, true);
  return out;
}
