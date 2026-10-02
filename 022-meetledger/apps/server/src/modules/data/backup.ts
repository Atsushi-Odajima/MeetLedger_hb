// Operator backup / restore (CLI `backup --out x.tar.gz`, `restore --in x.tar.gz [--force]`).
// Archive layout (tar.gz):
//   manifest.json        format, app version, schema migrations, createdAt, key fingerprint, sha256 of every file
//   tables/NNN-<t>.jsonl one JSON object per row (to_jsonb), tables ordered by FK dependencies
//   storage/...          object storage files AS-IS (still AES-256-GCM encrypted → the same MASTER_KEY is required)
// Runs in system context (RLS bypass is allowed for backup/restore only). The DB snapshot is taken in one
// REPEATABLE READ transaction. `sessions` are not backed up (everyone signs in again after a restore).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import * as tar from 'tar';
import type { Db, Pool } from '../../db/pool';
import { runMigrations } from './migrations';
import { deriveKey, hmac } from '../../lib/crypto';
import { insertColumns, insertionPlan, insertJsonText, loadCatalog, qi, updateDeferredJsonText } from './catalog';
import { APP_VERSION } from './meetingExport';

export const BACKUP_FORMAT = 'meetledger-backup/v1';
export const BACKUP_EXCLUDED_TABLES = ['schema_migrations', 'sessions'];

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  appVersion: string;
  createdAt: string;
  schemaMigrations: string[];
  tables: { name: string; file: string; rows: number }[];
  excludedTables: string[];
  storage: { included: boolean; driver: 'local-encrypted'; objects: number; encrypted: true };
  keyFingerprint: string;
  files: Record<string, string>;
}

/** Non-secret fingerprint of MASTER_KEY: lets restore detect a wrong key before touching anything. */
export function keyFingerprint(masterKey: string): string {
  return hmac(deriveKey(masterKey, 'meetledger:backup-fingerprint'), 'v1').slice(0, 22);
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function walk(dir: string, base = dir): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else if (e.isFile() && !e.name.includes('.part-')) out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

async function withSnapshot<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SELECT set_config('app.system', 'on', true), set_config('app.org_id', '', true)");
    const r = await fn(db);
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}

export interface BackupOptions {
  pool: Pool;
  storageDir: string;
  masterKey: string;
  out: string;
  includeStorage?: boolean;
  tmpDir?: string;
  now?: Date;
  log?: (msg: string) => void;
}

export async function createBackup(o: BackupOptions): Promise<BackupManifest> {
  const log = o.log ?? (() => undefined);
  const staging = await mkdtemp(join(o.tmpDir ?? tmpdir(), 'ml-backup-'));
  try {
    await mkdir(join(staging, 'tables'), { recursive: true });
    const { migrations, tables } = await withSnapshot(o.pool, async (db) => {
      const cat = await loadCatalog(db);
      const migrations = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name as string);
      const plan = insertionPlan(cat, [...cat.keys()].filter((t) => !BACKUP_EXCLUDED_TABLES.includes(t)));
      const tables: BackupManifest['tables'] = [];
      for (const [i, t] of plan.order.entries()) {
        const file = `tables/${String(i + 1).padStart(3, '0')}-${t}.jsonl`;
        const out = createWriteStream(join(staging, file), { encoding: 'utf8' });
        let n = 0;
        await db.query(`DECLARE ml_backup_cur NO SCROLL CURSOR FOR SELECT to_jsonb(a)::text AS j FROM ${qi(t)} a`);
        for (;;) {
          const r = await db.query('FETCH 2000 FROM ml_backup_cur');
          if (!r.rows.length) break;
          const chunk = r.rows.map((x) => x.j).join('\n') + '\n';
          if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
          n += r.rows.length;
        }
        await db.query('CLOSE ml_backup_cur');
        await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
        tables.push({ name: t, file, rows: n });
        log(`table ${t}: ${n} rows`);
      }
      return { migrations, tables };
    });
    let objects = 0;
    const includeStorage = o.includeStorage !== false;
    if (includeStorage) {
      const root = resolve(o.storageDir);
      for (const rel of await walk(root)) {
        const dest = join(staging, 'storage', rel);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(root, rel), dest);
        objects++;
      }
      log(`storage objects: ${objects}`);
    }
    const files: Record<string, string> = {};
    for (const rel of await walk(staging)) files[rel] = await sha256File(join(staging, rel));
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      appVersion: APP_VERSION,
      createdAt: (o.now ?? new Date()).toISOString(),
      schemaMigrations: migrations,
      tables,
      excludedTables: BACKUP_EXCLUDED_TABLES,
      storage: { included: includeStorage, driver: 'local-encrypted', objects, encrypted: true },
      keyFingerprint: keyFingerprint(o.masterKey),
      files,
    };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await mkdir(dirname(resolve(o.out)), { recursive: true });
    const entries = ['manifest.json', 'tables', ...(objects ? ['storage'] : [])];
    await tar.c({ gzip: true, file: resolve(o.out), cwd: staging, portable: true }, entries);
    log(`backup written: ${o.out}`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface RestoreOptions {
  pool: Pool;
  storageDir: string;
  masterKey: string;
  input: string;
  force?: boolean;
  allowKeyMismatch?: boolean;
  tmpDir?: string;
  log?: (msg: string) => void;
}

export interface RestoreResult {
  manifest: BackupManifest;
  tables: Record<string, number>;
  storageObjects: number;
  removedObjects: number;
}

export class RestoreError extends Error {}

async function readManifest(staging: string): Promise<BackupManifest> {
  let m: BackupManifest;
  try {
    m = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'));
  } catch {
    throw new RestoreError('manifest.json is missing or invalid');
  }
  if (m.format !== BACKUP_FORMAT) throw new RestoreError(`unsupported backup format: ${String(m.format)}`);
  if (!m.files || typeof m.files !== 'object' || !Array.isArray(m.tables) || !Array.isArray(m.schemaMigrations)) throw new RestoreError('manifest is incomplete');
  return m;
}

/** Verifies that the archive contains exactly the files listed in the manifest with matching sha256. */
export async function verifyBackupFiles(staging: string, m: BackupManifest) {
  const present = new Set((await walk(staging)).filter((f) => f !== 'manifest.json'));
  for (const [rel, sum] of Object.entries(m.files)) {
    if (isAbsolute(rel) || rel.split('/').includes('..')) throw new RestoreError(`invalid path in manifest: ${rel}`);
    if (!present.has(rel)) throw new RestoreError(`file listed in manifest is missing: ${rel}`);
    if ((await sha256File(join(staging, rel))) !== sum) throw new RestoreError(`checksum mismatch: ${rel}`);
    present.delete(rel);
  }
  if (present.size) throw new RestoreError(`unexpected file(s) in archive: ${[...present].slice(0, 5).join(', ')}`);
}

async function* lineBatches(path: string, max = 500, maxBytes = 8 * 1024 * 1024): AsyncGenerator<string[]> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let batch: string[] = [];
  let bytes = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    batch.push(line);
    bytes += line.length;
    if (batch.length >= max || bytes >= maxBytes) {
      yield batch;
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length) yield batch;
}

export async function restoreBackup(o: RestoreOptions): Promise<RestoreResult> {
  const log = o.log ?? (() => undefined);
  const staging = await mkdtemp(join(o.tmpDir ?? tmpdir(), 'ml-restore-'));
  try {
    // node-tar strips absolute paths and refuses '..' entries (no path traversal on extraction).
    await tar.x({ file: resolve(o.input), cwd: staging, strict: true });
    const m = await readManifest(staging);
    await verifyBackupFiles(staging, m);
    log('checksums verified');
    if (m.keyFingerprint !== keyFingerprint(o.masterKey)) {
      if (!o.allowKeyMismatch)
        throw new RestoreError('MASTER_KEY does not match the key used for this backup: encrypted media and secrets could not be decrypted. Configure the original MASTER_KEY (key escrow).');
      log('WARNING: MASTER_KEY mismatch accepted — encrypted media and connector secrets will be unreadable');
    }
    await runMigrations(o.pool, log);
    const db = await o.pool.connect();
    let committed = false;
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.system', 'on', true), set_config('app.org_id', '', true)");
      const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
      const newer = m.schemaMigrations.filter((x) => !applied.has(x));
      if (newer.length) throw new RestoreError(`backup was created by a newer schema (${newer.join(', ')}); upgrade MeetLedger before restoring`);
      const cat = await loadCatalog(db);
      const nonEmpty = (await db.query('SELECT (EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM organizations)) AS x')).rows[0].x as boolean;
      if (nonEmpty && !o.force) throw new RestoreError('target database is not empty; refusing to restore (use --force to replace ALL data)');
      if (nonEmpty) {
        const all = [...cat.keys()].filter((t) => t !== 'schema_migrations');
        await db.query(`TRUNCATE ${all.map(qi).join(', ')} CASCADE`);
        log('existing data truncated (--force)');
      }
      const fileOf = new Map(m.tables.filter((t) => cat.has(t.name) && !BACKUP_EXCLUDED_TABLES.includes(t.name)).map((t) => [t.name, t]));
      const unknownTables = m.tables.filter((t) => !cat.has(t.name)).map((t) => t.name);
      if (unknownTables.length) throw new RestoreError(`backup contains tables unknown to this schema: ${unknownTables.join(', ')}`);
      const plan = insertionPlan(cat, [...fileOf.keys()]);
      const counts: Record<string, number> = {};
      for (const t of plan.order) {
        const entry = fileOf.get(t)!;
        const info = cat.get(t)!;
        const deferred = plan.deferred.get(t) ?? [];
        const path = join(staging, entry.file);
        let n = 0;
        let cols: string[] | null = null;
        for await (const batch of lineBatches(path)) {
          cols ??= insertColumns(info, Object.keys(JSON.parse(batch[0])), deferred);
          n += await insertJsonText(db, info, cols, `[${batch.join(',')}]`);
        }
        if (deferred.length) for await (const batch of lineBatches(path)) await updateDeferredJsonText(db, info, deferred, `[${batch.join(',')}]`);
        if (n !== entry.rows) throw new RestoreError(`row count mismatch for ${t}: manifest ${entry.rows}, restored ${n}`);
        counts[t] = n;
        log(`table ${t}: ${n} rows`);
      }
      // Storage objects are copied as-is (still encrypted) before the DB transaction commits.
      const root = resolve(o.storageDir);
      const objects = (await walk(join(staging, 'storage'))) ?? [];
      for (const rel of objects) {
        const dest = resolve(root, rel);
        if (!dest.startsWith(root + sep)) throw new RestoreError(`invalid storage path: ${rel}`);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(staging, 'storage', rel), dest);
      }
      let removed = 0;
      if (o.force && m.storage?.included) {
        const keep = new Set(objects);
        for (const rel of await walk(root)) {
          if (!keep.has(rel)) {
            await rm(join(root, rel), { force: true });
            removed++;
          }
        }
      }
      log(`storage objects restored: ${objects.length}${removed ? `, removed ${removed} objects not in backup` : ''}`);
      await db.query('COMMIT');
      committed = true;
      return { manifest: m, tables: counts, storageObjects: objects.length, removedObjects: removed };
    } finally {
      if (!committed) await db.query('ROLLBACK').catch(() => undefined);
      db.release();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Reads only the manifest of a backup archive (for `restore --dry-run` style checks and docs). */
export async function readBackupManifest(input: string, tmp?: string): Promise<BackupManifest> {
  const staging = await mkdtemp(join(tmp ?? tmpdir(), 'ml-manifest-'));
  try {
    await tar.x({ file: resolve(input), cwd: staging, strict: true }, ['manifest.json']);
    return await readManifest(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function fileSize(path: string) {
  return (await stat(path)).size;
}
