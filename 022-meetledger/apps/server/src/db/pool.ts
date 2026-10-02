import pg from 'pg';

export type Db = pg.PoolClient;
export type Pool = pg.Pool;

// Dates (date columns) are returned as 'YYYY-MM-DD' strings instead of JS Dates (no TZ shifting).
pg.types.setTypeParser(1082, (v: string) => v);
// int8 (counts) -> number (safe for our ranges).
pg.types.setTypeParser(20, (v: string) => Number(v));

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30000, application_name: 'meetledger' });
}

async function inTx<T>(pool: Pool, setup: (db: Db) => Promise<void>, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await setup(db);
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}

/** Runs fn in a transaction scoped to one tenant: row level security only exposes rows of `orgId`. */
export function withTenant<T>(pool: Pool, orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTx(pool, (db) => db.query("SELECT set_config('app.org_id', $1, true), set_config('app.system', '', true)", [orgId]).then(() => undefined), fn);
}

/**
 * System context (bypasses tenant RLS). ONLY for: auth/session lookup, job claiming, schedulers iterating orgs,
 * migrations, backup/restore. Never call from request handlers with user-controlled SQL.
 */
export function withSystem<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTx(pool, (db) => db.query("SELECT set_config('app.system', 'on', true), set_config('app.org_id', '', true)").then(() => undefined), fn);
}

export async function rows<T = any>(db: Db | Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(db: Db | Pool, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params as any[]);
  return (r.rows[0] as T) ?? null;
}
