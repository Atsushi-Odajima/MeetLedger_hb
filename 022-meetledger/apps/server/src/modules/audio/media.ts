import { spawn } from 'node:child_process';
import type { Config } from '../../config';

// ffprobe / ffmpeg wrappers: fixed argument lists (no shell), bounded runtime, stderr never logged (it may contain
// container metadata); only a short last line is kept for job errors.

export interface ProbeResult {
  formatName: string;
  durationMs: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  /** Channels of the first audio stream. */
  channels: number;
  sampleRate: number | null;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; code: number | null; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let err = '';
    p.stdout.on('data', (c) => {
      if (stdout.length < 2_000_000) stdout += String(c);
    });
    p.stderr.on('data', (c) => (err = (err + String(c)).slice(-400)));
    p.on('error', rej);
    p.on('close', (code) => res({ stdout, code, err }));
  });
}

function lastLine(s: string): string {
  return (s.split('\n').filter(Boolean).pop() ?? '').slice(0, 160);
}

export async function ffprobe(cfg: Pick<Config, 'FFPROBE_PATH'>, path: string): Promise<ProbeResult> {
  const r = await run(cfg.FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], 120_000);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${lastLine(r.err)}`);
  let j: any;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error('ffprobe returned invalid output');
  }
  const streams: any[] = j.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const dur = Number(j.format?.duration ?? audio?.duration);
  return {
    formatName: String(j.format?.format_name ?? ''),
    durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null,
    hasAudio: !!audio,
    hasVideo: !!video,
    channels: Number(audio?.channels ?? 0) || 0,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  };
}

/**
 * Normalizes the first audio stream to 16 kHz mono PCM16 WAV (`-bitexact`, metadata stripped). When `stereoOut` is
 * given, also writes a 16 kHz 2-channel WAV keeping the source's first two channels (ch0 = mic, ch1 = system).
 */
export async function normalizeAudio(cfg: Pick<Config, 'FFMPEG_PATH'>, src: string, monoOut: string, stereoOut?: string | null): Promise<void> {
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  const common = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ar', '16000', '-c:a', 'pcm_s16le', '-bitexact', '-f', 'wav'];
  const args = [...base, ...common, '-ac', '1', monoOut];
  if (stereoOut) args.push(...common, '-af', 'pan=stereo|c0=c0|c1=c1', stereoOut);
  const r = await run(cfg.FFMPEG_PATH, args, 60 * 60_000);
  if (r.code !== 0) throw new Error(`audio normalization failed: ${lastLine(r.err)}`);
}
