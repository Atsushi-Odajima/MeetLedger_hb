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

const COMMERCIAL: Record<string, string> = {
  allowed: '商用可',
  'allowed-with-attribution': '商用可・クレジット表記必須',
  unverified: '商用利用 未確認',
};

/** local-asr uses `licenses: [{component, license, url, attribution, commercialUse}]`; older shapes use `license`. */
function licensesOf(e: Rec): Rec[] {
  if (Array.isArray(e.licenses)) return e.licenses.filter(isRec);
  return [];
}

function licenseOf(e: Rec): string {
  const list = licensesOf(e);
  if (list.length) {
    return list
      .map((l) => {
        const name = str(l.license) ?? str(l.name) ?? '不明';
        const comp = str(l.component);
        const cu = typeof l.commercialUse === 'string' ? COMMERCIAL[l.commercialUse] : undefined;
        return `${comp ? `${comp}: ` : ''}${name}${cu ? `（${cu}）` : ''}`;
      })
      .join(' / ')
      .slice(0, 2000);
  }
  const l = e.license ?? e.licence ?? e.licenseName;
  if (typeof l === 'string' && l.trim()) return l.trim();
  if (isRec(l)) return str(l.name) ?? str(l.spdx) ?? str(l.id) ?? '不明';
  return '不明';
}

function attributionOf(e: Rec): string | null {
  const fromList = licensesOf(e)
    .map((l) => str(l.attribution))
    .filter((x): x is string => !!x);
  if (fromList.length) return fromList.join(' / ').slice(0, 2000);
  return str(e.attribution ?? e.credit ?? e.credits ?? (isRec(e.license) ? e.license.attribution : undefined));
}

function sourceOf(e: Rec): string | null {
  const direct = str(e.url) ?? str(e.sourceUrl) ?? str(e.homepage);
  if (direct) return direct;
  if (Array.isArray(e.downloads)) {
    const urls = e.downloads.filter(isRec).map((d) => str(d.url)).filter((x): x is string => !!x);
    if (urls.length) {
      try {
        return [...new Set(urls.map((u) => new URL(u).origin + new URL(u).pathname.split('/').slice(0, 3).join('/')))].join(', ');
      } catch {
        return urls[0]!;
      }
    }
  }
  return isRec(e.license) ? str(e.license.url) : null;
}

export function normalizeModel(e: Rec, installed: boolean): ModelInfo | null {
  const id = str(e.id) ?? str(e.modelId);
  if (!id || !MODEL_ID_RE.test(id)) return null;
  const kind = str(e.kind) ?? str(e.type) ?? '';
  return {
    id,
    name: str(e.title) ?? str(e.name) ?? str(e.label) ?? str(e.displayName) ?? id,
    languages: languagesOf(e),
    sizeBytes: sizeOf(e),
    license: licenseOf(e),
    attribution: attributionOf(e),
    sourceUrl: sourceOf(e),
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
    const phase = typeof a.phase === 'string' && /^[a-z]{1,20}$/.test(a.phase) ? a.phase : undefined;
    return { id, receivedBytes: received, totalBytes: total, fraction, ...(phase ? { phase } : {}) };
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
