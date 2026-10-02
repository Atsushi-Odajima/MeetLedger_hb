// MeetLedger operations CLI (bundled to dist/cli/index.js; also runnable with tsx src/cli/index.ts).
//   migrate                                   apply pending SQL migrations
//   backup  --out <file.tar.gz> [--no-storage] DB tables (JSON) + encrypted storage objects + manifest (sha256)
//   restore --in <file.tar.gz> [--force] [--allow-key-mismatch]
//   seed-sample --email <user email>          create the fictional Sample Workspace for an existing user
//   create-owner --email <e> --name <n> [--password <p> | env MEETLEDGER_OWNER_PASSWORD] [--org <name>] [--workspace <name>] [--reset-password]
//   retention-sweep                           run the retention sweep once (same as the hourly job)
// Output never contains customer content: only counts, ids and file names.
import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config';
import type { Deps } from '../context';
import { createPool, one, withSystem, type Pool } from '../db/pool';
import { runMigrations } from '../modules/data/migrations';
import { systemClock } from '../lib/clock';
import { hashPassword } from '../lib/crypto';
import { JobQueue } from '../jobs/queue';
import { LocalEncryptedStorage } from '../storage/localEncrypted';
import { createProviders } from '../providers/registry';
import { GuardedHttp } from '../privacy/externalHttp';
import { OutboxEmail } from '../modules/notifications/email';
import { createOrgWithWorkspace } from '../modules/core/auth';
import { createBackup, restoreBackup } from '../modules/data/backup';
import { runRetentionSweep } from '../modules/data/retention';
import { ensureSampleWorkspace } from '../modules/data/sample';
import { audit } from '../lib/audit';

export const USAGE = `MeetLedger CLI
Usage: node dist/cli/index.js <command> [options]

Commands:
  migrate                                    Apply pending database migrations
  backup --out <file.tar.gz> [--no-storage]   Create a backup (DB + encrypted storage + manifest)
  restore --in <file.tar.gz> [--force]        Restore a backup (refuses a non-empty database without --force)
          [--allow-key-mismatch]              (dangerous) restore even if MASTER_KEY differs
  seed-sample --email <email>                Create the fictional Sample Workspace for an existing user
  create-owner --email <e> --name <n> [--org <o>] [--workspace <w>] [--reset-password]
                                             Password: --password <p> or env MEETLEDGER_OWNER_PASSWORD
  retention-sweep                            Run the retention sweep once
Environment: DATABASE_URL, MASTER_KEY, STORAGE_DIR, TMP_DIR (see .env.example)`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function parseArgs(argv: string[]): { cmd: string | undefined; opts: Record<string, string | boolean> } {
  const [cmd, ...rest] = argv;
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) opts[k] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) opts[k] = rest[++i];
    else opts[k] = true;
  }
  return { cmd, opts };
}

function cliDeps(config: Config, pool: Pool): Deps {
  return {
    config,
    pool,
    clock: systemClock,
    storage: new LocalEncryptedStorage(config.STORAGE_DIR, config.MASTER_KEY),
    providers: createProviders(config),
    http: new GuardedHttp(pool),
    email: new OutboxEmail(),
    jobs: new JobQueue(),
    log: console,
  };
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Runs one CLI command. Returns the process exit code (0 ok, 1 failure, 2 usage). */
export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env, io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  const { cmd, opts } = parseArgs(argv);
  if (!cmd || cmd === 'help' || opts.help) {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  const known = ['migrate', 'backup', 'restore', 'seed-sample', 'create-owner', 'retention-sweep'];
  if (!known.includes(cmd)) {
    io.err(`unknown command: ${cmd}\n\n${USAGE}`);
    return 2;
  }
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (e) {
    io.err(`configuration error: ${(e as Error).message}`);
    return 1;
  }
  const pool = createPool(config.DATABASE_URL, 3);
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await runMigrations(pool, io.out);
        io.out(applied.length ? `applied ${applied.length} migration(s)` : 'up to date');
        return 0;
      }
      case 'backup': {
        const out = str(opts.out);
        if (!out) {
          io.err('backup requires --out <file.tar.gz>');
          return 2;
        }
        const m = await createBackup({ pool, storageDir: config.STORAGE_DIR, masterKey: config.MASTER_KEY, out: resolve(out), includeStorage: !opts['no-storage'], tmpDir: config.TMP_DIR, log: io.out });
        const rowsTotal = m.tables.reduce((a, t) => a + t.rows, 0);
        io.out(`backup complete: ${m.tables.length} tables, ${rowsTotal} rows, ${m.storage.objects} storage objects, key fingerprint ${m.keyFingerprint}`);
        return 0;
      }
      case 'restore': {
        const input = str(opts.in);
        if (!input) {
          io.err('restore requires --in <file.tar.gz>');
          return 2;
        }
        const r = await restoreBackup({
          pool,
          storageDir: config.STORAGE_DIR,
          masterKey: config.MASTER_KEY,
          input: resolve(input),
          force: !!opts.force,
          allowKeyMismatch: !!opts['allow-key-mismatch'],
          tmpDir: config.TMP_DIR,
          log: io.out,
        });
        const rowsTotal = Object.values(r.tables).reduce((a, n) => a + n, 0);
        io.out(`restore complete: ${Object.keys(r.tables).length} tables, ${rowsTotal} rows, ${r.storageObjects} storage objects (backup created ${r.manifest.createdAt})`);
        io.out('note: all sessions were invalidated; users must sign in again.');
        return 0;
      }
      case 'seed-sample': {
        const email = str(opts.email)?.toLowerCase();
        if (!email) {
          io.err('seed-sample requires --email <existing user email>');
          return 2;
        }
        if (!config.SAMPLE_WORKSPACE) {
          io.err('SAMPLE_WORKSPACE is disabled');
          return 1;
        }
        const u = await withSystem(pool, (db) => one<{ id: string }>(db, 'SELECT id FROM users WHERE email=$1', [email]));
        if (!u) {
          io.err('user not found');
          return 1;
        }
        const r = await ensureSampleWorkspace(cliDeps(config, pool), u.id);
        io.out(`${r.created ? 'created' : 'already exists'}: sample organization ${r.orgId}, workspace ${r.workspaceId}`);
        return 0;
      }
      case 'create-owner': {
        const email = str(opts.email)?.toLowerCase();
        const name = str(opts.name);
        const password = str(opts.password) ?? env.MEETLEDGER_OWNER_PASSWORD;
        if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || (!name && !opts['reset-password'])) {
          io.err('create-owner requires --email and --name');
          return 2;
        }
        if (!password || password.length < 10) {
          io.err('password must be at least 10 characters (--password or MEETLEDGER_OWNER_PASSWORD)');
          return 2;
        }
        const hash = await hashPassword(password);
        const r = await withSystem(pool, async (db) => {
          const existing = await one<{ id: string }>(db, 'SELECT id FROM users WHERE email=$1', [email]);
          if (existing) {
            if (!opts['reset-password']) return { error: 'user already exists (use --reset-password to set a new password)' };
            await db.query('UPDATE users SET password_hash=$2, disabled_at=NULL WHERE id=$1', [existing.id, hash]);
            await db.query('DELETE FROM sessions WHERE user_id=$1', [existing.id]);
            return { userId: existing.id, reset: true };
          }
          const u = await one<{ id: string }>(db, 'INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, name, hash]);
          const ids = await createOrgWithWorkspace(db, u!.id, str(opts.org) ?? 'My Organization', str(opts.workspace) ?? 'Main');
          await audit(db, { orgId: ids.orgId, userId: u!.id, action: 'owner.created_by_cli' });
          return { userId: u!.id, ...ids };
        });
        if ('error' in r) {
          io.err(String(r.error));
          return 1;
        }
        io.out('reset' in r ? `password reset for user ${r.userId}` : `owner created: user ${r.userId}, organization ${r.orgId}, workspace ${r.workspaceId}`);
        return 0;
      }
      case 'retention-sweep': {
        const c = await runRetentionSweep(cliDeps(config, pool));
        io.out(`retention sweep: ${JSON.stringify(c)}`);
        return 0;
      }
    }
    return 2;
  } catch (e) {
    io.err(`${cmd} failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await pool.end();
  }
}
