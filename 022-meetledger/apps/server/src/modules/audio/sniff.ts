// Upload validation: container detection from magic bytes, cross-checked with the file extension and declared MIME.
// Anything that does not agree is rejected with 415 before it reaches storage or ffmpeg.

export type Container = 'wav' | 'mp3' | 'mp4' | 'webm' | 'ogg' | 'flac';

interface ContainerInfo {
  exts: string[];
  mimes: string[];
}

export const CONTAINERS: Record<Container, ContainerInfo> = {
  wav: { exts: ['wav', 'wave'], mimes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'] },
  mp3: { exts: ['mp3'], mimes: ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'] },
  mp4: { exts: ['m4a', 'mp4', 'mov', 'm4v', 'aac'], mimes: ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'video/mp4', 'video/quicktime', 'video/x-m4v'] },
  webm: { exts: ['webm', 'mkv', 'mka'], mimes: ['audio/webm', 'video/webm', 'audio/x-matroska', 'video/x-matroska'] },
  ogg: { exts: ['ogg', 'oga', 'opus', 'ogv'], mimes: ['audio/ogg', 'audio/opus', 'application/ogg', 'video/ogg'] },
  flac: { exts: ['flac'], mimes: ['audio/flac', 'audio/x-flac'] },
};

const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Detects the container from the first bytes (>= 16 bytes recommended). Returns null for unknown content. */
export function sniffContainer(head: Buffer): Container | null {
  if (head.length < 4) return null;
  const ascii = (s: number, e: number) => head.toString('latin1', s, e);
  if (ascii(0, 4) === 'RIFF' && head.length >= 12 && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (head.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(4, 8))) return 'mp4';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  // MPEG audio frame sync (11 bits) with layer III; ADTS AAC (layer bits 00) is rejected here.
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) === 0x02) return 'mp3';
  return null;
}

export function extOf(filename: string | undefined | null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  return m ? m[1].toLowerCase() : '';
}

export type SniffResult = { ok: true; container: Container } | { ok: false; reason: string };

/** Validates magic bytes vs. extension vs. declared MIME type. */
export function validateUpload(head: Buffer, filename: string | undefined, declaredMime: string | undefined): SniffResult {
  const container = sniffContainer(head);
  if (!container) return { ok: false, reason: '対応していないファイル形式です（wav, mp3, m4a/mp4/mov, webm/mkv, ogg/opus, flac）' };
  const info = CONTAINERS[container];
  const ext = extOf(filename);
  if (!ext || !info.exts.includes(ext)) return { ok: false, reason: `拡張子 (.${ext || '?'}) とファイル内容 (${container}) が一致しません` };
  const mime = (declaredMime ?? '').split(';')[0].trim().toLowerCase();
  if (!GENERIC_MIMES.has(mime) && !info.mimes.includes(mime)) return { ok: false, reason: `MIMEタイプ (${mime}) とファイル内容 (${container}) が一致しません` };
  return { ok: true, container };
}

/** Canonical MIME stored for an asset (served back on playback). */
export function canonicalMime(container: Container, ext: string, hasVideo: boolean): string {
  switch (container) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
      return hasVideo ? 'video/ogg' : 'audio/ogg';
    case 'webm':
      return ext === 'mkv' || ext === 'mka' ? (hasVideo ? 'video/x-matroska' : 'audio/x-matroska') : hasVideo ? 'video/webm' : 'audio/webm';
    case 'mp4':
      if (ext === 'mov') return 'video/quicktime';
      return hasVideo ? 'video/mp4' : 'audio/mp4';
  }
}
