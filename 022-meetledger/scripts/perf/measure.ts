// Measures API latency against the synthetic perf database (scripts/perf/generate.mjs).
// Usage: PERF_DATABASE_URL=postgres://meetledger:meetledger@127.0.0.1:55432/ml_perf npx tsx scripts/perf/measure.ts [--runs 20]
// Runs in-process via fastify.inject (no network) with the real app, RLS and ACL. Not a sales guarantee.
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../../apps/server/src/config';
import { buildApp } from '../../apps/server/src/app';
import { createPool, withSystem } from '../../apps/server/src/db/pool';
import { hashPassword } from '../../apps/server/src/lib/crypto';

process.env.MEETLEDGER_FAST_HASH = '1';
const runs = Number(process.argv.find((a, i, arr) => arr[i - 1] === '--runs') ?? 20);
const url = process.env.PERF_DATABASE_URL!;
const pool = createPool(url, 10);
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, STORAGE_DIR: '/tmp/ml-perf-store', TMP_DIR: '/tmp/ml-perf-tmp', LOG_LEVEL: 'warn', WEB_DIST_DIR: '/nonexistent' });
const { app } = await buildApp({ config, pool, logger: false });
await app.ready();

const ids = await withSystem(pool, async (db) => {
  const ws = (await db.query("SELECT w.id, w.org_id FROM workspaces w WHERE w.name='Perf Workspace' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const user = (await db.query("SELECT u.id, u.email FROM users u JOIN workspace_members wm ON wm.user_id=u.id WHERE wm.workspace_id=$1 LIMIT 1", [ws.id])).rows[0];
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword('perf password 123')]);
  const series = (await db.query('SELECT series_id, count(*) n FROM meetings WHERE workspace_id=$1 AND series_id IS NOT NULL GROUP BY series_id ORDER BY n DESC LIMIT 1', [ws.id])).rows[0];
  const lastInSeries = (await db.query('SELECT id FROM meetings WHERE series_id=$1 ORDER BY scheduled_start DESC LIMIT 1', [series.series_id])).rows[0];
  const project = (await db.query('SELECT project_id, count(*) n FROM meetings WHERE workspace_id=$1 AND project_id IS NOT NULL GROUP BY project_id ORDER BY n DESC LIMIT 1', [ws.id])).rows[0];
  const person = (await db.query('SELECT person_id, count(*) n FROM participants p JOIN meetings m ON m.id=p.meeting_id WHERE m.workspace_id=$1 GROUP BY person_id ORDER BY n DESC LIMIT 1', [ws.id])).rows[0];
  const recent = (await db.query("SELECT id FROM meetings WHERE workspace_id=$1 AND visibility='workspace' ORDER BY scheduled_start DESC LIMIT 1", [ws.id])).rows[0];
  const counts = (await db.query(`SELECT (SELECT count(*) FROM meetings WHERE workspace_id=$1) meetings, (SELECT count(*) FROM transcript_segments) segments,
     (SELECT count(*) FROM decisions WHERE workspace_id=$1) decisions, (SELECT count(*) FROM actions WHERE workspace_id=$1) + (SELECT count(*) FROM commitments WHERE workspace_id=$1) actions_commitments`, [ws.id])).rows[0];
  return { ws: ws.id, email: user.email, seriesId: series.series_id, seriesMeetings: Number(series.n), lastInSeries: lastInSeries.id, projectId: project.project_id, projectMeetings: Number(project.n), personId: person.person_id, personMeetings: Number(person.n), recent: recent.id, counts };
});

const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ids.email, password: 'perf password 123' } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const csrf = me.json().csrfToken;
const W = `/api/w/${ids.ws}`;

const cases: { name: string; method: 'GET' | 'POST'; url: string; payload?: unknown }[] = [
  { name: 'search: 価格 (common, 2-char JA)', method: 'GET', url: `${W}/search?q=${encodeURIComponent('価格')}&limit=20` },
  { name: 'search: ProofFlow', method: 'GET', url: `${W}/search?q=ProofFlow&limit=20` },
  { name: 'search: 公開日 11月 (AND)', method: 'GET', url: `${W}/search?q=${encodeURIComponent('公開日 11月')}&limit=20` },
  { name: 'search: rare phrase 研修の日程', method: 'GET', url: `${W}/search?q=${encodeURIComponent('研修の日程')}&limit=20` },
  { name: 'search: 価格 + person filter', method: 'GET', url: `${W}/search?q=${encodeURIComponent('価格')}&personId=${ids.personId}&limit=20` },
  { name: 'search: 価格 + project filter', method: 'GET', url: `${W}/search?q=${encodeURIComponent('価格')}&projectId=${ids.projectId}&limit=20` },
  { name: 'ask: 価格について何を決めた？ (local)', method: 'POST', url: `${W}/ask`, payload: { question: '価格について何を決めた？' } },
  { name: `brief: last meeting of series (${ids.seriesMeetings} meetings)`, method: 'GET', url: `${W}/meetings/${ids.lastInSeries}/brief` },
  { name: `project memory (${ids.projectMeetings} meetings)`, method: 'GET', url: `${W}/projects/${ids.projectId}/memory` },
  { name: `series memory (${ids.seriesMeetings} meetings)`, method: 'GET', url: `${W}/series/${ids.seriesId}/memory` },
  { name: `person timeline (${ids.personMeetings} meetings)`, method: 'GET', url: `${W}/people/${ids.personId}/timeline` },
  { name: 'dashboard', method: 'GET', url: `${W}/dashboard` },
  { name: 'decisions current (first page)', method: 'GET', url: `${W}/decisions?view=current` },
  { name: 'actions assignee=me', method: 'GET', url: `${W}/actions?assignee=me` },
  { name: 'meetings list (50)', method: 'GET', url: `${W}/meetings?limit=50` },
  { name: 'meeting transcript (200 segments)', method: 'GET', url: `${W}/meetings/${ids.recent}/transcript` },
  { name: 'review inbox', method: 'GET', url: `${W}/review` },
];

const pct = (arr: number[], p: number) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const results: any[] = [];
for (const c of cases) {
  const times: number[] = [];
  let status = 0;
  let size = 0;
  for (let i = 0; i < runs + 2; i++) {
    const t = performance.now();
    const r = await app.inject({ method: c.method, url: c.url, payload: c.payload as any, headers: { cookie, 'x-csrf-token': csrf } });
    const dt = performance.now() - t;
    status = r.statusCode;
    size = r.body.length;
    if (i >= 2) times.push(dt); // first 2 runs = warm-up
  }
  const row = { case: c.name, status, p50_ms: Math.round(pct(times, 50)), p95_ms: Math.round(pct(times, 95)), max_ms: Math.round(Math.max(...times)), bytes: size };
  results.push(row);
  console.log(JSON.stringify(row));
}
mkdirSync('perf/out', { recursive: true });
const md = [
  `# Perf results (${new Date().toISOString()})`,
  '',
  `Data: ${JSON.stringify(ids.counts)} / runs per case: ${runs} (after 2 warm-up) / in-process fastify.inject, PostgreSQL 16 local (4 vCPU, fsync off test cluster)`,
  '',
  '| case | status | p50 ms | p95 ms | max ms | response bytes |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.case} | ${r.status} | ${r.p50_ms} | ${r.p95_ms} | ${r.max_ms} | ${r.bytes} |`),
].join('\n');
writeFileSync('perf/out/api-latency.md', md + '\n');
console.log(md);
await app.close();
await pool.end();
