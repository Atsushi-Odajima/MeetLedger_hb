import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, insertTranscript, type TestEnv } from './helpers';
import { insertIndexRows, seedRichWorkspace, sys, type Owner, type RichWorkspace } from './data-helpers';
import { mediaKey } from '../src/storage/types';
import { runRetentionSweep } from '../src/modules/data/retention';

let env: TestEnv;
let owner: Owner;
let seed: RichWorkspace;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await env.setupOwner('owner@example.com');
  seed = await seedRichWorkspace(env, owner);
});
afterAll(async () => env?.close());

const count = async (sql: string, params: unknown[]) => (await sys(env, (db) => db.query(sql, params))).rows[0].n as number;

describe('data: meeting deletion', () => {
  it('#18 削除したMeetingはai_chunks/search_docs/storage/通知/キャッシュから消える', async () => {
    const ws = owner.workspaceId;
    // index rows the way the search module writes them (+ a decision row without meeting_id, + another meeting kept)
    await insertIndexRows(env, owner.orgId, ws, [
      ...seed.t1.segmentIds.map((id) => ({ meetingId: seed.m1, entityType: 'segment', entityId: id, text: '価格 キックオフ' })),
      { meetingId: null, entityType: 'decision', entityId: seed.d1, text: '価格は月額5,980円' },
      { meetingId: seed.m1, entityType: 'meeting', entityId: seed.m1, text: 'Kickoff 会議' },
      { meetingId: seed.m2, entityType: 'segment', entityId: seed.t2.segmentIds[0], text: '価格変更' },
    ]);
    await env.tenantTx(owner.orgId, async (db) => {
      await db.query(
        `INSERT INTO notifications(org_id, workspace_id, user_id, kind, entity_type, entity_id, dedupe_key, title, link) VALUES ($1,$2,$3,'needs_review','meeting',$4,'nr-1','確認待ち',$5)`,
        [owner.orgId, ws, owner.userId, seed.m1, `/w/${ws}/meetings/${seed.m1}`],
      );
      await db.query(`INSERT INTO brief_snapshots(org_id, meeting_id, user_id, content) VALUES ($1,$2,$3,$4)`, [
        owner.orgId,
        seed.m2,
        owner.userId,
        { previous: [{ meetingId: seed.m1, actionId: null }] },
      ]);
    });
    expect(await env.deps.storage.exists(seed.mediaKey)).toBe(true);
    const ids = [...seed.t1.segmentIds, seed.d1, seed.m1];
    expect(await count('SELECT count(*)::int n FROM search_docs WHERE entity_id = ANY($1)', [ids])).toBe(5);
    expect(await count('SELECT count(*)::int n FROM ai_chunks WHERE entity_id = ANY($1)', [ids])).toBe(5);

    const r = await owner.client.del(`/api/w/${ws}/meetings/${seed.m1}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('completed');
    expect(Object.keys(r.body.steps).sort()).toEqual(['ai_index', 'backups', 'caches', 'db', 'search_index', 'storage']);
    expect(r.body.steps.backups).toBe('retained until backup rotation (see docs)');

    expect(await count('SELECT count(*)::int n FROM search_docs WHERE entity_id = ANY($1) OR meeting_id=$2', [ids, seed.m1])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM ai_chunks WHERE entity_id = ANY($1) OR meeting_id=$2', [ids, seed.m1])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM meetings WHERE id=$1', [seed.m1])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM transcript_segments WHERE meeting_id=$1', [seed.m1])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM decisions WHERE meeting_id=$1', [seed.m1])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM notifications WHERE entity_id=$1', [seed.m1])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM brief_snapshots WHERE meeting_id=$1', [seed.m2])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM ledger_events WHERE entity_id=$1`, [seed.d1])).toBe(0);
    expect(await env.deps.storage.exists(seed.mediaKey)).toBe(false);
    // other meeting untouched (its superseding decision survives, link to the deleted one is cleared)
    expect(await count('SELECT count(*)::int n FROM search_docs WHERE entity_id=$1', [seed.t2.segmentIds[0]])).toBe(1);
    expect(await count('SELECT count(*)::int n FROM decisions WHERE id=$1 AND supersedes_decision_id IS NULL', [seed.d2])).toBe(1);

    const dr = await sys(env, (db) => db.query('SELECT * FROM deletion_requests WHERE target_id=$1', [seed.m1]));
    expect(dr.rows[0].scope).toBe('meeting');
    expect(dr.rows[0].status).toBe('completed');
    expect(dr.rows[0].target_label).not.toContain('Kickoff'); // no content in the deletion log
    expect((await owner.client.get(`/api/w/${ws}/meetings/${seed.m1}`)).status).toBe(404);
    const list = await owner.client.get(`/api/w/${ws}/deletion-requests`);
    expect(list.body.items.some((i: any) => i.targetId === seed.m1 && i.scope === 'meeting' && i.steps.backups)).toBe(true);
  });

  it('only the creator or an admin can delete; private meetings of others stay 404', async () => {
    const ws = owner.workspaceId;
    const bob = await env.addUser(owner.client, owner.orgId, ws, 'bob@example.com', 'member');
    const vic = await env.addUser(owner.client, owner.orgId, ws, 'vic@example.com', 'viewer');
    const m = await owner.client.post(`/api/w/${ws}/meetings`, { title: 'Owner meeting', visibility: 'workspace' });
    expect((await bob.client.del(`/api/w/${ws}/meetings/${m.body.id}`)).status).toBe(403);
    expect((await vic.client.del(`/api/w/${ws}/meetings/${m.body.id}`)).status).toBe(403);
    expect((await bob.client.post(`/api/w/${ws}/meetings/${m.body.id}/delete-transcript`)).status).toBe(403);
    const priv = await bob.client.post(`/api/w/${ws}/meetings`, { title: 'Bob private', visibility: 'private' });
    expect((await owner.client.del(`/api/w/${ws}/meetings/${priv.body.id}`)).status).toBe(404);
    const bobs = await bob.client.post(`/api/w/${ws}/meetings`, { title: 'Bob shared', visibility: 'workspace' });
    expect((await owner.client.del(`/api/w/${ws}/meetings/${bobs.body.id}`)).status).toBe(200); // admin
    expect((await bob.client.del(`/api/w/${ws}/meetings/${priv.body.id}`)).status).toBe(200); // creator
    // members see only their own deletion requests
    const own = await bob.client.get(`/api/w/${ws}/deletion-requests`);
    expect(own.body.items.every((i: any) => i.requestedBy?.id === bob.userId)).toBe(true);
  });

  it('partial deletes: audio / transcript (ledger keeps text, sources missing) / AI index', async () => {
    const ws = owner.workspaceId;
    const m = await owner.client.post(`/api/w/${ws}/meetings`, { title: 'Partial', visibility: 'workspace' });
    const id = m.body.id;
    const t = await insertTranscript(env, owner.orgId, id, [
      { speaker: 'S1', text: '決定: ベータを来月公開する', startMs: 0, endMs: 3000 },
      { speaker: 'S2', text: '了解です', startMs: 3000, endMs: 5000 },
    ]);
    const { audioKey, fileKey, decisionId } = await env.tenantTx(owner.orgId, async (db) => {
      const audioKey = mediaKey(owner.orgId, id, 'original_audio', 'a1');
      const fileKey = mediaKey(owner.orgId, id, 'transcript_file', 'f1');
      await env.deps.storage.putBuffer(audioKey, Buffer.from('audio'));
      await env.deps.storage.putBuffer(fileKey, Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nhi\n'));
      await db.query(`INSERT INTO media_assets(org_id, meeting_id, kind, storage_key, mime, sha256) VALUES ($1,$2,'original_audio',$3,'audio/wav','x'),($1,$2,'transcript_file',$4,'application/x-subrip','y')`, [
        owner.orgId,
        id,
        audioKey,
        fileKey,
      ]);
      const d = await db.query(
        `INSERT INTO decisions(org_id, workspace_id, meeting_id, text, review_state, source_segment_ids, source_quote, source_transcript_id, source_start_ms)
         VALUES ($1,$2,$3,'ベータを来月公開する','confirmed',$4,'決定: ベータを来月公開する',$5,0) RETURNING id`,
        [owner.orgId, ws, id, [t.segmentIds[0]], t.transcriptId],
      );
      return { audioKey, fileKey, decisionId: d.rows[0].id as string };
    });
    await insertIndexRows(env, owner.orgId, ws, [
      { meetingId: id, entityType: 'segment', entityId: t.segmentIds[0], text: 'ベータ' },
      { meetingId: id, entityType: 'decision', entityId: decisionId, text: 'ベータを来月公開する' },
    ]);

    const a = await owner.client.post(`/api/w/${ws}/meetings/${id}/delete-audio`);
    expect(a.status).toBe(200);
    expect(a.body.scope).toBe('meeting_audio');
    expect(await env.deps.storage.exists(audioKey)).toBe(false);
    expect(await env.deps.storage.exists(fileKey)).toBe(true);
    expect(await count(`SELECT count(*)::int n FROM media_assets WHERE meeting_id=$1 AND kind='original_audio' AND deleted_at IS NOT NULL`, [id])).toBe(1);

    const tr = await owner.client.post(`/api/w/${ws}/meetings/${id}/delete-transcript`);
    expect(tr.status).toBe(200);
    expect(await count('SELECT count(*)::int n FROM transcripts WHERE meeting_id=$1', [id])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM transcript_segments WHERE meeting_id=$1', [id])).toBe(0);
    expect(await env.deps.storage.exists(fileKey)).toBe(false);
    expect(await count(`SELECT count(*)::int n FROM search_docs WHERE entity_type='segment' AND meeting_id=$1`, [id])).toBe(0);
    const d = await sys(env, (db) => db.query('SELECT text, source_quote, source_segment_ids FROM decisions WHERE id=$1', [decisionId]));
    expect(d.rows[0].text).toBe('ベータを来月公開する');
    expect(d.rows[0].source_quote).toBeNull();
    const md = await owner.client.get(`/api/w/${ws}/meetings/${id}/export?format=md`);
    expect(md.raw).toContain('ベータを来月公開する');
    expect(md.raw).toContain('missing');
    expect(md.raw).toContain('（文字起こしはありません）');

    const ai = await owner.client.post(`/api/w/${ws}/meetings/${id}/delete-ai-index`, { disableAi: true });
    expect(ai.status).toBe(200);
    expect(ai.body.steps.ai_index.rows).toBe(1);
    expect(await count('SELECT count(*)::int n FROM ai_chunks WHERE meeting_id=$1 OR entity_id=$2', [id, decisionId])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM search_docs WHERE entity_id=$1', [decisionId])).toBe(1); // FTS kept
    expect(await count('SELECT count(*)::int n FROM meetings WHERE id=$1 AND ai_enabled=false', [id])).toBe(1);
    const scopes = (await sys(env, (db) => db.query('SELECT scope FROM deletion_requests WHERE target_id=$1 ORDER BY created_at', [id]))).rows.map((r) => r.scope);
    expect(scopes.sort()).toEqual(['meeting_ai_index', 'meeting_audio', 'meeting_transcript']);
  });
});

describe('data: retention sweep', () => {
  it('#22 retention: audio / transcript / AI index / artifacts are deleted by their own retention (FakeClock)', async () => {
    const t0 = new Date('2026-10-01T01:00:00Z');
    env.clock.set(t0);
    const ws = owner.workspaceId;
    const set = await owner.client.patch(`/api/w/${ws}/settings`, { retention: { transcriptDays: 30, aiIndexDays: 10, artifactDays: 20 } });
    expect(set.status).toBe(200);
    const mOld = (await owner.client.post(`/api/w/${ws}/meetings`, { title: 'Old meeting' })).body.id;
    const mNew = (await owner.client.post(`/api/w/${ws}/meetings`, { title: 'New meeting' })).body.id;
    const tOld = await insertTranscript(env, owner.orgId, mOld, [{ speaker: 'S1', text: '古い文字起こし', startMs: 0, endMs: 1000 }]);
    const tNew = await insertTranscript(env, owner.orgId, mNew, [{ speaker: 'S1', text: '新しい文字起こし', startMs: 0, endMs: 1000 }]);
    const k = {
      audioDue: mediaKey(owner.orgId, mOld, 'original_audio', 'due'),
      audioLater: mediaKey(owner.orgId, mNew, 'original_audio', 'later'),
      exportOld: `org/${owner.orgId}/exports/old.json`,
    };
    for (const key of Object.values(k)) await env.deps.storage.putBuffer(key, Buffer.from('x'));
    const ids = await env.tenantTx(owner.orgId, async (db) => {
      await db.query(`UPDATE transcripts SET created_at='2026-08-01T00:00:00Z' WHERE id=$1`, [tOld.transcriptId]);
      await db.query(`UPDATE transcripts SET created_at='2026-09-25T00:00:00Z' WHERE id=$1`, [tNew.transcriptId]);
      await db.query(
        `INSERT INTO media_assets(org_id, meeting_id, kind, storage_key, mime, sha256, retention_until) VALUES
           ($1,$2,'original_audio',$3,'audio/wav','a','2026-09-30T00:00:00Z'), ($1,$4,'original_audio',$5,'audio/wav','b','2026-12-01T00:00:00Z')`,
        [owner.orgId, mOld, k.audioDue, mNew, k.audioLater],
      );
      const dec = await db.query(
        `INSERT INTO decisions(org_id, workspace_id, meeting_id, text, review_state, source_segment_ids, source_quote, source_transcript_id) VALUES ($1,$2,$3,'古い決定','confirmed',$4,'古い文字起こし',$5) RETURNING id`,
        [owner.orgId, ws, mOld, [tOld.segmentIds[0]], tOld.transcriptId],
      );
      const s1 = await db.query(`INSERT INTO summaries(org_id, meeting_id, version, provider, sections, created_at) VALUES ($1,$2,1,'local-rules','{}','2026-09-01T00:00:00Z') RETURNING id`, [owner.orgId, mOld]);
      const s2 = await db.query(`INSERT INTO summaries(org_id, meeting_id, version, provider, sections, created_at) VALUES ($1,$2,1,'local-rules','{}','2026-09-28T00:00:00Z') RETURNING id`, [owner.orgId, mNew]);
      await db.query(`INSERT INTO followup_drafts(org_id, meeting_id, kind, body, created_at, updated_at) VALUES ($1,$2,'internal_recap','old','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`, [owner.orgId, mOld]);
      await db.query(`INSERT INTO brief_snapshots(org_id, meeting_id, user_id, content, generated_at) VALUES ($1,$2,$3,'{}','2026-09-01T00:00:00Z')`, [owner.orgId, mOld, owner.userId]);
      await db.query(
        `INSERT INTO jobs(org_id, type, idempotency_key, payload, status, result, finished_at) VALUES ($1,'export.full','test-export-old',$2,'succeeded',$3,'2026-09-01T00:00:00Z')`,
        [owner.orgId, { workspaceId: ws, userId: owner.userId }, { storageKey: k.exportOld, size: 1 }],
      );
      return { decisionId: dec.rows[0].id as string, sOld: s1.rows[0].id as string, sNew: s2.rows[0].id as string };
    });
    // let the search module process pending index jobs first, so it does not rewrite the fixture index rows below
    await env.worker.drain();
    await insertIndexRows(env, owner.orgId, ws, [
      { meetingId: mOld, entityType: 'segment', entityId: tOld.segmentIds[0], text: '古い', createdAt: '2026-08-01T00:00:00Z' },
      { meetingId: mNew, entityType: 'segment', entityId: tNew.segmentIds[0], text: '新しい', createdAt: '2026-09-28T00:00:00Z' },
      { meetingId: mNew, entityType: 'meeting', entityId: mNew, text: '古いAI索引', createdAt: '2026-09-10T00:00:00Z' },
    ]);
    await sys(env, async (db) => {
      await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at) VALUES ($1,'expired-hash','c','2026-09-01T00:00:00Z')`, [owner.userId]);
      await db.query(`INSERT INTO invitations(org_id, workspace_id, email, role, token_hash, expires_at) VALUES ($1,$2,'late@example.com','member','inv-expired','2026-09-01T00:00:00Z')`, [owner.orgId, ws]);
      await db.query(`INSERT INTO mcp_confirmations(org_id, user_id, tool, args_hash, preview, expires_at) VALUES ($1,$2,'create_action','h','{}','2026-09-01T00:00:00Z')`, [owner.orgId, owner.userId]);
    });

    // run as the scheduled system job (org-less)
    const job = await sys(env, (db) => env.deps.jobs.enqueue(db, { orgId: null, type: 'retention.sweep', key: 'retention.sweep:test-1', payload: {} }));
    const row = (await sys(env, (db) => db.query('SELECT * FROM jobs WHERE id=$1', [job.id]))).rows[0];
    await env.worker.runJob(row); // only this job (registered handler), not the re-index jobs it enqueues
    const jr = (await sys(env, (db) => db.query('SELECT status, result FROM jobs WHERE id=$1', [job.id]))).rows[0];
    expect(jr.status).toBe('succeeded');
    expect(jr.result.audioObjects).toBe(1);

    // audio by retention_until
    expect(await env.deps.storage.exists(k.audioDue)).toBe(false);
    expect(await env.deps.storage.exists(k.audioLater)).toBe(true);
    expect(await count(`SELECT count(*)::int n FROM media_assets WHERE storage_key=$1 AND deleted_at IS NOT NULL`, [k.audioDue])).toBe(1);
    // transcripts older than transcriptDays (30d) — ledger item survives without its quote
    expect(await count('SELECT count(*)::int n FROM transcripts WHERE id=$1', [tOld.transcriptId])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM transcript_segments WHERE id=$1', [tOld.segmentIds[0]])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM transcripts WHERE id=$1', [tNew.transcriptId])).toBe(1);
    expect(await count('SELECT count(*)::int n FROM decisions WHERE id=$1 AND text=$2 AND source_quote IS NULL', [ids.decisionId, '古い決定'])).toBe(1);
    // AI index older than aiIndexDays (10d): 2026-08-01 and 2026-09-10 rows gone, 2026-09-28 kept
    expect(await count('SELECT count(*)::int n FROM ai_chunks WHERE workspace_id=$1 AND entity_id = ANY($2)', [ws, [tOld.segmentIds[0], mNew]])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM ai_chunks WHERE entity_id=$1', [tNew.segmentIds[0]])).toBe(1);
    // artifacts older than artifactDays (20d)
    expect(await count('SELECT count(*)::int n FROM summaries WHERE id=$1', [ids.sOld])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM summaries WHERE id=$1', [ids.sNew])).toBe(1);
    expect(await count('SELECT count(*)::int n FROM followup_drafts WHERE meeting_id=$1', [mOld])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM brief_snapshots WHERE meeting_id=$1', [mOld])).toBe(0);
    expect(await env.deps.storage.exists(k.exportOld)).toBe(false);
    expect(await count(`SELECT count(*)::int n FROM jobs WHERE idempotency_key='test-export-old' AND (result->>'expired')::boolean`, [])).toBe(1);
    // expired sessions / invitations / MCP confirmations
    expect(await count(`SELECT count(*)::int n FROM sessions WHERE token_hash='expired-hash'`, [])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM invitations WHERE token_hash='inv-expired'`, [])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM mcp_confirmations WHERE args_hash='h'`, [])).toBe(0);
    // deletion log (system-triggered, requested_by NULL)
    const logs = (await sys(env, (db) => db.query(`SELECT scope, requested_by, steps FROM deletion_requests WHERE workspace_id=$1 AND target_id = ANY($2)`, [ws, [mOld, mNew]]))).rows;
    expect(logs.map((l) => l.scope).sort()).toEqual(expect.arrayContaining(['meeting_ai_index', 'meeting_audio', 'meeting_transcript']));
    expect(logs.every((l) => l.requested_by === null && l.steps.trigger === 'retention' && l.steps.backups)).toBe(true);

    // FakeClock: nothing else is due now; after the clock passes retention_until the second audio goes too
    const again = await runRetentionSweep(env.deps);
    expect(again.audioObjects).toBe(0);
    expect(again.transcripts).toBe(0);
    env.clock.set('2026-12-02T00:00:00Z');
    const later = await runRetentionSweep(env.deps, { orgIds: [owner.orgId] });
    expect(later.audioObjects).toBe(1);
    expect(await env.deps.storage.exists(k.audioLater)).toBe(false);
    expect(later.transcripts).toBeGreaterThanOrEqual(1); // tNew is now older than 30 days
    env.clock.set(t0);
  });
});
