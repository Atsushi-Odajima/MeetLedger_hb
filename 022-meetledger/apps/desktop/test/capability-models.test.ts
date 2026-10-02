import { describe, expect, it } from 'vitest';
import { localAsrPlatformSupport, systemAudioCapability, versionAtLeast } from '../src/shared/capability';
import { catalogEntries, normalizeCheck, normalizeModel, normalizeProgress } from '../src/shared/models';

describe('system audio capability per OS', () => {
  it('Windows: supported (WASAPI loopback)', () => {
    expect(systemAudioCapability('win32', '10.0.22631', null).systemAudio).toBe(true);
  });
  it('macOS < 14.2: not possible; ≥ 14.2: unknown until verified on that version', () => {
    expect(systemAudioCapability('darwin', '14.1.2', null).systemAudio).toBe(false);
    expect(systemAudioCapability('darwin', '14.2', null).systemAudio).toBe('unknown');
    expect(systemAudioCapability('darwin', '15.6.1', null).systemAudio).toBe('unknown');
    expect(systemAudioCapability('darwin', '26.0', null).reason).toMatch(/52738/);
    expect(systemAudioCapability('darwin', '15.6.1', '15.6.1').systemAudio).toBe(true);
    expect(systemAudioCapability('darwin', '15.7', '15.6.1').systemAudio).toBe('unknown'); // re-verify after OS update
  });
  it('Linux: not supported', () => {
    expect(systemAudioCapability('linux', '6.8.0', null).systemAudio).toBe(false);
  });
  it('version compare', () => {
    expect(versionAtLeast('14.10', '14.2')).toBe(true);
    expect(versionAtLeast('14.1.9', '14.2')).toBe(false);
    expect(versionAtLeast('26', '14.2')).toBe(true);
  });
  it('sherpa-onnx prebuilt matrix (no win-arm64)', () => {
    expect(localAsrPlatformSupport('win32', 'x64').supported).toBe(true);
    expect(localAsrPlatformSupport('darwin', 'arm64').supported).toBe(true);
    expect(localAsrPlatformSupport('win32', 'arm64').supported).toBe(false);
  });
});

describe('local-asr catalog normalization', () => {
  it('accepts array or record catalogs with varying field names', () => {
    const a = catalogEntries([{ id: 'a' }, 'junk', null]);
    expect(a).toHaveLength(1);
    const r = catalogEntries({ 'sense-voice': { name: 'SenseVoice', sizeMB: 163, licence: 'FunASR Model License v1.1', credit: 'FunASR / Alibaba' } });
    const m = normalizeModel(r[0]!, true)!;
    expect(m).toMatchObject({ id: 'sense-voice', name: 'SenseVoice', sizeBytes: 163_000_000, license: 'FunASR Model License v1.1', attribution: 'FunASR / Alibaba', installed: true });
    const d = normalizeModel({ id: 'pyannote-seg', kind: 'segmentation', files: [{ bytes: 1 }, { bytes: 2 }], license: { name: 'MIT', url: 'https://x' } }, false)!;
    expect(d).toMatchObject({ diarization: true, sizeBytes: 3, license: 'MIT', sourceUrl: 'https://x' });
    expect(normalizeModel({ id: '../evil' }, false)).toBeNull();
    expect(normalizeModel({ name: 'no id' }, false)).toBeNull();
    expect(normalizeModel({ id: 'x' }, false)!.license).toBe('不明');
  });
  it('checkModels result shapes', () => {
    expect(normalizeCheck(true)).toBe(true);
    expect(normalizeCheck({ ok: false })).toBe(false);
    expect(normalizeCheck({ installed: true })).toBe(true);
    expect(normalizeCheck({ missing: [] })).toBe(true);
    expect(normalizeCheck({ missing: ['model.onnx'] })).toBe(false);
    expect(normalizeCheck(undefined)).toBe(false);
  });
  it('progress callback shapes', () => {
    expect(normalizeProgress('m', [50, 200])).toEqual({ id: 'm', receivedBytes: 50, totalBytes: 200, fraction: 0.25 });
    expect(normalizeProgress('m', [0.5]).fraction).toBe(0.5);
    expect(normalizeProgress('m', [{ loaded: 10, total: 40 }]).fraction).toBe(0.25);
    expect(normalizeProgress('m', [{ percent: 30 }]).fraction).toBeCloseTo(0.3);
    expect(normalizeProgress('m', ['x']).fraction).toBeNull();
  });
});
