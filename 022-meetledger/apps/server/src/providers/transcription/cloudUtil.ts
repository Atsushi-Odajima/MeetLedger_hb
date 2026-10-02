import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PermanentTranscriptionError } from './types';

export interface UploadAudio {
  data: Buffer;
  mime: string;
  filename: string;
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30 * 60_000 });
    let err = '';
    p.stderr.on('data', (c) => (err = (err + String(c)).slice(-500)));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed (${code}): ${err.split('\n').filter(Boolean).pop()?.slice(0, 200) ?? ''}`))));
  });
}

/**
 * Returns the audio to send to a cloud provider: the normalized WAV when it fits `maxBytes`, otherwise a compact
 * 16 kHz mono MP3 (32 kbps, ~14 MB/hour). Throws a permanent error when even that is too large.
 */
export async function prepareCloudAudio(wavPath: string, maxBytes: number, ffmpegPath: string, workDir?: string): Promise<UploadAudio> {
  const size = (await stat(wavPath)).size;
  if (size <= maxBytes) return { data: await readFile(wavPath), mime: 'audio/wav', filename: 'audio.wav' };
  const out = join(workDir ?? dirname(wavPath), `cloud-${randomBytes(4).toString('hex')}.mp3`);
  await runFfmpeg(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-map_metadata', '-1', out]);
  const s2 = (await stat(out)).size;
  if (s2 > maxBytes) throw new PermanentTranscriptionError(`音声が長すぎるためクラウド文字起こしの上限（${Math.round(maxBytes / 1e6)}MB）を超えます。Local文字起こしを使用してください`);
  return { data: await readFile(out), mime: 'audio/mpeg', filename: 'audio.mp3' };
}

/** Builds a multipart/form-data body as a single Buffer (so the guarded HTTP layer can record bytes_sent). */
export function multipartBody(fields: [string, string][], file: { field: string } & UploadAudio): { body: Buffer; contentType: string } {
  const boundary = `----meetledger${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Maps a provider HTTP failure to an error. 4xx (except 408/429) are permanent; bodies are never echoed. */
export function providerHttpError(provider: string, status: number): Error {
  const msg = `${provider} transcription failed: HTTP ${status}`;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return new PermanentTranscriptionError(msg);
  return new Error(msg);
}

export function toLangParam(language: 'ja' | 'en' | 'auto'): string | null {
  return language === 'auto' ? null : language;
}
