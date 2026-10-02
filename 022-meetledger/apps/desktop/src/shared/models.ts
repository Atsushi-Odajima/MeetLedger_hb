// Normalizes @meetledger/local-asr data (MODEL_CATALOG entries, checkModels results, download progress) into the
// stable shapes the bridge exposes. local-asr is developed in parallel; field names are matched defensively so the
// desktop keeps working if the catalog uses e.g. `sizeBytes` vs `sizeMB` or `license` vs `licence`.

import type { ModelInfo, ModelProgress } from './ipc';
import { MODEL_ID_RE } from './validate';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function catalogEntries(catalog: unknown): Rec[] {
  if (Array.isArray(catalog)) return catalog.filter(isRec);
  if (isRec(catalog)) {
    return Object.entries(catalog)
      .filter(([, v]) => isRec(v))
      .map(([k, v]) => ({ id: k, ...(v as Rec) }));
  }
  return [];
}

function sizeOf(e: Rec): number | null {
  const direct = num(e.sizeBytes) ?? num(e.bytes) ?? num(e.downloadBytes) ?? num(e.archiveBytes);
  if (direct !== null) return Math.round(direct);
  const mb = num(e.sizeMB) ?? num(e.sizeMb) ?? num(e.downloadMB);
  if (mb !== null) return Math.round(mb * 1_000_000);
  if (typeof e.size === 'number') return num(e.size);
  if (Array.isArray(e.files)) {
    let total = 0;
    for (const f of e.files) {
      const b = isRec(f) ? (num(f.sizeBytes) ?? num(f.bytes) ?? num(f.size)) : null;
      if (b === null) return null;
      total += b;
    }
    return total || null;
  }
  return null;
}

function languagesOf(e: Rec): string[] {
  const v = e.languages ?? e.langs ?? e.language;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').slice(0, 20);
  if (typeof v === 'string') return v.split(/[\s,/]+/).filter(Boolean).slice(0, 20);
  return [];
}

function licenseOf(e: Rec): string {
  const l = e.license ?? e.licence ?? e.licenseName;
  if (typeof l === 'string' && l.trim()) return l.trim();
  if (isRec(l)) return str(l.name) ?? str(l.spdx) ?? str(l.id) ?? '不明';
  return '不明';
}

export function normalizeModel(e: Rec, installed: boolean): ModelInfo | null {
  const id = str(e.id) ?? str(e.modelId);
  if (!id || !MODEL_ID_RE.test(id)) return null;
  const kind = str(e.kind) ?? str(e.type) ?? '';
  const attributionRaw = e.attribution ?? e.credit ?? e.credits ?? (isRec(e.license) ? e.license.attribution : undefined);
  return {
    id,
    name: str(e.name) ?? str(e.label) ?? str(e.displayName) ?? id,
    languages: languagesOf(e),
    sizeBytes: sizeOf(e),
    license: licenseOf(e),
    attribution: str(attributionRaw),
    sourceUrl: str(e.url) ?? str(e.sourceUrl) ?? str(e.homepage) ?? (isRec(e.license) ? str(e.license.url) : null),
    diarization: e.diarization === true || /diar|segment|speaker|embedding/i.test(kind),
    installed,
  };
}

/** checkModels() may return boolean, {ok}, {installed}, {present}, or {missing: string[]}. */
export function normalizeCheck(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (isRec(v)) {
    for (const k of ['ok', 'installed', 'present', 'ready', 'available'] as const) if (typeof v[k] === 'boolean') return v[k] as boolean;
    if (Array.isArray(v.missing)) return v.missing.length === 0;
  }
  return false;
}

/** downloadModel's onProgress may be (received, total), ({receivedBytes,totalBytes}), ({loaded,total}) or (fraction). */
export function normalizeProgress(id: string, args: unknown[]): ModelProgress {
  const [a, b] = args;
  if (typeof a === 'number' && typeof b === 'number') {
    return { id, receivedBytes: a, totalBytes: b > 0 ? b : null, fraction: b > 0 ? Math.min(1, a / b) : null };
  }
  if (typeof a === 'number') {
    if (a >= 0 && a <= 1) return { id, receivedBytes: null, totalBytes: null, fraction: a };
    return { id, receivedBytes: a, totalBytes: null, fraction: null };
  }
  if (isRec(a)) {
    const received = num(a.receivedBytes) ?? num(a.received) ?? num(a.loaded) ?? num(a.downloaded) ?? num(a.bytes);
    const total = num(a.totalBytes) ?? num(a.total) ?? num(a.size);
    const frac = num(a.fraction) ?? num(a.progress) ?? num(a.percent);
    const fraction = frac !== null ? (frac > 1 ? Math.min(1, frac / 100) : frac) : received !== null && total ? Math.min(1, received / total) : null;
    return { id, receivedBytes: received, totalBytes: total, fraction };
  }
  return { id, receivedBytes: null, totalBytes: null, fraction: null };
}

export function formatBytes(n: number | null): string {
  if (n === null) return '不明';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
