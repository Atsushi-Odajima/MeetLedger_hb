import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool';

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'migrations'), join(here, 'db', 'migrations'), join(here, '..', 'src', 'db', 'migrations')]) {
    if (existsSync(c)) return c;
  }
  throw new Error('migrations directory not found');
}

/** Applies pending *.sql migrations in lexical order inside one transaction each. */
export async function migrate(pool: Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  const db = await pool.connect();
  const applied: string[] = [];
  try {
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('SELECT pg_advisory_lock(727274)');
    const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
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
      } catch (e) {
        await db.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    db.release();
  }
  return applied;
}
