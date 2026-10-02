import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  ValidationError,
  fileToken,
  modelId,
  parseConfigPatch,
  parseConsentInput,
  parsePrepareInput,
  parseRecData,
  parseSaveRecording,
  parseTranscribeOptions,
  sanitizeSegments,
  uuid,
} from '../src/shared/validate';
import { normalizeServerUrl } from '../src/shared/urlPolicy';

const WS = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

describe('IPC input validation', () => {
  it('accepts UUIDs (normalized to lower case) and rejects anything else', () => {
    expect(uuid(WS.toUpperCase())).toBe(WS);
    for (const bad of ['', 'x', `${WS}/../`, '../../etc/passwd', 42, null, {}, `${WS} `]) expect(() => uuid(bad)).toThrow(ValidationError);
  });

  it('file tokens are 64 lowercase hex chars only', () => {
    expect(fileToken('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '../a', 'a'.repeat(65), 1]) expect(() => fileToken(bad)).toThrow(ValidationError);
  });

  it('model ids cannot traverse paths', () => {
    expect(modelId('sense-voice-ja_int8.2024')).toBe('sense-voice-ja_int8.2024');
    for (const bad of ['../x', '/abs', 'a/b', '.hidden', '', 'x'.repeat(200), 'a\\b']) expect(() => modelId(bad)).toThrow(ValidationError);
  });

  it('saveRecording: mime allow-list, size cap, unknown keys rejected', () => {
    const ok = parseSaveRecording({ mimeType: 'audio/webm;codecs=opus', data: new ArrayBuffer(8) });
    expect(ok.mimeType).toBe('audio/webm');
    expect(ok.data.byteLength).toBe(8);
    expect(parseSaveRecording({ mimeType: 'audio/wav', data: new Uint8Array(4) }).data.byteLength).toBe(4);
    expect(() => parseSaveRecording({ mimeType: 'text/html', data: new ArrayBuffer(8) })).toThrow(/mimeType/);
    expect(() => parseSaveRecording({ mimeType: 'audio/wav', data: 'AAAA' })).toThrow(/ArrayBuffer/);
    expect(() => parseSaveRecording({ mimeType: 'audio/wav', data: new ArrayBuffer(0) })).toThrow(/empty/);
    expect(() => parseSaveRecording({ mimeType: 'audio/wav', data: new ArrayBuffer(8), path: '/etc/passwd' })).toThrow(/unknown field/);
    expect(() => parseSaveRecording({ mimeType: 'audio/wav', data: { byteLength: LIMITS.saveRecordingBytes + 1 } })).toThrow();
    expect(() => parseSaveRecording(null)).toThrow();
    expect(() => parseSaveRecording([1])).toThrow();
  });

  it('transcribe options', () => {
    expect(parseTranscribeOptions(undefined)).toEqual({});
    expect(parseTranscribeOptions({ language: 'ja', diarization: true, model: 'm1' })).toEqual({ language: 'ja', diarization: true, model: 'm1' });
    expect(() => parseTranscribeOptions({ language: 'fr' })).toThrow();
    expect(() => parseTranscribeOptions({ modelDir: '/tmp' })).toThrow(/unknown field/);
    expect(() => parseTranscribeOptions({ diarization: 'yes' })).toThrow();
  });

  it('consent: only notified/confirmed with a known method', () => {
    expect(parseConsentInput({ workspaceId: WS, meetingId: M, state: 'notified', method: 'verbal' })).toMatchObject({ state: 'notified', method: 'verbal' });
    expect(() => parseConsentInput({ workspaceId: WS, meetingId: M, state: 'declined', method: 'verbal' })).toThrow();
    expect(() => parseConsentInput({ workspaceId: WS, meetingId: M, state: 'notified', method: 'telepathy' })).toThrow();
  });

  it('prepare: server mode always uploads audio', () => {
    expect(parsePrepareInput({ workspaceId: WS, meetingId: M, mode: 'server', uploadAudio: false, systemAudio: true }).uploadAudio).toBe(true);
    expect(parsePrepareInput({ workspaceId: WS, meetingId: M, mode: 'device', uploadAudio: false, systemAudio: false }).uploadAudio).toBe(false);
    expect(() => parsePrepareInput({ workspaceId: WS, meetingId: M, mode: 'cloud', uploadAudio: false, systemAudio: false })).toThrow();
  });

  it('recording chunks: pcm must be 16-bit, env must be [L,R] float pairs in range', () => {
    const env = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const r = parseRecData({ pcm: new ArrayBuffer(4), env: env.buffer });
    expect(r.pcm!.byteLength).toBe(4);
    expect(Array.from(r.env!)).toEqual(Array.from(env));
    expect(() => parseRecData({ pcm: new ArrayBuffer(3) })).toThrow(/16-bit/);
    expect(() => parseRecData({ env: new Float32Array([0.1]).buffer })).toThrow(/pairs/);
    expect(() => parseRecData({ env: new Float32Array([NaN, 0]).buffer })).toThrow(/range/);
    expect(() => parseRecData({})).toThrow(/empty/);
    expect(() => parseRecData({ webm: new ArrayBuffer(LIMITS.chunkBytes + 1) })).toThrow(/too large/);
  });

  it('segments are sanitized before anything is posted to the server', () => {
    const segs = sanitizeSegments([{ startMs: 0.4, endMs: 1000.6, text: ' こんにちは ', confidence: 0.8, speaker: 3 }]);
    expect(segs).toEqual([{ startMs: 0, endMs: 1001, text: 'こんにちは', confidence: 0.8, speaker: '3' }]);
    expect(() => sanitizeSegments([{ startMs: 10, endMs: 5, text: 'x' }])).toThrow(/endMs < startMs/);
    expect(() => sanitizeSegments([{ startMs: 0, endMs: 5, text: 'x', confidence: 2 }])).toThrow(/confidence/);
    expect(() => sanitizeSegments([{ startMs: 0, endMs: 5, text: 'x', html: '<b>' }])).toThrow(/unknown field/);
    expect(() => sanitizeSegments([{ startMs: -1, endMs: 5, text: 'x' }])).toThrow();
    expect(() => sanitizeSegments([{ startMs: 0, endMs: 5, text: 'a\u0000b' }])).toThrow(/control/);
    expect(() => sanitizeSegments('nope')).toThrow();
  });

  it('config patch normalizes the server URL and bounds numbers', () => {
    expect(parseConfigPatch({ serverUrl: 'meetledger.example.jp/path?q=1' }, normalizeServerUrl)).toEqual({ serverUrl: 'https://meetledger.example.jp' });
    expect(parseConfigPatch({ numThreads: 4, language: 'auto' }, normalizeServerUrl)).toEqual({ numThreads: 4, language: 'auto' });
    expect(() => parseConfigPatch({ numThreads: 0 }, normalizeServerUrl)).toThrow();
    expect(() => parseConfigPatch({ verifiedSystemAudioOsVersion: '15.0' }, normalizeServerUrl)).toThrow(/unknown field/);
    expect(() => parseConfigPatch({ serverUrl: 'http://evil.example' }, normalizeServerUrl)).toThrow();
  });
});
