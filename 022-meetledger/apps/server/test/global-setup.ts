import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';

// Creates (once per migration set) a migrated template database; every test file clones it (fast, isolated).
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://meetledger:meetledger@127.0.0.1:55432/meetledger';

export function templateName(): string {
  const dir = join(__dirname, '..', 'src', 'db', 'migrations');
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return `ml_tpl_${h.digest('hex').slice(0, 12)}`;
}

export default async function setup() {
  const name = templateName();
  process.env.ML_TEMPLATE_DB = name;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(99117)');
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (!exists.rowCount) {
      await admin.query(`CREATE DATABASE ${name}`);
      const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
      const pool = createPool(url, 1);
      try {
        await migrate(pool);
      } catch (e) {
        await pool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        throw e;
      }
      await pool.end();
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock(99117)');
    await admin.end();
  }
}
