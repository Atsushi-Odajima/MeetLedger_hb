import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = PCM integer, 3 = IEEE float */
  format: number;
  dataOffset: number;
  dataLength: number;
}

/**
 * Parses RIFF/WAVE headers (PCM 16/24/32-bit or float32, incl. WAVE_FORMAT_EXTENSIBLE).
 * `fileSize` allows parsing from a header-only prefix of a large file.
 */
export function parseWavHeader(buf: Buffer, fileSize: number = buf.length): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength'> | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(body + 24); // extensible: sub-format GUID
      fmt = { format, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      // Streams written by ffmpeg to a pipe may carry 0xFFFFFFFF; clamp to the file length.
      if (size === 0xffffffff || body + size > fileSize) size = fileSize - body;
      return { ...fmt, dataOffset: body, dataLength: size };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV data chunk not found');
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channelData: Float32Array[];
  /** Mono mix (average of channels). */
  mono: Float32Array;
  durationMs: number;
}

export function decodeWav(buf: Buffer): DecodedWav {
  const h = parseWavHeader(buf);
  const bytes = h.bitsPerSample / 8;
  if (!(h.format === 1 && [16, 24, 32].includes(h.bitsPerSample)) && !(h.format === 3 && h.bitsPerSample === 32)) {
    throw new Error(`unsupported WAV encoding (format ${h.format}, ${h.bitsPerSample} bit)`);
  }
  const frames = Math.floor(h.dataLength / (bytes * h.channels));
  const channelData = Array.from({ length: h.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < h.channels; c++) {
      const p = h.dataOffset + (i * h.channels + c) * bytes;
      let v: number;
      if (h.format === 3) v = buf.readFloatLE(p);
      else if (h.bitsPerSample === 16) v = buf.readInt16LE(p) / 32768;
      else if (h.bitsPerSample === 24) v = buf.readIntLE(p, 3) / 8388608;
      else v = buf.readInt32LE(p) / 2147483648;
      channelData[c][i] = v;
    }
  }
  let mono: Float32Array;
  if (h.channels === 1) mono = channelData[0];
  else {
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < h.channels; c++) s += channelData[c][i];
      mono[i] = s / h.channels;
    }
  }
  return { sampleRate: h.sampleRate, channels: h.channels, channelData, mono, durationMs: Math.round((frames / h.sampleRate) * 1000) };
}

export function readWavFile(path: string): DecodedWav {
  return decodeWav(readFileSync(path));
}

/**
 * SHA-256 of the PCM payload of a WAV file (headers/metadata excluded), so the same audio normalized by different
 * ffmpeg versions (different LIST/INFO tags) hashes identically. Used as transcript input hash and fixture key.
 */
export function wavPcmSha256(path: string): string {
  const buf = readFileSync(path);
  const h = parseWavHeader(buf);
  return createHash('sha256').update(buf.subarray(h.dataOffset, h.dataOffset + h.dataLength)).digest('hex');
}
