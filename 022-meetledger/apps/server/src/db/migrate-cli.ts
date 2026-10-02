import { loadConfig } from '../config';
import { createPool } from './pool';
import { migrate } from './migrate';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL, 1);
migrate(pool, console.log)
  .then((a) => console.log(a.length ? `applied ${a.length} migration(s)` : 'up to date'))
  .finally(() => pool.end());
