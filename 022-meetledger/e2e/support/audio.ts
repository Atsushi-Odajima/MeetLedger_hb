import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

export interface FixtureSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

/** Generates a mono 16 kHz sine-tone WAV. A distinct frequency per meeting gives a distinct PCM hash. */
export function makeToneWav(dir: string, name: string, frequency: number, seconds = 20): string {
  const out = path.join(dir, `${name}.wav`);
  execFileSync(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
  return out;
}

function wavDataChunk(buf: Buffer): Buffer {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/**
 * SHA-256 of the PCM payload the server's fixture provider will see: the upload is normalized with exactly the
 * server's ffmpeg arguments (apps/server/src/modules/audio/media.ts normalizeAudio), then the data chunk is hashed.
 */
export function normalizedPcmSha256(src: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ml-e2e-norm-'));
  try {
    const mono = path.join(dir, 'mono.wav');
    const common = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ar', '16000', '-c:a', 'pcm_s16le', '-bitexact', '-f', 'wav'];
    execFileSync(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file', '-i', src, ...common, '-ac', '1', mono]);
    return createHash('sha256').update(wavDataChunk(readFileSync(mono))).digest('hex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates a WAV and registers its deterministic transcript for the fixture provider
 * (`<fixturesDir>/<sha>.json`, read by the server at transcription time).
 */
export function makeFixtureMeetingAudio(fixturesDir: string, workDir: string, name: string, frequency: number, segments: FixtureSegment[], language = 'ja'): string {
  const lastEnd = Math.max(0, ...segments.map((s) => s.endMs));
  const wav = makeToneWav(workDir, name, frequency, Math.max(10, Math.ceil(lastEnd / 1000) + 2));
  const sha = normalizedPcmSha256(wav);
  writeFileSync(path.join(fixturesDir, `${sha}.json`), JSON.stringify({ language, model: 'fixture-e2e', segments }, null, 2));
  return wav;
}

/** Builds evenly spaced segments from lines like "S1: text" (speaker optional). */
export function lines(...items: string[]): FixtureSegment[] {
  return items.map((l, i) => {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l);
    return { startMs: i * 4000, endMs: i * 4000 + 3500, text: m ? m[2] : l, speaker: m ? m[1] : undefined, confidence: 0.95 };
  });
}
