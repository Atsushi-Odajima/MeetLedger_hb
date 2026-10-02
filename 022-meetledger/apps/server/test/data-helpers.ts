// Fixtures for data-module tests (export/import/backup/retention/delete).
import { toTsvectorLiteral } from '@meetledger/shared';
import { insertTranscript, type Client, type TestEnv } from './helpers';
import { mediaKey } from '../src/storage/types';
import { withSystem, type Db } from '../src/db/pool';

export interface Owner {
  client: Client;
  orgId: string;
  workspaceId: string;
  userId: string;
}

export interface RichWorkspace {
  projectId: string;
  seriesId: string;
  m1: string;
  m2: string;
  people: { alice: string; bob: string };
  t1: { transcriptId: string; segmentIds: string[]; speakerIds: Record<string, string> };
  t2: { transcriptId: string; segmentIds: string[]; speakerIds: Record<string, string> };
  d1: string;
  d2: string;
  d3: string;
  actionLinked: string;
  injectionActions: string[];
  commitment: string;
  question: string;
  mediaAssetId: string;
  mediaKey: string;
  mediaBytes: Buffer;
}

export const INJECTION_TEXTS = ['=HYPERLINK("http://evil.example","x")', '+cmd|/C calc!A0', '-2+3', '@SUM(A1:A2)'];

async function ok(r: { status: number; raw: string; body: any }, what: string) {
  if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${r.raw.slice(0, 300)}`);
  return r.body;
}

/** Creates projects, series, 2 meetings with transcripts, ledger items with a supersede chain, a summary, notes, and a media object. */
export async function seedRichWorkspace(env: TestEnv, o: Owner): Promise<RichWorkspace> {
  const c = o.client;
  const ws = o.workspaceId;
  const project = await ok(await c.post(`/api/w/${ws}/projects`, { name: 'Project X', description: 'テスト用プロジェクト' }), 'project');
  const series = await ok(await c.post(`/api/w/${ws}/series`, { title: 'Weekly Sync', projectId: project.id }), 'series');
  const parts = [
    { name: 'Alice Client', email: 'alice.client@example.com', role: 'organizer' },
    { name: 'Bob PM', email: 'bob.pm@example.com' },
  ];
  const m1 = await ok(
    await c.post(`/api/w/${ws}/meetings`, { title: 'Kickoff 会議', scheduledStart: '2026-09-20T01:00:00Z', scheduledEnd: '2026-09-20T02:00:00Z', projectId: project.id, seriesId: series.id, participants: parts }),
    'm1',
  );
  const m2 = await ok(
    await c.post(`/api/w/${ws}/meetings`, { title: 'Review <b>会議</b>', scheduledStart: '2026-09-27T01:00:00Z', projectId: project.id, seriesId: series.id, participants: parts }),
    'm2',
  );
  const alice = m1.participants.find((p: any) => p.displayName === 'Alice Client').personId;
  const bob = m1.participants.find((p: any) => p.displayName === 'Bob PM').personId;
  const t1 = await insertTranscript(env, o.orgId, m1.id, [
    { speaker: 'Speaker 1', text: '本日はキックオフです。価格は月額5,980円で進めます。', startMs: 0, endMs: 4200 },
    { speaker: 'Speaker 2', text: '了解です。資料は来週お送りします。', startMs: 4500, endMs: 9100 },
    { speaker: 'Speaker 1', text: '=SUM(A1:A2) は数式ではなく発言です。', startMs: 9500, endMs: 12000 },
  ]);
  const t2 = await insertTranscript(env, o.orgId, m2.id, [
    { speaker: 'Speaker 1', text: '価格を月額4,980円に変更します。', startMs: 1000, endMs: 5000 },
    { speaker: 'Speaker 2', text: '<script>alert(1)</script> 公開日はまだ未定です。', startMs: 5200, endMs: 9000 },
    { speaker: 'Speaker 1', text: '比較表を作ります。', startMs: 9300, endMs: 3_725_000 },
  ]);
  const ids = await env.tenantTx(o.orgId, async (db: Db) => {
    await db.query('UPDATE meeting_speakers SET person_id=$2, display_name=$3 WHERE id=$1', [t1.speakerIds['Speaker 1'], alice, 'Alice Client']);
    await db.query('UPDATE meeting_speakers SET person_id=$2 WHERE id=$1', [t2.speakerIds['Speaker 2'], bob]);
    const one = async (sql: string, p: unknown[]) => (await db.query(sql + ' RETURNING id', p)).rows[0].id as string;
    const d1 = await one(
      `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, review_state, status, participant_person_ids,
                             source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions, extracted_by, created_by, confirmed_by, confirmed_at, decided_at)
       VALUES ($1,$2,$3,$4,$5,'価格は月額5,980円','価格','confirmed','superseded',$6,$7,0,4200,'価格は月額5,980円で進めます。',$8,$9,'ai',$10,$10,now(),'2026-09-20T01:10:00Z')`,
      [o.orgId, ws, m1.id, project.id, series.id, [alice, bob], [t1.segmentIds[0]], t1.transcriptId, { [t1.segmentIds[0]]: 1 }, o.userId],
    );
    const d2 = await one(
      `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, review_state, status, supersedes_decision_id, participant_person_ids,
                             source_segment_ids, source_start_ms, source_end_ms, source_transcript_id, extracted_by, created_by, confirmed_by, confirmed_at, decided_at)
       VALUES ($1,$2,$3,$4,$5,'=価格を月額4,980円に変更','価格','confirmed','active',$6,$7,$8,1000,5000,$9,'user',$10,$10,now(),'2026-09-27T01:05:00Z')`,
      [o.orgId, ws, m2.id, project.id, series.id, d1, [alice], [t2.segmentIds[0]], t2.transcriptId, o.userId],
    );
    await db.query('UPDATE decisions SET superseded_by_decision_id=$2 WHERE id=$1', [d1, d2]);
    const d3 = await one(`INSERT INTO decisions(org_id, workspace_id, meeting_id, text, review_state, extracted_by) VALUES ($1,$2,$3,'候補の決定','candidate','ai')`, [o.orgId, ws, m2.id]);
    const actionLinked = await one(
      `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, description, assignee_person_id, due_date, status, linked_decision_id, assignee_speaker_id,
                           source_segment_ids, source_start_ms, source_quote, source_transcript_id, extracted_by, created_by)
       VALUES ($1,$2,$3,$4,'料金ページを更新する',$5,'2026-09-30','confirmed',$6,$7,$8,1000,'価格を月額4,980円に変更します。',$9,'ai',$10)`,
      [o.orgId, ws, m2.id, project.id, bob, d2, t2.speakerIds['Speaker 1'], [t2.segmentIds[0]], t2.transcriptId, o.userId],
    );
    const injectionActions: string[] = [];
    for (const text of INJECTION_TEXTS)
      injectionActions.push(await one(`INSERT INTO actions(org_id, workspace_id, meeting_id, description, status, created_by) VALUES ($1,$2,$3,$4,'confirmed',$5)`, [o.orgId, ws, m2.id, text, o.userId]));
    const commitment = await one(
      `INSERT INTO commitments(org_id, workspace_id, meeting_id, project_id, description, promised_by_person_id, promised_by_user_id, promised_to_person_id, due_date, status,
                               source_segment_ids, source_transcript_id, extracted_by, created_by)
       VALUES ($1,$2,$3,$4,'資料を送付する',$5,$6,$7,'2026-10-05','open',$8,$9,'ai',$6)`,
      [o.orgId, ws, m1.id, project.id, alice, o.userId, bob, [t1.segmentIds[1]], t1.transcriptId],
    );
    const question = await one(
      `INSERT INTO open_questions(org_id, workspace_id, meeting_id, project_id, question, owner_person_id, status, source_segment_ids, created_by)
       VALUES ($1,$2,$3,$4,'公開日はいつか？',$5,'open',$6,$7)`,
      [o.orgId, ws, m2.id, project.id, bob, [t2.segmentIds[1]], o.userId],
    );
    await db.query(
      `INSERT INTO contradiction_candidates(org_id, workspace_id, meeting_id, existing_decision_id, new_decision_id, reason, status) VALUES ($1,$2,$3,$4,$5,'価格が変わった','confirmed_change')`,
      [o.orgId, ws, m2.id, d1, d2],
    );
    await db.query(`INSERT INTO summaries(org_id, meeting_id, transcript_id, version, provider, sections) VALUES ($1,$2,$3,1,'local-rules',$4)`, [
      o.orgId,
      m2.id,
      t2.transcriptId,
      { executive: '価格を4,980円に変更した。', topics: [{ title: '価格変更', source: { meetingId: m2.id, segmentIds: [t2.segmentIds[0]], startMs: 1000, endMs: 5000, quote: null } }], risks: [], nextMeeting: null },
    ]);
    await db.query(`INSERT INTO ledger_events(org_id, workspace_id, entity_type, entity_id, event, by_user_id, diff) VALUES ($1,$2,'decision',$3,'superseded',$4,$5)`, [
      o.orgId,
      ws,
      d1,
      o.userId,
      { by: d2 },
    ]);
    return { d1, d2, d3, actionLinked, injectionActions, commitment, question };
  });
  await ok(await c.put(`/api/w/${ws}/meetings/${m1.id}/notes`, { body: 'オーナーのメモ', baseVersion: 0 }), 'notes');
  // media object (encrypted at rest) + row
  const mediaBytes = Buffer.from('RIFF....WAVEfmt fake audio payload for tests '.repeat(50));
  const { mediaAssetId, key } = await env.tenantTx(o.orgId, async (db) => {
    const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    const key = mediaKey(o.orgId, m1.id, 'original_audio', id);
    const put = await env.deps.storage.putBuffer(key, mediaBytes);
    await db.query(
      `INSERT INTO media_assets(id, org_id, meeting_id, kind, storage_key, mime, original_name, size_bytes, sha256, retention_until, created_by)
       VALUES ($1,$2,$3,'original_audio',$4,'audio/wav','kickoff.wav',$5,$6,'2026-12-31T00:00:00Z',$7)`,
      [id, o.orgId, m1.id, key, put.size, put.sha256, o.userId],
    );
    await db.query('UPDATE transcripts SET media_asset_id=$2 WHERE id=$1', [t1.transcriptId, id]);
    return { mediaAssetId: id, key };
  });
  return { projectId: project.id, seriesId: series.id, m1: m1.id, m2: m2.id, people: { alice, bob }, t1, t2, ...ids, mediaAssetId, mediaKey: key, mediaBytes };
}

export async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as any));
  return Buffer.concat(chunks);
}

/** Inserts index rows directly (search_docs / ai_chunks) the way the search module would. */
export async function insertIndexRows(env: TestEnv, orgId: string, workspaceId: string, rows: { meetingId: string | null; entityType: string; entityId: string; text: string; createdAt?: string }[]) {
  await env.tenantTx(orgId, async (db) => {
    for (const r of rows) {
      await db.query(
        `INSERT INTO search_docs(org_id, workspace_id, meeting_id, entity_type, entity_id, title, body, tsv) VALUES ($1,$2,$3,$4,$5,'t',$6,$7::tsvector)
         ON CONFLICT (entity_type, entity_id) DO NOTHING`,
        [orgId, workspaceId, r.meetingId, r.entityType, r.entityId, r.text, toTsvectorLiteral(r.text)],
      );
      await db.query(
        `INSERT INTO ai_chunks(org_id, workspace_id, meeting_id, entity_type, entity_id, chunk_index, text, embedding, embedding_model, created_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'{0.1,0.2,0.3}','test-model',coalesce($7::timestamptz, now()))
         ON CONFLICT DO NOTHING`,
        [orgId, workspaceId, r.meetingId, r.entityType, r.entityId, r.text, r.createdAt ?? null],
      );
    }
  });
}

export function sys<T>(env: TestEnv, fn: (db: Db) => Promise<T>) {
  return withSystem(env.pool, fn);
}
