import { describe, expect, it } from 'vitest';
import { computeCapabilities, countCues, detectTranscriptFormat, extensionForMime, pickMimeType, type CaptureEnv } from './media';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

function env(userAgent: string, over: Partial<CaptureEnv> = {}): CaptureEnv {
  return { userAgent, maxTouchPoints: 0, hasGetUserMedia: true, hasGetDisplayMedia: true, hasMediaRecorder: true, isSecureContext: true, ...over };
}

describe('pickMimeType', () => {
  it('prefers webm/opus where supported (Chromium, Firefox)', () => {
    const chrome = (t: string) => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].includes(t);
    expect(pickMimeType(chrome)).toBe('audio/webm;codecs=opus');
  });
  it('falls back to audio/mp4 on Safari', () => {
    const safari = (t: string) => t === 'audio/mp4';
    expect(pickMimeType(safari)).toBe('audio/mp4');
  });
  it('accepts mp4 with an explicit AAC codec', () => {
    expect(pickMimeType((t) => t === 'audio/mp4;codecs=mp4a.40.2' || t === 'audio/mp4')).toBe('audio/mp4;codecs=mp4a.40.2');
  });
  it('returns null when nothing (or no MediaRecorder) is available, and survives throwing engines', () => {
    expect(pickMimeType(() => false)).toBeNull();
    expect(pickMimeType(undefined)).toBeNull();
    expect(
      pickMimeType((t) => {
        if (t.includes('webm')) throw new Error('unsupported');
        return t === 'audio/mp4';
      }),
    ).toBe('audio/mp4');
  });
  it('maps MIME types to upload file extensions', () => {
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
    expect(extensionForMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(extensionForMime('')).toBe('bin');
  });
});

describe('computeCapabilities — never claims system audio', () => {
  it('Windows Chrome/Edge: mic + optional tab audio via screen share', () => {
    for (const ua of [UA.chromeWin, UA.edgeWin]) {
      const c = computeCapabilities(env(ua));
      expect(c).toMatchObject({ platform: 'windows', engine: 'chromium', mic: true, tabAudio: true, systemAudio: false, stopsInBackground: false });
      expect(c.notices).toContain('capture.notice.micOnly');
      expect(c.notices).toContain('capture.notice.tabAudio');
      expect(c.notices).toContain('capture.notice.desktopApp');
    }
  });
  it('macOS Chrome: tab audio hint only (still no system audio)', () => {
    expect(computeCapabilities(env(UA.chromeMac))).toMatchObject({ platform: 'mac', tabAudio: true, systemAudio: false });
  });
  it('Safari and Firefox desktop: microphone only', () => {
    for (const ua of [UA.safariMac, UA.firefox]) {
      const c = computeCapabilities(env(ua));
      expect(c.tabAudio).toBe(false);
      expect(c.notices).toContain('capture.notice.noTabAudio');
    }
  });
  it('iPhone (any browser is WebKit): mic only and recording stops in the background', () => {
    for (const ua of [UA.iphone, UA.iphoneChrome]) {
      const c = computeCapabilities(env(ua, { hasGetDisplayMedia: false }));
      expect(c).toMatchObject({ platform: 'ios', engine: 'safari', mobile: true, mic: true, tabAudio: false, stopsInBackground: true, systemAudio: false });
      expect(c.notices).toContain('capture.notice.ios');
    }
  });
  it('iPadOS with a desktop UA is detected through touch points', () => {
    const c = computeCapabilities(env(UA.safariMac, { maxTouchPoints: 5 }));
    expect(c.platform).toBe('ios');
    expect(c.stopsInBackground).toBe(true);
  });
  it('Android Chrome: mic only', () => {
    const c = computeCapabilities(env(UA.android, { hasGetDisplayMedia: false }));
    expect(c).toMatchObject({ platform: 'android', mobile: true, tabAudio: false });
    expect(c.notices).toContain('capture.notice.android');
  });
  it('insecure contexts and missing MediaRecorder disable recording', () => {
    expect(computeCapabilities(env(UA.chromeWin, { isSecureContext: false }))).toMatchObject({ mic: false, tabAudio: false });
    const c = computeCapabilities(env(UA.chromeWin, { hasMediaRecorder: false }));
    expect(c.mic).toBe(false);
    expect(c.notices[0]).toBe('capture.notice.noMic');
  });
});

describe('transcript import helpers', () => {
  it('detects SRT/VTT/JSON/TXT', () => {
    expect(detectTranscriptFormat('a.vtt', '')).toBe('vtt');
    expect(detectTranscriptFormat('x', 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi')).toBe('vtt');
    expect(detectTranscriptFormat('x', '1\n00:00:00,000 --> 00:00:01,000\nhi')).toBe('srt');
    expect(detectTranscriptFormat('x.json', '{}')).toBe('json');
    expect(detectTranscriptFormat('notes.txt', '田中: こんにちは')).toBe('txt');
  });
  it('counts cues for the preview', () => {
    expect(countCues('srt', '1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:01,000 --> 00:00:02,000\nb')).toBe(2);
    expect(countCues('txt', 'a\n\nb\nc')).toBe(3);
    expect(countCues('json', '{"segments":[{},{}]}')).toBe(2);
  });
});
