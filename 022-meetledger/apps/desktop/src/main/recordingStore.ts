// Recordings live in <userData>/recordings with owner-only permissions. Renderers never see file paths:
// they get an opaque 256-bit token that is bound to the webContents that created it.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RecordingMime } from '../shared/validate';

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  path: string;
  mimeType: RecordingMime;
  bytes: number;
  ownerId: number;
  createdAt: number;
}

const EXT: Record<RecordingMime, string> = { 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

export class RecordingStore {
  private entries = new Map<string, Entry>();
  /** Files that belong to the live recorder session and must not be removed by "clear". */
  private protectedPaths = new Set<string>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  newToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  pathFor(token: string, ext: string): string {
    return path.join(this.dir, `rec-${token}.${ext}`);
  }

  async save(ownerId: number, mimeType: RecordingMime, data: Uint8Array): Promise<{ fileToken: string; bytes: number }> {
    const token = this.newToken();
    const p = this.pathFor(token, EXT[mimeType]);
    await fsp.writeFile(p, data, { mode: 0o600, flag: 'wx' });
    this.entries.set(token, { path: p, mimeType, bytes: data.byteLength, ownerId, createdAt: Date.now() });
    return { fileToken: token, bytes: data.byteLength };
  }

  get(token: string, ownerId: number): Entry {
    const e = this.entries.get(token);
    // same error for "unknown" and "not yours" — do not leak which tokens exist
    if (!e || e.ownerId !== ownerId) throw new StoreError('not_found', '録音ファイルが見つかりません');
    return e;
  }

  async discard(token: string, ownerId: number): Promise<void> {
    const e = this.get(token, ownerId);
    this.entries.delete(token);
    await fsp.rm(e.path, { force: true });
  }

  /** Web-bridge recordings are working copies: removed when their page/window goes away. */
  async discardOwner(ownerId: number): Promise<void> {
    for (const [t, e] of this.entries) {
      if (e.ownerId !== ownerId) continue;
      this.entries.delete(t);
      await fsp.rm(e.path, { force: true }).catch(() => undefined);
    }
  }

  protect(p: string): void {
    this.protectedPaths.add(p);
  }

  unprotect(p: string): void {
    this.protectedPaths.delete(p);
  }

  async info(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const name of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      if (!name.startsWith('rec-')) continue;
      const st = await fsp.stat(path.join(this.dir, name)).catch(() => null);
      if (st?.isFile()) {
        files++;
        bytes += st.size;
      }
    }
    return { files, bytes };
  }

  /** Deletes every recording on disk except the live session's files. */
  async clear(): Promise<{ removed: number }> {
    let removed = 0;
    const inUse = new Set([...this.protectedPaths]);
    for (const name of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      const p = path.join(this.dir, name);
      if (!name.startsWith('rec-') || inUse.has(p)) continue;
      await fsp.rm(p, { force: true });
      removed++;
    }
    for (const [t, e] of this.entries) if (!fs.existsSync(e.path)) this.entries.delete(t);
    return { removed };
  }
}
