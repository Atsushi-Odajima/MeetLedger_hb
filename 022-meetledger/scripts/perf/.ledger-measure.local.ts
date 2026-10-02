// PRIVATE (ledger engineer) measurement script — not part of the product; deleted after use.
import { loadConfig } from '../../apps/server/src/config';
import { buildApp } from '../../apps/server/src/app';
import { createPool, withSystem } from '../../apps/server/src/db/pool';
import { hashPassword } from '../../apps/server/src/lib/crypto';
process.env.MEETLEDGER_FAST_HASH = '1';
const runs = Number(process.argv.find((a, i, arr) => arr[i - 1] === '--runs') ?? 5);
const only = process.argv.find((a, i, arr) => arr[i - 1] === '--only');
const url = process.env.PERF_DATABASE_URL!;
const pool = createPool(url, 10);
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, STORAGE_DIR: '/tmp/ml-perf-store', TMP_DIR: '/tmp/ml-perf-tmp', LOG_LEVEL: 'warn', WEB_DIST_DIR: '/nonexistent' });
const { app } = await buildApp({ config, pool, logger: false });
await app.ready();
const ids = await withSystem(pool, async (db) => {
  const ws = (await db.query("SELECT w.id FROM workspaces w WHERE w.name='Perf Workspace' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const user = (await db.query('SELECT u.id, u.email FROM users u JOIN workspace_members wm ON wm.user_id=u.id WHERE wm.workspace_id=$1 LIMIT 1', [ws.id])).rows[0];
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword('perf password 123')]);
  const project = (await db.query('SELECT project_id FROM meetings WHERE workspace_id=$1 AND project_id IS NOT NULL GROUP BY project_id ORDER BY count(*) DESC LIMIT 1', [ws.id])).rows[0];
  const cm = (await db.query("SELECT meeting_id FROM actions WHERE workspace_id=$1 AND status='candidate' ORDER BY created_at DESC LIMIT 1", [ws.id])).rows[0];
  return { ws: ws.id, email: user.email, projectId: project.project_id, candMeeting: cm.meeting_id };
});
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ids.email, password: 'perf password 123' } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const csrf = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().csrfToken;
const W = `/api/w/${ids.ws}`;
const cases = [
  ['review inbox', `${W}/review`],
  ['review inbox (meeting)', `${W}/review?meetingId=${ids.candMeeting}`],
  ['decisions current', `${W}/decisions?view=current`],
  ['decisions all', `${W}/decisions?view=all`],
  ['decisions candidates', `${W}/decisions?view=candidates`],
  ['decisions superseded', `${W}/decisions?view=superseded`],
  ['decisions current project', `${W}/decisions?view=current&projectId=${ids.projectId}`],
  ['actions assignee=me', `${W}/actions?assignee=me`],
  ['actions assignee=me open', `${W}/actions?assignee=me&status=open`],
  ['actions overdue', `${W}/actions?overdue=1`],
  ['actions all', `${W}/actions`],
  ['commitments mine', `${W}/commitments?direction=mine`],
  ['commitments theirs open', `${W}/commitments?direction=theirs&status=open`],
  ['questions open', `${W}/questions?status=open`],
  ['contradictions', `${W}/contradictions`],
  ['meeting ledger', `${W}/meetings/${ids.candMeeting}/ledger`],
].filter(([n]) => !only || n.includes(only));
const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
for (const [name, u] of cases) {
  const times: number[] = [];
  let status = 0, size = 0, next: string | null = null, total: unknown = null;
  for (let i = 0; i < runs + 1; i++) {
    const t = performance.now();
    const r = await app.inject({ method: 'GET', url: u, headers: { cookie, 'x-csrf-token': csrf } });
    const dt = performance.now() - t;
    status = r.statusCode; size = r.body.length;
    try { const j = r.json(); next = j.nextCursor ?? null; total = j.total ?? j.counts ?? null; } catch {}
    if (i >= 1) times.push(dt);
  }
  console.log(JSON.stringify({ case: name, status, p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), bytes: size, next: !!next, total }));
}
await app.close();
await pool.end();
