// Platform capability rules (pure; unit tested).
// Sources (checked 2026-10-02, see docs/research/B_local_asr_audio_capture.md §4):
//  - Electron session.md: audio 'loopback' "currently only supported on Windows".
//  - Electron desktop-capturer.md (44-x-y): macOS 14.2+ uses Core Audio taps by default and needs
//    NSAudioCaptureUsageDescription; missing permission yields a silent 'ended' track without an error.
//  - Electron issue #52738 (open): loopback track ends immediately on macOS 26 with useSystemPicker:false.
//  → The docs contradict each other, so macOS ≥ 14.2 is reported as 'unknown' until a capture on this
//    machine actually produced audio (then it is remembered as verified for that OS version).

export interface SystemAudioCapability {
  systemAudio: boolean | 'unknown';
  reason: string;
}

export function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = parseVersion(v);
  const b = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

export function systemAudioCapability(platform: string, osVersion: string, verifiedOsVersion: string | null): SystemAudioCapability {
  if (platform === 'win32') {
    return { systemAudio: true, reason: 'Windows: WASAPI ループバック（Electron 公式サポート）でシステム音声を取得します。' };
  }
  if (platform === 'darwin') {
    if (!versionAtLeast(osVersion, '14.2')) {
      return {
        systemAudio: false,
        reason: `macOS ${osVersion}: システム音声の取得には macOS 14.2 以降（Core Audio Tap）が必要です。マイクのみで録音できます。`,
      };
    }
    if (verifiedOsVersion && verifiedOsVersion === osVersion) {
      return { systemAudio: true, reason: `macOS ${osVersion}: この Mac でシステム音声の取得を確認済みです。` };
    }
    return {
      systemAudio: 'unknown',
      reason:
        `macOS ${osVersion}: Core Audio Tap 経由で取得できる見込みですが、Electron の公式ドキュメントが矛盾しており（Issue #52738 も未解決）未検証です。` +
        '初回録音時に「システムオーディオ収録」の許可が求められます。取得できなかった場合はマイクのみで録音を続けます。',
    };
  }
  return {
    systemAudio: false,
    reason: 'Linux: Electron の loopback 音声は Windows/macOS のみ対応のため、マイクのみで録音します（開発用ビルド）。',
  };
}

/** sherpa-onnx-node 1.13.8 prebuilt platform packages (npm). win-arm64 does not exist. */
export const SHERPA_PREBUILT = new Set(['win32-x64', 'win32-ia32', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);

export function localAsrPlatformSupport(platform: string, arch: string): { supported: boolean; reason: string } {
  const key = `${platform}-${arch}`;
  if (SHERPA_PREBUILT.has(key)) return { supported: true, reason: '' };
  return { supported: false, reason: `この環境（${key}）向けの sherpa-onnx-node プリビルドが存在しないため、端末内文字起こしは利用できません。` };
}
