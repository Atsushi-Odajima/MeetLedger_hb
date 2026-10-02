// Browser capture capabilities, computed from the real browser (feature detection + UA only for platform hints).
// Facts (docs/research/B_local_asr_audio_capture.md §3):
//   * A PWA can always record ONLY the microphone. Other participants' audio from Zoom/Teams/Meet desktop apps and
//     system audio are NOT available to a web page — the MeetLedger desktop app (or uploading a recording) is needed.
//   * Chrome/Edge desktop can include the audio of a shared *browser tab* via screen sharing (user picks the tab and
//     ticks "share tab audio"). Firefox and Safari cannot. iOS/Android browsers have no getDisplayMedia at all.
//   * iPhone/iPad: microphone only, and recording stops when the app goes to the background or the screen locks.

export const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'] as const;

/** Picks the first MediaRecorder MIME type the browser supports (webm/opus on Chromium & Firefox, mp4/AAC on Safari). */
export function pickMimeType(isTypeSupported: ((t: string) => boolean) | undefined = globalThis.MediaRecorder?.isTypeSupported?.bind(globalThis.MediaRecorder)): string | null {
  if (!isTypeSupported) return null;
  for (const t of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      /* some engines throw for unknown types */
    }
  }
  return null;
}

/** File extension for an uploaded recording. */
export function extensionForMime(mime: string | null | undefined): string {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('audio/webm') || m.startsWith('video/webm')) return 'webm';
  if (m.startsWith('audio/mp4') || m.startsWith('video/mp4') || m.includes('aac')) return 'm4a';
  if (m.startsWith('audio/ogg')) return 'ogg';
  if (m.startsWith('audio/wav') || m.startsWith('audio/x-wav')) return 'wav';
  if (m.startsWith('audio/mpeg')) return 'mp3';
  return 'bin';
}

export type Platform = 'ios' | 'android' | 'windows' | 'mac' | 'linux' | 'chromeos' | 'other';
export type Engine = 'chromium' | 'firefox' | 'safari' | 'other';

export interface CaptureEnv {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
  hasMediaRecorder: boolean;
  isSecureContext: boolean;
  standalone?: boolean;
  hasWakeLock?: boolean;
}

export interface CaptureCapabilities {
  platform: Platform;
  engine: Engine;
  mobile: boolean;
  /** Microphone recording possible in this browser. */
  mic: boolean;
  /** Audio of a shared browser tab can be included (Chromium desktop only, user must choose to share audio). */
  tabAudio: boolean;
  /** System / other-participant audio from desktop meeting apps: never available to the PWA. */
  systemAudio: false;
  /** Recording stops when the page goes to the background (iOS). */
  stopsInBackground: boolean;
  wakeLock: boolean;
  standalone: boolean;
  /** i18n keys of notices to show, in order. */
  notices: string[];
}

export function detectPlatform(env: Pick<CaptureEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): Platform {
  const ua = env.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // iPadOS 13+ reports a Mac UA; touch points reveal it.
  if (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) > 1) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/CrOS/i.test(ua)) return 'chromeos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

export function detectEngine(ua: string): Engine {
  if (/Firefox\/|FxiOS/i.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|CriOS|Edg\//i.test(ua) && !/CriOS/i.test(ua)) return 'chromium';
  if (/Safari\//i.test(ua) || /AppleWebKit/i.test(ua)) return 'safari';
  return 'other';
}

export function computeCapabilities(env: CaptureEnv): CaptureCapabilities {
  const platform = detectPlatform(env);
  // On iOS every browser is WebKit, regardless of branding.
  const engine: Engine = platform === 'ios' ? 'safari' : detectEngine(env.userAgent);
  const mobile = platform === 'ios' || platform === 'android';
  const mic = env.isSecureContext && env.hasGetUserMedia && env.hasMediaRecorder;
  const tabAudio = mic && !mobile && engine === 'chromium' && env.hasGetDisplayMedia;
  const notices: string[] = [];
  if (!env.isSecureContext) notices.push('capture.notice.insecure');
  else if (!mic) notices.push('capture.notice.noMic');
  notices.push('capture.notice.micOnly');
  if (platform === 'ios') notices.push('capture.notice.ios');
  else if (platform === 'android') notices.push('capture.notice.android');
  else if (tabAudio) notices.push('capture.notice.tabAudio');
  else notices.push('capture.notice.noTabAudio');
  notices.push('capture.notice.desktopApp');
  return {
    platform,
    engine,
    mobile,
    mic,
    tabAudio,
    systemAudio: false,
    stopsInBackground: platform === 'ios',
    wakeLock: !!env.hasWakeLock,
    standalone: !!env.standalone,
    notices,
  };
}

/** Reads the capture environment from the running browser. */
export function currentCaptureEnv(): CaptureEnv {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const md = (nav as Navigator).mediaDevices;
  return {
    userAgent: nav.userAgent ?? '',
    platform: (nav as Navigator).platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    hasGetUserMedia: !!md?.getUserMedia,
    hasGetDisplayMedia: !!(md as MediaDevices | undefined)?.getDisplayMedia,
    hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    isSecureContext: typeof window !== 'undefined' ? window.isSecureContext !== false : true,
    standalone:
      typeof window !== 'undefined' &&
      ((window.matchMedia?.('(display-mode: standalone)').matches ?? false) || (nav as Navigator & { standalone?: boolean }).standalone === true),
    hasWakeLock: 'wakeLock' in nav,
  };
}

/** Guesses the transcript import format from a filename and/or content. */
export function detectTranscriptFormat(name: string, content: string): 'srt' | 'vtt' | 'txt' | 'json' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.vtt') || /^﻿?WEBVTT/.test(content)) return 'vtt';
  if (lower.endsWith('.srt') || /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(content)) return 'srt';
  if (lower.endsWith('.json')) return 'json';
  const t = content.trimStart();
  if ((t.startsWith('{') || t.startsWith('[')) && /"segments"|"text"/.test(t)) return 'json';
  return 'txt';
}

/** Counts cues for an import preview (approximate; the server does the real parsing). */
export function countCues(format: 'srt' | 'vtt' | 'txt' | 'json', content: string): number {
  if (format === 'srt' || format === 'vtt') return (content.match(/-->/g) ?? []).length;
  if (format === 'json') {
    try {
      const j = JSON.parse(content);
      return Array.isArray(j) ? j.length : Array.isArray(j?.segments) ? j.segments.length : 0;
    } catch {
      return 0;
    }
  }
  return content.split(/\n+/).filter((l) => l.trim()).length;
}
