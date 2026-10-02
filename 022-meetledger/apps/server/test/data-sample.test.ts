import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { sys, type Owner } from './data-helpers';
import { runCli } from '../src/cli/main';

let env: TestEnv;
let owner: Owner;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await env.setupOwner('owner@example.com');
});
afterAll(async () => env?.close());

describe('data: sample workspace', () => {
  it('creates a separate fictional sample organization (idempotent per user)', async () => {
    const prodMeeting = await owner.client.post(`/api/w/${owner.workspaceId}/meetings`, { title: '本番の定例' });
    expect(prodMeeting.status).toBe(200);

    const r = await owner.client.post('/api/sample-workspace');
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.orgId).not.toBe(owner.orgId);
    const again = await owner.client.post('/api/sample-workspace');
    expect(again.body).toEqual({ orgId: r.body.orgId, workspaceId: r.body.workspaceId, created: false });
    const orgs = await sys(env, (db) => db.query('SELECT count(*)::int n FROM organizations WHERE is_sample'));
    expect(orgs.rows[0].n).toBe(1);

    const me = await owner.client.get('/api/me');
    const sampleWs = me.body.workspaces.find((w: any) => w.id === r.body.workspaceId);
    expect(sampleWs).toMatchObject({ isSample: true, role: 'owner' });
    expect(me.body.orgs.find((o: any) => o.id === r.body.orgId).isSample).toBe(true);
    expect(me.body.workspaces.find((w: any) => w.id === owner.workspaceId).isSample).toBe(false);
    const wsInfo = await owner.client.get(`/api/w/${r.body.workspaceId}`);
    expect(wsInfo.body.isSample).toBe(true);
  });

  it('sample data: projects, people, recurring series, private 1on1, ledger items and review candidates', async () => {
    const ws = (await owner.client.post('/api/sample-workspace')).body.workspaceId;
    const W = `/api/w/${ws}`;
    const projects = (await owner.client.get(`${W}/projects`)).body.items.map((p: any) => p.name).sort();
    expect(projects).toEqual(['Client Alpha', 'Sample SaaS Launch']);
    const people = (await owner.client.get(`${W}/people`)).body.items;
    expect(people.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Sample CEO', 'Sample PM']));
    expect(people.filter((p: any) => p.email).every((p: any) => p.email.endsWith('@example.com'))).toBe(true);

    const meetings = (await owner.client.get(`${W}/meetings?limit=50`)).body.items;
    const titles = meetings.map((m: any) => m.title).sort();
    expect(titles).toEqual(['1on1', 'Client Review', 'Weekly Product', 'Weekly Product']);
    expect(meetings.every((m: any) => m.source === 'sample')).toBe(true);
    expect(meetings.find((m: any) => m.title === '1on1').visibility).toBe('private');
    const weekly = meetings.filter((m: any) => m.title === 'Weekly Product').sort((a: any, b: any) => a.scheduledStart.localeCompare(b.scheduledStart));
    expect(weekly[0].seriesId).toBe(weekly[1].seriesId);
    expect(new Date(weekly[1].scheduledStart).getTime()).toBeGreaterThan(env.clock.now().getTime());
    expect(weekly[1].status).toBe('scheduled');
    expect(new Date(weekly[0].scheduledStart).getTime()).toBeLessThan(env.clock.now().getTime());

    const data = await env.tenantTx((await owner.client.get(`${W}`)).body.orgId, async (db) => {
      const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
      return {
        price: await q(`SELECT review_state, status, supersedes_decision_id FROM decisions WHERE workspace_id=$1 AND topic='価格変更'`, [ws]),
        commitment: await q(`SELECT status, promised_by_user_id FROM commitments WHERE workspace_id=$1 AND description LIKE '%資料送付%'`, [ws]),
        question: await q(`SELECT status FROM open_questions WHERE workspace_id=$1 AND question LIKE '%公開日%'`, [ws]),
        unfinished: await q(`SELECT a.status, a.meeting_id FROM actions a WHERE a.workspace_id=$1 AND a.status IN ('confirmed','in_progress')`, [ws]),
        candidates: await q(`SELECT 'action' t FROM actions WHERE workspace_id=$1 AND status='candidate' UNION ALL SELECT 'decision' FROM decisions WHERE workspace_id=$1 AND review_state='candidate'`, [ws]),
        transcripts: await q(`SELECT count(*)::int n FROM transcript_segments s JOIN meetings m ON m.id=s.meeting_id WHERE m.workspace_id=$1`, [ws]),
        agenda: await q(`SELECT a.source_type FROM agenda_items a WHERE a.meeting_id=$1`, [weekly[1].id]),
      };
    });
    expect(data.price).toEqual([{ review_state: 'confirmed', status: 'active', supersedes_decision_id: expect.any(String) }]);
    expect(data.commitment).toEqual([{ status: 'open', promised_by_user_id: owner.userId }]);
    expect(data.question).toEqual([{ status: 'open' }]);
    expect(data.unfinished.map((a: any) => a.meeting_id)).toContain(weekly[0].id);
    expect(data.candidates.length).toBeGreaterThanOrEqual(2);
    expect(data.transcripts[0].n).toBeGreaterThan(10);
    expect(data.agenda).toEqual([{ source_type: 'action' }]);

    // the commitment is "mine" in the commitments export
    const com = await owner.client.get(`${W}/commitments/export`);
    expect(com.raw).toContain('mine');
    // Optional cross-module check: the followup brief of the next occurrence (only if that route is available).
    const brief = await owner.client.get(`${W}/meetings/${weekly[1].id}/brief`);
    if (brief.status === 200) expect(JSON.stringify(brief.body)).toContain('オンボーディング画面の文言を修正する');
  });

  it('sample workspace is separated from production (meetings, search, other members)', async () => {
    const sample = (await owner.client.post('/api/sample-workspace')).body;
    const prodList = await owner.client.get(`/api/w/${owner.workspaceId}/meetings?limit=200`);
    const prodTitles = prodList.body.items.map((m: any) => m.title);
    expect(prodTitles).toContain('本番の定例');
    for (const t of ['Weekly Product', 'Client Review', '1on1']) expect(prodTitles).not.toContain(t);
    expect(prodList.body.items.every((m: any) => m.source !== 'sample')).toBe(true);
    // tenant isolation at the DB level (RLS): production org sees no sample rows at all
    const leaked = await env.tenantTx(owner.orgId, (db) =>
      db.query(`SELECT (SELECT count(*)::int FROM meetings WHERE source='sample') AS m, (SELECT count(*)::int FROM people WHERE name LIKE 'Sample %') AS p, (SELECT count(*)::int FROM search_docs WHERE workspace_id=$1) AS s`, [
        sample.workspaceId,
      ]),
    );
    expect(leaked.rows[0]).toEqual({ m: 0, p: 0, s: 0 });
    await env.worker.drain(); // let the search module index the sample workspace (if registered)
    const search = await owner.client.get(`/api/w/${owner.workspaceId}/search?q=${encodeURIComponent('価格変更')}`);
    expect([200, 404]).toContain(search.status);
    if (search.status === 200) expect(JSON.stringify(search.body)).not.toContain(sample.workspaceId);
    const sampleIds = (await sys(env, (db) => db.query('SELECT id FROM meetings WHERE workspace_id=$1', [sample.workspaceId]))).rows.map((r) => r.id);
    if (search.status === 200) for (const id of sampleIds) expect(JSON.stringify(search.body)).not.toContain(id);
    // positive control: the same query inside the sample workspace does find the sample data
    const own = await owner.client.get(`/api/w/${sample.workspaceId}/search?q=${encodeURIComponent('価格変更')}`);
    if (own.status === 200) expect(own.body.items.length).toBeGreaterThan(0);

    // a production member cannot reach the owner's sample workspace; they get their own one
    const bob = await env.addUser(owner.client, owner.orgId, owner.workspaceId, 'bob@example.com', 'member');
    expect((await bob.client.get(`/api/w/${sample.workspaceId}/meetings`)).status).toBe(404);
    const bobs = await bob.client.post('/api/sample-workspace');
    expect(bobs.body.created).toBe(true);
    expect(bobs.body.orgId).not.toBe(sample.orgId);
    // sample org membership is only the sample user
    const members = await sys(env, (db) => db.query('SELECT user_id FROM org_members WHERE org_id=$1', [sample.orgId]));
    expect(members.rows.map((r) => r.user_id)).toEqual([owner.userId]);
  });

  it('seed-sample CLI creates the sample workspace for an existing user', async () => {
    await env.createTenant('cli-user@example.com');
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    const e = { NODE_ENV: 'test', DATABASE_URL: env.config.DATABASE_URL, MASTER_KEY: env.config.MASTER_KEY, STORAGE_DIR: env.config.STORAGE_DIR };
    expect(await runCli(['seed-sample', '--email', 'cli-user@example.com'], e, io)).toBe(0);
    expect(out.join('\n')).toMatch(/^created: sample organization/);
    expect(await runCli(['seed-sample', '--email', 'cli-user@example.com'], e, io)).toBe(0);
    expect(out.join('\n')).toContain('already exists');
    expect(await runCli(['seed-sample', '--email', 'nobody@example.com'], e, io)).toBe(1);
  });
});
