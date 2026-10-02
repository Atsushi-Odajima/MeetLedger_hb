import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { INJECTION_TEXTS, seedRichWorkspace, streamToBuffer, sys, type Owner, type RichWorkspace } from './data-helpers';
import { parseCsv } from '../src/modules/data/csv';
import { parseSrt, parseVtt } from '../src/modules/data/subtitles';
import type { Db } from '../src/db/pool';

let env: TestEnv;
let owner: Owner;
let seed: RichWorkspace;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await env.setupOwner('owner@example.com');
  seed = await seedRichWorkspace(env, owner);
});
afterAll(async () => env?.close());

const W = () => `/api/w/${owner.workspaceId}`;
const csvObjects = (raw: string) => {
  const [head, ...data] = parseCsv(raw);
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

describe('data: exports', () => {
  it('#23 Meeting export md/html/txt/json carry title/date/participants/version/generatedAt and AI labels', async () => {
    const md = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(md.headers['cache-control']).toBe('no-store');
    const now = env.clock.now().toISOString();
    for (const s of ['# Review <b>会議</b>', '| 日時 | 2026-09-27 10:00', 'Alice Client, Bob PM', '| 文字起こし版 | v1（fixture / ローカル処理）', `| 生成日時 | ${now} |`, '〔AI生成〕', '価格を4,980円に変更した。'])
      expect(md.raw).toContain(s);
    expect(md.raw).toContain('=価格を月額4,980円に変更');
    expect(md.raw).toContain('〔候補（未確認）〕 決定: 候補の決定');
    expect(md.raw).toContain('**[00:01] Speaker 1:** 価格を月額4,980円に変更します。');

    const html = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=html`);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-disposition']).toMatch(/^inline/);
    expect(html.raw).toContain('@media print');
    expect(html.raw).toContain('PDFとして保存');
    expect(html.raw).toContain('<span class="badge">AI生成</span>');
    expect(html.raw).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.raw).not.toContain('<script>');
    expect(html.raw).toContain('<title>Review &lt;b&gt;会議&lt;/b&gt;</title>');
    const dl = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=html&download=1`);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);

    const txt = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=txt`);
    expect(txt.raw).toContain('タイトル: Review <b>会議</b>');
    expect(txt.raw).toContain(`生成日時: ${now}`);
    expect(txt.raw).toContain('[00:09] Speaker 1: 比較表を作ります。');

    const json = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=json`);
    expect(json.body.format).toBe('meetledger.meeting-export/v1');
    expect(json.body.generatedAt).toBe(now);
    expect(json.body.transcript.version).toBe(1);
    expect(json.body.summary.aiGenerated).toBe(true);
    expect(json.body.participants.map((p: any) => p.displayName)).toEqual(['Alice Client', 'Bob PM']);
    expect(json.body.decisions.find((d: any) => d.id === seed.d2).supersedesDecisionId).toBe(seed.d1);
  });

  it('#23 SRT / VTT exports re-parse to the same segments', async () => {
    const segs = (await sys(env, (db) => db.query('SELECT start_ms, end_ms, text FROM transcript_segments WHERE transcript_id=$1 ORDER BY seq', [seed.t2.transcriptId]))).rows;
    const srt = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=srt`);
    expect(srt.status).toBe(200);
    expect(srt.raw).toContain('00:00:09,300 --> 01:02:05,000');
    const sc = parseSrt(srt.raw);
    expect(sc.map((c) => [c.startMs, c.endMs, c.text])).toEqual(segs.map((s) => [s.start_ms, s.end_ms, s.text]));
    expect(sc[1].speaker).toBe('Bob PM');

    const vtt = await owner.client.get(`${W()}/meetings/${seed.m2}/export?format=vtt`);
    expect(vtt.raw.startsWith('WEBVTT')).toBe(true);
    expect(vtt.raw).toContain('NOTE');
    expect(vtt.raw).toContain('タイトル: Review <b>会議</b>');
    expect(vtt.raw).toContain('<v Bob PM>&lt;script&gt;');
    const vc = parseVtt(vtt.raw);
    expect(vc.map((c) => [c.startMs, c.endMs, c.text])).toEqual(segs.map((s) => [s.start_ms, s.end_ms, s.text]));
    expect(vc.map((c) => c.speaker)).toEqual(['Speaker 1', 'Bob PM', 'Speaker 1']);

    const none = await owner.client.post(`${W()}/meetings`, { title: 'No transcript' });
    expect((await owner.client.get(`${W()}/meetings/${none.body.id}/export?format=srt`)).status).toBe(404);
  });

  it('#23 Decisions CSV/JSON (supersede chain), Actions/Commitments CSV neutralize formula injection', async () => {
    const dec = await owner.client.get(`${W()}/decisions/export?format=csv`);
    expect(dec.status).toBe(200);
    expect(dec.headers['content-type']).toContain('text/csv');
    expect(dec.raw.startsWith('﻿')).toBe(true);
    const ds = csvObjects(dec.raw);
    expect(ds.map((d) => d.id).sort()).toEqual([seed.d1, seed.d2].sort()); // candidates excluded by default
    const d1 = ds.find((d) => d.id === seed.d1)!;
    const d2 = ds.find((d) => d.id === seed.d2)!;
    expect(d1.chain_root_id).toBe(seed.d1);
    expect(d2.chain_root_id).toBe(seed.d1);
    expect([d1.chain_position, d2.chain_position]).toEqual(['1', '2']);
    expect(d2.supersede_chain).toBe(`${seed.d1} > ${seed.d2}`);
    expect(d2.supersedes_decision_id).toBe(seed.d1);
    expect(d1.superseded_by_decision_id).toBe(seed.d2);
    expect(d2.text).toBe("'=価格を月額4,980円に変更"); // formula neutralized
    expect(d1.participants).toBe('Alice Client; Bob PM');
    const withCand = csvObjects((await owner.client.get(`${W()}/decisions/export?format=csv&includeCandidates=1`)).raw);
    expect(withCand.some((d) => d.id === seed.d3)).toBe(true);

    const dj = await owner.client.get(`${W()}/decisions/export?format=json`);
    expect(dj.body.format).toBe('meetledger.decisions-export/v1');
    expect(dj.body.chains).toEqual([[seed.d1, seed.d2]]);
    expect(dj.body.decisions.find((d: any) => d.id === seed.d2).supersedeChain).toEqual([seed.d1, seed.d2]);

    const act = await owner.client.get(`${W()}/actions/export?format=csv`);
    const as = csvObjects(act.raw);
    const linked = as.find((a) => a.id === seed.actionLinked)!;
    expect(linked.linked_decision_id).toBe(seed.d2);
    expect(linked.assignee).toBe('Bob PM');
    expect(linked.overdue).toBe('true'); // due 2026-09-30, FakeClock 2026-10-01 10:00 JST
    for (const [i, id] of seed.injectionActions.entries()) {
      const cell = as.find((a) => a.id === id)!.description;
      expect(cell).toBe(`'${INJECTION_TEXTS[i]}`);
      expect(/^[=+\-@]/.test(cell)).toBe(false);
    }
    const com = csvObjects((await owner.client.get(`${W()}/commitments/export`)).raw);
    expect(com).toHaveLength(1);
    expect(com[0]).toMatchObject({ description: '資料を送付する', promised_by: 'Alice Client', promised_to: 'Bob PM', direction: 'mine', status: 'open', meeting_title: 'Kickoff 会議' });
  });

  it('#23 Project meeting book md/html', async () => {
    const md = await owner.client.get(`${W()}/projects/${seed.projectId}/book?format=md`);
    expect(md.status).toBe(200);
    expect(md.raw).toContain('# Project X — Meeting Book');
    expect(md.raw).toContain('=価格を月額4,980円に変更');
    expect(md.raw).toContain('変更履歴: 価格は月額5,980円 → =価格を月額4,980円に変更');
    expect(md.raw).toContain('2026-09-20 Kickoff 会議');
    expect(md.raw).toContain('生成日時');
    const html = await owner.client.get(`${W()}/projects/${seed.projectId}/book?format=html`);
    expect(html.raw).toContain('<!doctype html>');
    expect(html.raw).toContain('Review &lt;b&gt;会議&lt;/b&gt;');
  });

  it('exports respect meeting ACL (private meeting of another user = 404, items hidden)', async () => {
    const bob = await env.addUser(owner.client, owner.orgId, owner.workspaceId, 'bob@example.com', 'member');
    const priv = await owner.client.post(`${W()}/meetings`, { title: 'Owner private', visibility: 'private' });
    await env.tenantTx(owner.orgId, (db) =>
      db.query(`INSERT INTO actions(org_id, workspace_id, meeting_id, description, status) VALUES ($1,$2,$3,'秘密のアクション','confirmed')`, [owner.orgId, owner.workspaceId, priv.body.id]),
    );
    expect((await bob.client.get(`${W()}/meetings/${priv.body.id}/export?format=md`)).status).toBe(404);
    const acts = await bob.client.get(`${W()}/actions/export`);
    expect(acts.raw).not.toContain('秘密のアクション');
    expect((await owner.client.get(`${W()}/actions/export`)).raw).toContain('秘密のアクション');
  });
});

describe('data: full workspace export → import (E2E-9 server flow)', () => {
  it('E2E-9 full export → import into an empty workspace of another tenant keeps relations (modulo id mapping)', async () => {
    const bob = await env.addUser(owner.client, owner.orgId, owner.workspaceId, 'bob2@example.com', 'member');
    const bobPriv = await bob.client.post(`${W()}/meetings`, { title: 'Bob private meeting', visibility: 'private' });
    expect(bobPriv.status).toBe(200);
    // viewer/member cannot start a full export
    expect((await bob.client.post(`${W()}/export/full`, {})).status).toBe(403);

    const start = await owner.client.post(`${W()}/export/full`, { includeMedia: true });
    expect(start.status).toBe(200);
    const pending = await owner.client.get(`${W()}/export/full/${start.body.jobId}`);
    expect(['queued', 'running']).toContain(pending.body.status);
    await env.worker.drain();
    const st = await owner.client.get(`${W()}/export/full/${start.body.jobId}`);
    expect(st.body.status).toBe('ready');
    expect(st.body.url).toMatch(/\/download\?u=.+&exp=\d+&sig=/);
    expect(st.body.excludedMeetings).toBe(1);
    // stored encrypted at rest
    const key = (await sys(env, (db) => db.query('SELECT result FROM jobs WHERE id=$1', [start.body.jobId]))).rows[0].result.storageKey;
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const rawFile = readFileSync(join(env.config.STORAGE_DIR, key));
    expect(rawFile.subarray(0, 4).toString()).toBe('MLE1');
    expect(rawFile.includes(Buffer.from('meetledger.workspace-export'))).toBe(false);

    // signed URL: tampered / other user / expired → 403
    expect((await owner.client.get(st.body.url.replace(/sig=[^&]+/, 'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).status).toBe(403);
    const dl = await owner.client.get(st.body.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    const doc = JSON.parse(dl.raw);
    expect(doc.format).toBe('meetledger.workspace-export/v1');
    expect(doc.generatedAt).toBe(env.clock.now().toISOString());
    expect(doc.schemaMigrations).toContain('001_init.sql');
    // no secrets / password hashes / tokens / derived index
    for (const forbidden of ['password_hash', 'token_hash', 'secret_ciphertext', 'csrf_token', 'scrypt$']) expect(dl.raw).not.toContain(forbidden);
    for (const t of ['users', 'sessions', 'api_tokens', 'search_docs', 'ai_chunks', 'connector_accounts', 'jobs']) expect(doc.tables[t]).toBeUndefined();
    expect(doc.users.every((u: any) => Object.keys(u).sort().join(',') === 'email,id,name')).toBe(true);
    expect(doc.tables.meetings.map((m: any) => m.title)).not.toContain('Bob private meeting');
    expect(doc.media).toHaveLength(1);
    expect(Buffer.from(doc.media[0].data, 'base64').equals(seed.mediaBytes)).toBe(true);
    env.clock.advance((env.config.SIGNED_URL_TTL_SEC + 5) * 1000);
    expect((await owner.client.get(st.body.url)).status).toBe(403);
    env.clock.advance(-(env.config.SIGNED_URL_TTL_SEC + 5) * 1000);

    // import into another tenant's empty workspace
    const b = await env.createTenant('tenant-b@example.com');
    const bad = await b.client.post(`/api/w/${b.workspaceId}/import/full`, { ...doc, format: 'something/else' });
    expect(bad.status).toBe(400);
    const newer = await b.client.post(`/api/w/${b.workspaceId}/import/full`, { ...doc, schemaMigrations: [...doc.schemaMigrations, '999_future.sql'] });
    expect(newer.status).toBe(400);
    const imp = await b.client.post(`/api/w/${b.workspaceId}/import/full`, doc);
    expect(imp.status).toBe(200);
    expect(imp.body.counts.meetings).toBe(doc.tables.meetings.length);
    expect(imp.body.media.restored).toBe(1);
    expect(imp.body.users.matched).toBe(0);
    // non-empty now → refused
    const again = await b.client.post(`/api/w/${b.workspaceId}/import/full`, doc);
    expect(again.status).toBe(409);

    const snapshot = (orgId: string, wsId: string) => env.tenantTx(orgId, (db) => canonical(db, wsId));
    const a = await env.tenantTx(owner.orgId, (db) => canonical(db, owner.workspaceId, ['Bob private meeting']));
    const bb = await snapshot(b.orgId, b.workspaceId);
    expect(bb).toEqual(a);
    expect(bb.decisions.length).toBeGreaterThanOrEqual(3);
    expect(bb.decisions.find((d: any) => d.text === '=価格を月額4,980円に変更').supersedes).toBe('価格は月額5,980円');

    // ids are new, everything belongs to tenant B, private meetings map to the importer
    const idsB = await env.tenantTx(b.orgId, (db) => db.query('SELECT id, created_by, org_id FROM meetings WHERE workspace_id=$1', [b.workspaceId]));
    expect(idsB.rows.some((r) => r.id === seed.m1)).toBe(false);
    expect(idsB.rows.every((r) => r.created_by === b.userId && r.org_id === b.orgId)).toBe(true);
    // media object restored under tenant B and decrypts to the same bytes
    const mB = await env.tenantTx(b.orgId, (db) => db.query(`SELECT storage_key, deleted_at FROM media_assets WHERE org_id=$1`, [b.orgId]));
    expect(mB.rows).toHaveLength(1);
    expect(mB.rows[0].storage_key.startsWith(`org/${b.orgId}/`)).toBe(true);
    expect((await streamToBuffer(await env.deps.storage.getStream(mB.rows[0].storage_key))).equals(seed.mediaBytes)).toBe(true);
    // re-index queued for every imported meeting
    const jobs = await env.tenantTx(b.orgId, (db) => db.query(`SELECT count(*)::int n FROM jobs WHERE type='index.meeting' AND org_id=$1`, [b.orgId]));
    expect(jobs.rows[0].n).toBe(doc.tables.meetings.length);
    // tenant B sees the meetings via the API; tenant A unaffected
    const listB = await b.client.get(`/api/w/${b.workspaceId}/meetings`);
    expect(listB.body.items.map((m: any) => m.title)).toContain('Kickoff 会議');
    // cross-tenant: tenant B cannot fetch tenant A's export status
    expect((await b.client.get(`${W()}/export/full/${start.body.jobId}`)).status).toBe(404);
  });
});

/** Relation snapshot expressed with natural keys (titles / texts / names) so that ids do not matter. */
async function canonical(db: Db, ws: string, excludeTitles: string[] = []) {
  const q = async (sql: string) => (await db.query(sql, [ws])).rows;
  const meetings = (
    await q(`SELECT m.title, m.visibility, m.meeting_type, p.name AS project, s.title AS series, m.scheduled_start,
                    (SELECT string_agg(pa.display_name || ':' || coalesce(pe.name,'-'), ',' ORDER BY pa.display_name) FROM participants pa LEFT JOIN people pe ON pe.id = pa.person_id WHERE pa.meeting_id = m.id) AS participants
               FROM meetings m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN series s ON s.id = m.series_id WHERE m.workspace_id=$1 ORDER BY m.title, m.created_at`)
  ).filter((m) => !excludeTitles.includes(m.title));
  const decisions = await q(`SELECT d.text, d.review_state, d.status, m.title AS meeting, sup.text AS supersedes, sby.text AS superseded_by,
                                    (SELECT string_agg(pe.name, ',' ORDER BY pe.name) FROM people pe WHERE pe.id = ANY(d.participant_person_ids)) AS participants,
                                    (SELECT string_agg(ts.text, '|') FROM transcript_segments ts WHERE ts.id = ANY(d.source_segment_ids)) AS source_text,
                                    (SELECT t.version FROM transcripts t WHERE t.id = d.source_transcript_id) AS source_tv
                               FROM decisions d LEFT JOIN meetings m ON m.id = d.meeting_id LEFT JOIN decisions sup ON sup.id = d.supersedes_decision_id
                               LEFT JOIN decisions sby ON sby.id = d.superseded_by_decision_id WHERE d.workspace_id=$1 ORDER BY d.text`);
  const actions = await q(`SELECT a.description, a.status, m.title AS meeting, ld.text AS linked_decision, pe.name AS assignee, ms.label AS speaker
                             FROM actions a LEFT JOIN meetings m ON m.id = a.meeting_id LEFT JOIN decisions ld ON ld.id = a.linked_decision_id
                             LEFT JOIN people pe ON pe.id = a.assignee_person_id LEFT JOIN meeting_speakers ms ON ms.id = a.assignee_speaker_id
                            WHERE a.workspace_id=$1 ORDER BY a.description`);
  const commitments = await q(`SELECT c.description, c.status, m.title AS meeting, pb.name AS by_person, pt.name AS to_person, c.due_date
                                 FROM commitments c LEFT JOIN meetings m ON m.id = c.meeting_id LEFT JOIN people pb ON pb.id = c.promised_by_person_id
                                 LEFT JOIN people pt ON pt.id = c.promised_to_person_id WHERE c.workspace_id=$1 ORDER BY c.description`);
  const questions = await q(`SELECT q.question, q.status, m.title AS meeting FROM open_questions q LEFT JOIN meetings m ON m.id = q.meeting_id WHERE q.workspace_id=$1 ORDER BY q.question`);
  const segments = await q(`SELECT m.title, ts.seq, ts.start_ms, ts.end_ms, ts.text, sp.label, coalesce(sp.display_name, pe.name) AS speaker_name, t.version
                              FROM transcript_segments ts JOIN meetings m ON m.id = ts.meeting_id JOIN transcripts t ON t.id = ts.transcript_id
                              LEFT JOIN meeting_speakers sp ON sp.id = ts.speaker_id LEFT JOIN people pe ON pe.id = sp.person_id
                             WHERE m.workspace_id=$1 ORDER BY m.title, ts.seq`);
  const contradictions = await q(`SELECT e.text AS existing, n.text AS new, c.status FROM contradiction_candidates c JOIN decisions e ON e.id = c.existing_decision_id
                                   JOIN decisions n ON n.id = c.new_decision_id WHERE c.workspace_id=$1`);
  const summaries = await q(`SELECT m.title, s.sections->'topics'->0->'source'->>'meetingId' = m.id::text AS cites_own_meeting,
                                    (SELECT ts.text FROM transcript_segments ts WHERE ts.id::text = s.sections->'topics'->0->'source'->'segmentIds'->>0) AS cited_text
                               FROM summaries s JOIN meetings m ON m.id = s.meeting_id WHERE m.workspace_id=$1`);
  const notes = await q(`SELECT m.title, n.body FROM meeting_notes n JOIN meetings m ON m.id = n.meeting_id WHERE m.workspace_id=$1 ORDER BY m.title`);
  return { meetings, decisions, actions, commitments, questions, segments, contradictions, summaries, notes };
}
