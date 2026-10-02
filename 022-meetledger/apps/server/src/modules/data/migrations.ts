// Migration entry for CLI / restore. Uses the canonical db/migrate.ts runner; when it cannot locate the SQL files
// (bundled CLI lives in dist/cli/ while build.mjs copies migrations to dist/migrations) the same algorithm runs
// against the directory found here (same schema_migrations table and advisory lock).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from '../../db/pool';
import { migrate } from '../../db/migrate';

export function findMigrationsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'migrations'), // dist/cli/index.js -> dist/migrations
    join(here, 'migrations'),
    join(here, '..', '..', 'db', 'migrations'), // src/modules/data -> src/db/migrations
    resolve(process.cwd(), 'dist', 'migrations'),
    resolve(process.cwd(), 'src', 'db', 'migrations'),
    resolve(process.cwd(), 'apps', 'server', 'src', 'db', 'migrations'),
  ];
  return candidates.find((c) => existsSync(c) && readdirSync(c).some((f) => f.endsWith('.sql'))) ?? null;
}

export async function runMigrations(pool: Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  try {
    return await migrate(pool, log);
  } catch (e) {
    if (!/migrations directory not found/.test((e as Error).message)) throw e;
  }
  const dir = findMigrationsDir();
  if (!dir) throw new Error('migrations directory not found');
  const db = await pool.connect();
  const applied: string[] = [];
  try {
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('SELECT pg_advisory_lock(727274)');
    const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await db.query('BEGIN');
      try {
        await db.query("SELECT set_config('app.system', 'on', true)");
        await db.query(readFileSync(join(dir, f), 'utf8'));
        await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await db.query('COMMIT');
        applied.push(f);
        log(`migration applied: ${f}`);
      } catch (err) {
        await db.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    db.release();
  }
  return applied;
}
