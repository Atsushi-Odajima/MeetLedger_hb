// scratch: time each SQL statement of runSearch / runAsk on the perf DB (removed after tuning)
import { loadConfig } from '../../apps/server/src/config';
import { createPool, withSystem, withTenant } from '../../apps/server/src/db/pool';
import { runSearch, searchQuerySchema } from '../../apps/server/src/modules/search/search';
import { runAsk } from '../../apps/server/src/modules/search/ask';
import { buildApp } from '../../apps/server/src/app';
const url = 'postgres://meetledger:meetledger@127.0.0.1:55432/ml_perf';
const pool = createPool(url, 4);
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, STORAGE_DIR: '/tmp/ml-perf-store', TMP_DIR: '/tmp/ml-perf-tmp', LOG_LEVEL: 'warn', WEB_DIST_DIR: '/nonexistent' });
const { deps } = await buildApp({ config, pool, logger: false });
const ids = await withSystem(pool, async (db) => {
  const ws = (await db.query("SELECT id, org_id FROM workspaces WHERE name='Perf Workspace' LIMIT 1")).rows[0];
  const u = (await db.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 LIMIT 1', [ws.id])).rows[0];
  const project = (await db.query('SELECT project_id FROM meetings WHERE workspace_id=$1 AND project_id IS NOT NULL GROUP BY project_id ORDER BY count(*) DESC LIMIT 1', [ws.id])).rows[0];
  const person = (await db.query('SELECT person_id FROM participants p GROUP BY person_id ORDER BY count(*) DESC LIMIT 1')).rows[0];
  return { ws: ws.id, org: ws.org_id, user: u.user_id, project: project.project_id, person: person.person_id };
});
const ctx: any = { deps, userId: ids.user, user: { id: ids.user, timezone: 'Asia/Tokyo', locale: 'ja' }, orgId: ids.org, workspaceId: ids.ws, role: 'owner', tx: (fn: any) => withTenant(pool, ids.org, fn) };
const mode = process.argv[2];
const arg = JSON.parse(process.argv[3] ?? '{}');
for (const k of Object.keys(arg)) if (arg[k] === '$project') arg[k] = ids.project; else if (arg[k] === '$person') arg[k] = ids.person;
const wrap = (db: any) => {
  const orig = db.query.bind(db);
  db.query = async (sql: any, params: any) => {
    const t = Date.now();
    const r = await orig(sql, params);
    const ms = Date.now() - t; (globalThis as any).__nq = ((globalThis as any).__nq ?? 0) + 1; (globalThis as any).__ms = ((globalThis as any).__ms ?? 0) + ms;
    if (ms > 50) console.log(`--- ${ms}ms rows=${r.rowCount}\n${String(sql).replace(/\s+/g, ' ').slice(0, process.env.FULL ? 9000 : 300)}`);
    if (ms > 300 && process.env.EXPLAIN && !String(sql).startsWith('EXPLAIN')) {
      const e = await orig('EXPLAIN (ANALYZE, BUFFERS) ' + sql, params);
      console.log(e.rows.map((x: any) => x['QUERY PLAN']).join('\n'));
    }
    return r;
  };
  return db;
};
const t0 = Date.now();
if (mode === 'search') {
  const q = searchQuerySchema.parse(arg);
  const r: any = await withTenant(pool, ids.org, (db) => runSearch(wrap(db), ctx, q));
  console.log('items', r.items.length, 'truncated', r.truncated, 'searchedFrom', r.searchedFrom, Date.now() - t0, 'ms');
} else {
  ctx.tx = async (fn: any) => { const t = Date.now(); const r = await withTenant(pool, ids.org, (db) => fn(wrap(db))); console.log(`tx ${Date.now() - t}ms`); return r; };
  const origAi = deps.providers.ai.bind(deps.providers);
  (deps.providers as any).ai = (id: string) => { const p = origAi(id); return { ...p, answer: async (i: any, c: any) => { const t = Date.now(); const r = await p.answer(i, c); console.log(`answer(${id}) ${Date.now() - t}ms`); return r; } }; };
  let nq = 0; const origWrap = wrap;
  const r: any = await runAsk(ctx, arg);
  console.log('ctx', r.contextCount, r.insufficient, Date.now() - t0, 'ms', 'queries', (globalThis as any).__nq, 'sqlms', (globalThis as any).__ms, JSON.stringify(r.scope));
}
await pool.end();
process.exit(0);
