import { wavPcmSha256 } from '@meetledger/local-asr';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAudio } from '../src/modules/audio/media';
import type { Client } from './helpers';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** 16 kHz mono PCM16 sine WAV (different frequencies => different content hashes). */
export function makeSineWav(path: string, opts: { seconds?: number; freq?: number; rate?: number } = {}) {
  ff(['-f', 'lavfi', '-i', `sine=frequency=${opts.freq ?? 440}:duration=${opts.seconds ?? 3}:sample_rate=${opts.rate ?? 16000}`, '-ac', '1', '-c:a', 'pcm_s16le', path]);
  return path;
}

/** Silent WAV (anullsrc). */
export function makeSilentWav(path: string, seconds = 2) {
  ff(['-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=16000:cl=mono', '-c:a', 'pcm_s16le', path]);
  return path;
}

/** Encodes any input to another container (e.g. m4a / webm / ogg / flac / mp3). */
export function transcode(src: string, dest: string, codecArgs: string[]) {
  ff(['-i', src, ...codecArgs, dest]);
  return dest;
}

/** SHA-256 of the PCM the pipeline will produce for this file (same ffmpeg normalization as audio.process). */
export async function normalizedPcmSha(path: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ml-norm-'));
  try {
    const out = join(dir, 'mono.wav');
    await normalizeAudio({ FFMPEG_PATH: 'ffmpeg' }, path, out);
    return wavPcmSha256(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function multipartPayload(file: { filename: string; contentType: string; data: Buffer }, field = 'file') {
  const boundary = `----mltest${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function uploadMedia(client: Client, ws: string, meetingId: string, path: string, opts: { filename?: string; contentType?: string } = {}) {
  const mp = multipartPayload({ filename: opts.filename ?? path.split('/').pop()!, contentType: opts.contentType ?? 'audio/wav', data: readFileSync(path) });
  return client.req('POST', `/api/w/${ws}/meetings/${meetingId}/media`, mp.payload, mp.headers);
}
