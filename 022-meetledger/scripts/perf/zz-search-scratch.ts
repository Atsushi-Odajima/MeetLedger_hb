// Scratch copy of scripts/perf/measure.ts restricted to search-module cases.
import { loadConfig } from '../../apps/server/src/config';
import { buildApp } from '../../apps/server/src/app';
import { createPool, withSystem } from '../../apps/server/src/db/pool';
import { hashPassword } from '../../apps/server/src/lib/crypto';

process.env.MEETLEDGER_FAST_HASH = '1';
const runs = Number(process.argv.find((a, i, arr) => arr[i - 1] === '--runs') ?? 5);
const only = process.argv.find((a, i, arr) => arr[i - 1] === '--only');
const url = 'postgres://meetledger:meetledger@127.0.0.1:55432/ml_perf?options=-c%20statement_timeout%3D15000';
const pool = createPool(url, 10);
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, STORAGE_DIR: '/tmp/ml-perf-store', TMP_DIR: '/tmp/ml-perf-tmp', LOG_LEVEL: 'warn', WEB_DIST_DIR: '/nonexistent' });
const { app } = await buildApp({ config, pool, logger: false });
await app.ready();
const ids = await withSystem(pool, async (db) => {
  const ws = (await db.query("SELECT w.id FROM workspaces w WHERE w.name='Perf Workspace' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const user = (await db.query('SELECT u.id, u.email FROM users u JOIN workspace_members wm ON wm.user_id=u.id WHERE wm.workspace_id=$1 LIMIT 1', [ws.id])).rows[0];
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword('perf password 123')]);
  const project = (await db.query('SELECT project_id, count(*) n FROM meetings WHERE workspace_id=$1 AND project_id IS NOT NULL GROUP BY project_id ORDER BY n DESC LIMIT 1', [ws.id])).rows[0];
  const person = (await db.query('SELECT person_id, count(*) n FROM participants p JOIN meetings m ON m.id=p.meeting_id WHERE m.workspace_id=$1 GROUP BY person_id ORDER BY n DESC LIMIT 1', [ws.id])).rows[0];
  return { ws: ws.id, email: user.email, projectId: project.project_id, personId: person.person_id };
});
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ids.email, password: 'perf password 123' } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const csrf = me.json().csrfToken;
const W = `/api/w/${ids.ws}`;
const e = encodeURIComponent;
const cases: { name: string; method: 'GET' | 'POST'; url: string; payload?: unknown }[] = [
  { name: 'search 価格', method: 'GET', url: `${W}/search?q=${e('価格')}&limit=20` },
  { name: 'search ProofFlow', method: 'GET', url: `${W}/search?q=ProofFlow&limit=20` },
  { name: 'search 公開日 11月', method: 'GET', url: `${W}/search?q=${e('公開日 11月')}&limit=20` },
  { name: 'search 研修の日程', method: 'GET', url: `${W}/search?q=${e('研修の日程')}&limit=20` },
  { name: 'search 価格+person', method: 'GET', url: `${W}/search?q=${e('価格')}&personId=${ids.personId}&limit=20` },
  { name: 'search 価格+project', method: 'GET', url: `${W}/search?q=${e('価格')}&projectId=${ids.projectId}&limit=20` },
  { name: 'search rare Meeting 4242', method: 'GET', url: `${W}/search?q=${e('"Meeting 4242"')}&limit=20` },
  { name: 'search none 存在しない語句', method: 'GET', url: `${W}/search?q=${e('存在しない語句')}&limit=20` },
  { name: 'search browse person', method: 'GET', url: `${W}/search?personId=${ids.personId}&limit=20` },
  { name: 'search 価格 from/to 2020', method: 'GET', url: `${W}/search?q=${e('価格')}&from=2020-01-01&to=2020-12-31&limit=20` },
  { name: 'ask 価格について何を決めた？', method: 'POST', url: `${W}/ask`, payload: { question: '価格について何を決めた？' } },
  { name: 'ask 先月の未完了約束は？', method: 'POST', url: `${W}/ask`, payload: { question: '先月の未完了の約束は？' } },
];
const pct = (arr: number[], p: number) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
for (const c of cases) {
  if (only && !c.name.includes(only)) continue;
  const times: number[] = [];
  let status = 0;
  let body = '';
  for (let i = 0; i < runs + 1; i++) {
    const t = performance.now();
    const r = await app.inject({ method: c.method, url: c.url, payload: c.payload as any, headers: { cookie, 'x-csrf-token': csrf } });
    const dt = performance.now() - t;
    status = r.statusCode;
    body = r.body;
    if (i >= 1) times.push(dt);
  }
  let info = '';
  try {
    const j = JSON.parse(body);
    info = j.items ? `items=${j.items.length} truncated=${j.truncated ?? '-'}` : j.answer !== undefined ? `ctx=${j.contextCount} insufficient=${j.insufficient}` : body.slice(0, 200);
  } catch { info = body.slice(0, 200); }
  console.log(JSON.stringify({ case: c.name, status, p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), max: Math.round(Math.max(...times)), info }));
}
await app.close();
await pool.end();
