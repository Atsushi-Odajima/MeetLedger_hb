// Desktop configuration stored in <userData>/config.json. Nothing secret lives here (the login session is the
// Chromium cookie store, encrypted at rest via the cookie-encryption fuse in packaged builds).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DesktopConfigPublic } from '../shared/ipc';
import { parseConfigPatch } from '../shared/validate';
import { normalizeServerUrl } from '../shared/urlPolicy';

export interface DesktopConfig extends DesktopConfigPublic {
  schema: 1;
  /** macOS version on which a system-audio capture actually produced audio (capability becomes true). */
  verifiedSystemAudioOsVersion: string | null;
}

export function defaultThreads(): number {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, n - 1));
}

export function defaultConfig(): DesktopConfig {
  return {
    schema: 1,
    serverUrl: null,
    processingMode: 'device',
    uploadAudioDefault: false,
    language: 'ja',
    diarization: true,
    numThreads: defaultThreads(),
    model: null,
    macUseSystemPicker: false,
    macLegacyLoopback: false,
    verifiedSystemAudioOsVersion: null,
  };
}

/** Reads config synchronously (needed before app 'ready' to apply command-line switches). Invalid fields fall back to defaults. */
export function loadConfig(file: string): DesktopConfig {
  const cfg = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return cfg;
  }
  if (typeof raw !== 'object' || raw === null) return cfg;
  const r = raw as Record<string, unknown>;
  // validate field by field so one bad value does not discard the whole file
  for (const key of Object.keys(cfg) as (keyof DesktopConfig)[]) {
    if (key === 'schema' || !(key in r)) continue;
    if (key === 'verifiedSystemAudioOsVersion') {
      const v = r[key];
      cfg.verifiedSystemAudioOsVersion = typeof v === 'string' && /^\d+(\.\d+){0,2}$/.test(v) ? v : null;
      continue;
    }
    try {
      Object.assign(cfg, parseConfigPatch({ [key]: r[key] }, normalizeServerUrl));
    } catch {
      /* keep default */
    }
  }
  return cfg;
}

export function saveConfig(file: string, cfg: DesktopConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function publicConfig(cfg: DesktopConfig): DesktopConfigPublic {
  const { schema: _s, verifiedSystemAudioOsVersion: _v, ...pub } = cfg;
  return pub;
}
