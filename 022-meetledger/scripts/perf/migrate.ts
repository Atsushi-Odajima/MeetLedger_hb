// Migrates the database at PERF_DATABASE_URL (perf runs use a dedicated DB).
import { createPool } from '../../apps/server/src/db/pool';
import { migrate } from '../../apps/server/src/db/migrate';
const pool = createPool(process.env.PERF_DATABASE_URL!, 1);
await migrate(pool, console.log);
await pool.end();
