import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getModelEntry, type ModelCatalogEntry, type ModelDownload } from './catalog';

export interface ModelCheck {
  ok: boolean;
  modelId: string;
  modelDir: string;
  /** role -> absolute path (only meaningful when ok). */
  files: Record<string, string>;
  /** Relative paths that are missing or empty. */
  missing: string[];
}

/** Checks whether all files of a catalog model exist (non-empty) under modelDir. Never touches the network. */
export function checkModels(modelDir: string, modelId: string): ModelCheck {
  const entry = getModelEntry(modelId);
  const dir = resolve(modelDir);
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const [role, rel] of Object.entries(entry.files)) {
    const abs = join(dir, rel);
    files[role] = abs;
    let ok = false;
    try {
      ok = statSync(abs).isFile() && statSync(abs).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) missing.push(rel);
  }
  return { ok: missing.length === 0, modelId, modelDir: dir, files, missing };
}

export interface DownloadProgress {
  modelId: string;
  url: string;
  phase: 'download' | 'verify' | 'extract' | 'skip' | 'done';
  receivedBytes: number;
  totalBytes: number;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Injected fetch (tests). Defaults to globalThis.fetch. Behind a proxy run Node with NODE_USE_ENV_PROXY=1. */
  fetchImpl?: typeof fetch;
  /** tar executable used for .tar.bz2 extraction (GNU tar / bsdtar; Windows 10+ ships tar.exe). */
  tarPath?: string;
}

function downloadSatisfied(modelDir: string, d: ModelDownload, entry: ModelCatalogEntry): boolean {
  // A download is satisfied when every catalog file that lives under its destination exists.
  const rels = Object.values(entry.files).filter((rel) => rel === d.dest || rel.startsWith(`${d.dest}/`));
  if (!rels.length) return existsSync(join(modelDir, d.dest));
  return rels.every((rel) => {
    try {
      return statSync(join(modelDir, rel)).size > 0;
    } catch {
      return false;
    }
  });
}

function runTar(tarPath: string, archive: string, cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    // No shell; fixed argument list. GNU tar and bsdtar both refuse absolute paths / '..' members by default.
    const p = spawn(tarPath, ['-xjf', archive, '-C', cwd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += String(c).slice(0, 2000)));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`tar exited with ${code}: ${err.slice(0, 300)}`))));
  });
}

/**
 * Downloads a catalog model into modelDir. MUST only be called on an explicit user action
 * (CLI `download`, desktop "モデルをダウンロード" button). Archives are size-checked (and SHA-256 verified when pinned)
 * before extraction. Already present files are skipped.
 */
export async function downloadModel(
  id: string,
  modelDir: string,
  onProgress?: (p: DownloadProgress) => void,
  opts: DownloadOptions = {},
): Promise<ModelCheck> {
  const entry = getModelEntry(id);
  const dir = resolve(modelDir);
  await mkdir(dir, { recursive: true });
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  for (const d of entry.downloads) {
    if (downloadSatisfied(dir, d, entry)) {
      onProgress?.({ modelId: id, url: d.url, phase: 'skip', receivedBytes: d.sizeBytes, totalBytes: d.sizeBytes });
      continue;
    }
    const part = join(dir, `.download-${randomBytes(6).toString('hex')}.part`);
    try {
      const res = await doFetch(d.url, { redirect: 'follow', signal: opts.signal });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${d.url}`);
      const total = Number(res.headers.get('content-length') ?? d.sizeBytes) || d.sizeBytes;
      const hash = createHash('sha256');
      let received = 0;
      let lastEmit = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          received += chunk.length;
          hash.update(chunk);
          if (received - lastEmit > 1 << 20 || received === total) {
            lastEmit = received;
            onProgress?.({ modelId: id, url: d.url, phase: 'download', receivedBytes: received, totalBytes: total });
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as any), tap, createWriteStream(part), { signal: opts.signal });
      onProgress?.({ modelId: id, url: d.url, phase: 'verify', receivedBytes: received, totalBytes: total });
      if (received !== d.sizeBytes) throw new Error(`size mismatch for ${d.dest}: got ${received}, expected ${d.sizeBytes}`);
      const digest = hash.digest('hex');
      if (d.sha256 && digest !== d.sha256) throw new Error(`sha256 mismatch for ${d.dest}`);
      if (d.type === 'tar.bz2') {
        onProgress?.({ modelId: id, url: d.url, phase: 'extract', receivedBytes: received, totalBytes: total });
        await runTar(opts.tarPath ?? 'tar', part, dir);
      } else {
        await rename(part, join(dir, d.dest));
      }
    } finally {
      await rm(part, { force: true });
    }
  }
  const check = checkModels(dir, id);
  if (!check.ok) throw new Error(`model ${id} incomplete after download: missing ${check.missing.join(', ')}`);
  onProgress?.({ modelId: id, url: '', phase: 'done', receivedBytes: entry.sizeBytes, totalBytes: entry.sizeBytes });
  return check;
}
