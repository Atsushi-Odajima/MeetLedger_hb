import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestDb, createTestEnv, type TestEnv } from './helpers';
import { seedRichWorkspace, streamToBuffer, type Owner, type RichWorkspace } from './data-helpers';
import { createPool, withSystem, type Pool } from '../src/db/pool';
import { createBackup, restoreBackup } from '../src/modules/data/backup';
import { loadCatalog } from '../src/modules/data/catalog';
import { LocalEncryptedStorage } from '../src/storage/localEncrypted';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/app';
import { runCli } from '../src/cli/main';

let env: TestEnv;
let owner: Owner;
let seed: RichWorkspace;
let work: string;
let archive: string;
const fresh: { url: string; drop: () => Promise<void>; pool: Pool }[] = [];

beforeAll(async () => {
  env = await createTestEnv();
  owner = await env.setupOwner('owner@example.com');
  seed = await seedRichWorkspace(env, owner);
  // a second tenant + workspace so the backup covers several orgs
  const b = await env.createTenant('second@example.com');
  await b.client.post(`/api/w/${b.workspaceId}/meetings`, { title: 'Tenant B meeting' });
  work = mkdtempSync(join(tmpdir(), 'ml-bk-test-'));
  archive = join(work, 'backup.tar.gz');
});
afterAll(async () => {
  for (const f of fresh) {
    await f.pool.end().catch(() => undefined);
    await f.drop().catch(() => undefined);
  }
  await env?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function newDb() {
  const db = await createTestDb();
  const pool = createPool(db.url, 3);
  const f = { ...db, pool };
  fresh.push(f);
  return f;
}

async function tableCounts(pool: Pool): Promise<Record<string, number>> {
  return withSystem(pool, async (db) => {
    const cat = await loadCatalog(db);
    const out: Record<string, number> = {};
    for (const t of [...cat.keys()].sort()) if (t !== 'schema_migrations') out[t] = (await db.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
    return out;
  });
}

const relations = (pool: Pool) =>
  withSystem(pool, async (db) => {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      decisions: await q('SELECT id, supersedes_decision_id, superseded_by_decision_id, meeting_id, text, source_segment_ids, participant_person_ids FROM decisions ORDER BY id'),
      actions: await q('SELECT id, linked_decision_id, assignee_person_id, assignee_speaker_id, meeting_id, due_date FROM actions ORDER BY id'),
      commitments: await q('SELECT id, meeting_id, promised_by_person_id, promised_to_person_id, promised_by_user_id FROM commitments ORDER BY id'),
      segments: await q('SELECT id, transcript_id, speaker_id, start_ms, text, tsv::text AS tsv FROM transcript_segments ORDER BY id'),
      media: await q('SELECT id, storage_key, sha256 FROM media_assets ORDER BY id'),
      users: await q('SELECT id, email, password_hash FROM users ORDER BY id'),
      summaries: await q('SELECT id, sections FROM summaries ORDER BY id'),
    };
  });

describe('data: backup / restore', () => {
  it('#24 backup → restore into a fresh database: counts, relations and encrypted media survive', async () => {
    const manifest = await createBackup({ pool: env.pool, storageDir: env.config.STORAGE_DIR, masterKey: env.config.MASTER_KEY, out: archive, tmpDir: work });
    expect(manifest.format).toBe('meetledger-backup/v1');
    expect(manifest.schemaMigrations).toContain('001_init.sql');
    expect(manifest.storage.objects).toBeGreaterThanOrEqual(1);
    expect(manifest.tables.map((t) => t.name)).not.toContain('sessions');
    // FK order: organizations/users before workspaces before meetings before transcript_segments
    const order = manifest.tables.map((t) => t.name);
    expect(order.indexOf('organizations')).toBeLessThan(order.indexOf('workspaces'));
    expect(order.indexOf('meetings')).toBeLessThan(order.indexOf('transcript_segments'));
    expect(Object.keys(manifest.files).every((f) => /^[0-9a-f]{64}$/.test(manifest.files[f]))).toBe(true);
    // storage objects are copied encrypted (no plaintext media inside the archive)
    const list: string[] = [];
    await tar.t({ file: archive, onReadEntry: (e) => list.push(e.path) });
    expect(list).toContain('manifest.json');
    expect(list).toContain(`storage/${seed.mediaKey}`);

    const target = await newDb();
    const storeB = join(work, 'storage-b');
    const r = await restoreBackup({ pool: target.pool, storageDir: storeB, masterKey: env.config.MASTER_KEY, input: archive, tmpDir: work });
    expect(r.storageObjects).toBe(manifest.storage.objects);

    const before = await tableCounts(env.pool);
    const after = await tableCounts(target.pool);
    delete before.sessions;
    expect(after.sessions).toBe(0);
    delete after.sessions;
    expect(after).toEqual(before);
    expect(after.meetings).toBeGreaterThanOrEqual(3);
    expect(await relations(target.pool)).toEqual(await relations(env.pool));
    const d2 = (await withSystem(target.pool, (db) => db.query('SELECT supersedes_decision_id FROM decisions WHERE id=$1', [seed.d2]))).rows[0];
    expect(d2.supersedes_decision_id).toBe(seed.d1);

    // the encrypted media object decrypts with the same MASTER_KEY in the new storage location
    const storage = new LocalEncryptedStorage(storeB, env.config.MASTER_KEY);
    expect((await streamToBuffer(await storage.getStream(seed.mediaKey))).equals(seed.mediaBytes)).toBe(true);

    // the restored installation works: owner logs in and sees the data (RLS / ACL intact)
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: target.url, STORAGE_DIR: storeB, TMP_DIR: join(work, 'tmp'), WEB_DIST_DIR: join(work, 'none'), APP_ORIGIN: 'http://localhost:8787' });
    const built = await buildApp({ config: cfg, pool: target.pool, logger: false });
    try {
      await built.app.ready();
      const c = new Client(built.app);
      expect((await c.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' })).status).toBe(200);
      const list2 = await c.get(`/api/w/${owner.workspaceId}/meetings`);
      expect(list2.status).toBe(200);
      expect(list2.body.items.map((m: any) => m.title)).toEqual(expect.arrayContaining(['Kickoff 会議', 'Review <b>会議</b>']));
      expect(list2.body.items.map((m: any) => m.title)).not.toContain('Tenant B meeting');
    } finally {
      await built.app.close();
    }

    // a non-empty database is refused without --force, replaced with --force
    await expect(restoreBackup({ pool: target.pool, storageDir: storeB, masterKey: env.config.MASTER_KEY, input: archive, tmpDir: work })).rejects.toThrow(/not empty/);
    await withSystem(target.pool, (db) => db.query(`UPDATE meetings SET title='changed after backup' WHERE id=$1`, [seed.m1]));
    writeFileSync(join(storeB, 'org', 'orphan.bin'), 'x');
    const forced = await restoreBackup({ pool: target.pool, storageDir: storeB, masterKey: env.config.MASTER_KEY, input: archive, force: true, tmpDir: work });
    expect(forced.removedObjects).toBe(1);
    const t = (await withSystem(target.pool, (db) => db.query('SELECT title FROM meetings WHERE id=$1', [seed.m1]))).rows[0];
    expect(t.title).toBe('Kickoff 会議');
    expect(await tableCounts(target.pool).then((x) => (delete x.sessions, x))).toEqual(before);
  });

  it('#24 restore verifies checksums and the MASTER_KEY before touching the database', async () => {
    // tamper with one table file inside the archive
    const x = join(work, 'tamper');
    rmSync(x, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(x, { recursive: true });
    await tar.x({ file: archive, cwd: x });
    const manifest = JSON.parse(readFileSync(join(x, 'manifest.json'), 'utf8'));
    const meetingsFile = manifest.tables.find((t: any) => t.name === 'meetings').file;
    writeFileSync(join(x, meetingsFile), readFileSync(join(x, meetingsFile), 'utf8').replace('Kickoff', 'Hacked!'));
    const tampered = join(work, 'tampered.tar.gz');
    await tar.c({ gzip: true, file: tampered, cwd: x }, ['manifest.json', 'tables', 'storage']);
    const target = await newDb();
    await expect(restoreBackup({ pool: target.pool, storageDir: join(work, 's-t'), masterKey: env.config.MASTER_KEY, input: tampered, tmpDir: work })).rejects.toThrow(/checksum mismatch/);
    // wrong key
    const otherKey = Buffer.alloc(32, 7).toString('base64');
    await expect(restoreBackup({ pool: target.pool, storageDir: join(work, 's-k'), masterKey: otherKey, input: archive, tmpDir: work })).rejects.toThrow(/MASTER_KEY/);
    // nothing was written
    expect((await withSystem(target.pool, (db) => db.query('SELECT count(*)::int n FROM users'))).rows[0].n).toBe(0);
  });

  it('CLI: backup / restore / migrate / create-owner / retention-sweep commands', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const baseEnv = { NODE_ENV: 'test', MASTER_KEY: env.config.MASTER_KEY, TMP_DIR: join(work, 'cli-tmp'), MEETLEDGER_FAST_HASH: '1' };
    const cliArchive = join(work, 'cli.tar.gz');
    expect(await runCli(['backup', '--out', cliArchive], { ...baseEnv, DATABASE_URL: env.config.DATABASE_URL, STORAGE_DIR: env.config.STORAGE_DIR }, io)).toBe(0);
    expect(out.join('\n')).toMatch(/backup complete: \d+ tables/);
    expect(out.join('\n')).not.toContain('Kickoff'); // no content in CLI output

    const target = await newDb();
    const tEnv = { ...baseEnv, DATABASE_URL: target.url, STORAGE_DIR: join(work, 'cli-store') };
    expect(await runCli(['migrate'], tEnv, io)).toBe(0);
    expect(await runCli(['restore', '--in', cliArchive], tEnv, io)).toBe(0);
    expect(await runCli(['restore', '--in', cliArchive], tEnv, io)).toBe(1);
    expect(err.join('\n')).toMatch(/not empty/);
    expect(await runCli(['restore'], tEnv, io)).toBe(2);
    expect(await runCli(['retention-sweep'], tEnv, io)).toBe(0);
    expect(out.join('\n')).toMatch(/retention sweep: \{"orgs":\d+/);

    expect(await runCli(['create-owner', '--email', 'ops@example.com', '--name', 'Ops', '--password', 'correct horse battery'], tEnv, io)).toBe(0);
    expect(await runCli(['create-owner', '--email', 'ops@example.com', '--name', 'Ops', '--password', 'correct horse battery'], tEnv, io)).toBe(1);
    expect(await runCli(['create-owner', '--email', 'ops@example.com', '--reset-password', '--password', 'another horse battery'], tEnv, io)).toBe(0);
    expect(await runCli(['create-owner', '--email', 'x@example.com', '--name', 'X', '--password', 'short'], tEnv, io)).toBe(2);
    expect(await runCli(['nope'], tEnv, io)).toBe(2);
    const owners = (await withSystem(target.pool, (db) => db.query(`SELECT om.role FROM users u JOIN org_members om ON om.user_id=u.id WHERE u.email='ops@example.com'`))).rows;
    expect(owners).toEqual([{ role: 'owner' }]);
  });
});
