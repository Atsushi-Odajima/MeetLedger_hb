#!/usr/bin/env node
// Generates a large synthetic (fictional) dataset for performance measurement.
// Default scale (spec §40): 10 years, 50,000 meetings, 10,000,000 transcript segments, 500,000 decisions,
// 1,000,000 actions+commitments. Use --scale 0.01 for a quick run.
// Usage: PERF_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ml_perf node scripts/perf/generate.mjs [--scale 1]
// The target DB must be migrated already. Runs as a superuser/table owner with app.system=on (bypasses RLS for bulk load).
import pg from 'pg';
import { toTsvectorLiteral } from '../../packages/shared/src/textIndex.ts';

const scale = Number(process.argv.find((a, i, arr) => arr[i - 1] === '--scale') ?? 1);
const url = process.env.PERF_DATABASE_URL;
if (!url) throw new Error('PERF_DATABASE_URL required');
const N = {
  meetings: Math.round(50000 * scale),
  segmentsPerMeeting: 200,
  decisions: Math.round(500000 * scale),
  actions: Math.round(500000 * scale),
  commitments: Math.round(500000 * scale),
  questions: Math.round(100000 * scale),
  people: Math.max(50, Math.round(2000 * scale)),
  projects: Math.max(10, Math.round(200 * scale)),
  series: Math.max(10, Math.round(300 * scale)),
};

const PHRASES = [
  '価格改定について議論しました', '公開日は11月に変更します', '見積書を来週までにお送りします', 'ProofFlowの要件を確認しました', 'Client Alphaとの契約更新',
  '次回までに資料を共有します', 'リリース計画を再確認', '採用計画の進捗を共有', 'サポート問い合わせが増えています', 'デザインレビューは木曜日に実施',
  '予算は来期に持ち越し', 'セキュリティ監査の対応状況', 'オンボーディング資料を更新します', '営業パイプラインの確認', '解約率の推移を分析',
  'APIの仕様変更について', 'ベータ版のフィードバック', '広告予算を10%削減', 'パートナー契約の条件を確認', '品質目標を設定しました',
  '田中さんが担当します', '佐藤さんに確認をお願いします', '次のマイルストーンは月末です', 'ロードマップの優先度を変更', '課題管理表を更新します',
  'we decided to postpone the launch', 'pricing discussion with the client', 'I will send the proposal by Friday', 'open question about the release date',
  'customer feedback on onboarding', 'quarterly review of the roadmap', 'migration plan for the database', 'hiring plan update', 'renewal terms for Client A',
  '議事録を確認しました', 'スケジュールの調整が必要です', '検証環境を準備します', '利用規約の改定案', '請求フローの見直し', 'ダッシュボードの改善',
  'モバイル対応の範囲', '翻訳対応は後回し', 'トライアル期間を延長', '研修の日程を決めました', '社内向け説明会を実施', 'KPIの定義を合わせる',
];
const LEDGER = ['価格を月額9,800円に変更', '公開日を11月に決定', '資料を送付する', '見積を返却してもらう', 'ProofFlowのβを延期', 'Client Alphaの更新を承認', '採用枠を2名追加', 'サポート体制を強化'];

const client = new pg.Client({ connectionString: url });
await client.connect();
const t0 = Date.now();
const step = async (name, sql, params = []) => {
  const s = Date.now();
  await client.query(sql, params);
  console.log(`${name}: ${((Date.now() - s) / 1000).toFixed(1)}s`);
};

await client.query("SET app.system = 'on'");
await client.query('SET maintenance_work_mem = \'1GB\'');
const org = (await client.query("INSERT INTO organizations(name) VALUES ('Perf Org (synthetic)') RETURNING id")).rows[0].id;
const user = (await client.query("INSERT INTO users(email, name, password_hash) VALUES ('perf-' || gen_random_uuid() || '@example.com', 'Perf User', NULL) RETURNING id")).rows[0].id;
const ws = (await client.query("INSERT INTO workspaces(org_id, name) VALUES ($1, 'Perf Workspace') RETURNING id", [org])).rows[0].id;
await client.query("INSERT INTO org_members(org_id, user_id, role) VALUES ($1,$2,'owner')", [org, user]);
await client.query("INSERT INTO workspace_members(workspace_id, org_id, user_id, role) VALUES ($1,$2,$3,'owner')", [ws, org, user]);
console.log(JSON.stringify({ org, ws, user, scale, N }));

await client.query('CREATE TEMP TABLE phr(id int PRIMARY KEY, text text, tsv tsvector)');
for (const [i, p] of PHRASES.entries()) await client.query('INSERT INTO phr VALUES ($1,$2,$3::tsvector)', [i, p, toTsvectorLiteral(p)]);
const P = PHRASES.length;

await step('people', `INSERT INTO people(org_id, workspace_id, name, organization, email, created_at)
  SELECT $1, $2, 'Person ' || g, 'Company ' || (g % 97), 'person' || g || '@example.com', now() FROM generate_series(1, $3) g`, [org, ws, N.people]);
await step('projects', `INSERT INTO projects(org_id, workspace_id, name, kind) SELECT $1, $2, 'Project ' || g, CASE WHEN g % 3 = 0 THEN 'client' ELSE 'project' END FROM generate_series(1, $3) g`, [org, ws, N.projects]);
await step('series', `INSERT INTO series(org_id, workspace_id, title, meeting_type) SELECT $1, $2, 'Series ' || g, 'internal' FROM generate_series(1, $3) g`, [org, ws, N.series]);
await client.query('CREATE TEMP TABLE pj AS SELECT row_number() OVER () AS n, id FROM projects WHERE workspace_id=$1', [ws]);
await client.query('CREATE TEMP TABLE sr AS SELECT row_number() OVER () AS n, id FROM series WHERE workspace_id=$1', [ws]);
await client.query('CREATE TEMP TABLE pp AS SELECT row_number() OVER () AS n, id FROM people WHERE workspace_id=$1', [ws]);

// Meetings spread over 10 years until 2026-10-01; ~10% private (other creator semantics not needed for perf).
await step('meetings', `INSERT INTO meetings(org_id, workspace_id, title, scheduled_start, scheduled_end, meeting_type, project_id, series_id, visibility, status, created_by, transcription_mode, created_at)
  SELECT $1, $2, 'Meeting ' || g, ts, ts + interval '1 hour', (ARRAY['client','internal','one_on_one','project','sales','workshop'])[1 + g % 6],
         (SELECT id FROM pj WHERE n = 1 + g % (SELECT count(*) FROM pj)), (SELECT id FROM sr WHERE n = 1 + g % (SELECT count(*) FROM sr)),
         CASE WHEN g % 10 = 0 THEN 'private' ELSE 'workspace' END, 'ready', $3, 'local', ts
  FROM (SELECT g, timestamptz '2016-10-01' + (g::float / $4) * (timestamptz '2026-10-01' - timestamptz '2016-10-01') AS ts FROM generate_series(1, $4) g) x`,
  [org, ws, user, N.meetings]);
await client.query('CREATE TEMP TABLE mt AS SELECT row_number() OVER (ORDER BY scheduled_start) AS n, id, project_id, series_id, scheduled_start FROM meetings WHERE workspace_id=$1', [ws]);
await client.query('CREATE INDEX ON mt(n)');
await step('participants', `INSERT INTO participants(org_id, meeting_id, person_id, display_name)
  SELECT $1, mt.id, pp.id, 'Person' FROM mt JOIN generate_series(0, 2) k ON true JOIN pp ON pp.n = 1 + ((mt.n * 7 + k * 131) % (SELECT count(*) FROM pp))`, [org]);
await step('transcripts', `INSERT INTO transcripts(org_id, meeting_id, version, provider, is_local, language, input_hash)
  SELECT $1, id, 1, 'fixture', true, 'ja', 'perf-' || id FROM mt`, [org]);
await step('speakers', `INSERT INTO meeting_speakers(org_id, meeting_id, label) SELECT $1, mt.id, 'Speaker ' || k FROM mt JOIN generate_series(1, 3) k ON true`, [org]);

// 10M segments in batches (by meeting ranges) to bound memory/WAL.
await client.query('ALTER TABLE transcript_segments DROP CONSTRAINT IF EXISTS transcript_segments_transcript_id_seq_key');
await client.query('DROP INDEX IF EXISTS segments_tsv');
await client.query('DROP INDEX IF EXISTS segments_meeting');
const batch = 2000;
const segStart = Date.now();
for (let lo = 1; lo <= N.meetings; lo += batch) {
  await client.query(
    `INSERT INTO transcript_segments(org_id, transcript_id, meeting_id, seq, start_ms, end_ms, speaker_label, text, confidence, tsv)
     SELECT $1, t.id, mt.id, s, s * 15000, s * 15000 + 14000, 'Speaker ' || (1 + s % 3), a.text || '。' || b.text, 0.9, a.tsv || b.tsv
       FROM mt JOIN transcripts t ON t.meeting_id = mt.id
       JOIN generate_series(0, $4 - 1) s ON true
       JOIN phr a ON a.id = (mt.n * 31 + s * 7) % ${P}
       JOIN phr b ON b.id = (mt.n * 17 + s * 13 + 5) % ${P}
      WHERE mt.n BETWEEN $2 AND $3`,
    [org, lo, Math.min(lo + batch - 1, N.meetings), N.segmentsPerMeeting],
  );
  if ((lo - 1) % (batch * 5) === 0) console.log(`  segments up to meeting ${Math.min(lo + batch - 1, N.meetings)} (${((Date.now() - segStart) / 1000).toFixed(0)}s)`);
}
console.log(`segments total: ${((Date.now() - segStart) / 1000).toFixed(1)}s`);
await step('index segments(meeting_id,start_ms)', 'CREATE INDEX segments_meeting ON transcript_segments(meeting_id, start_ms)');
await step('index segments tsv (GIN)', 'CREATE INDEX segments_tsv ON transcript_segments USING gin(tsv)');
await step('unique (transcript_id, seq)', 'ALTER TABLE transcript_segments ADD CONSTRAINT transcript_segments_transcript_id_seq_key UNIQUE (transcript_id, seq)');

const L = LEDGER.length;
await client.query('CREATE TEMP TABLE led(id int PRIMARY KEY, text text)');
for (const [i, p] of LEDGER.entries()) await client.query('INSERT INTO led VALUES ($1,$2)', [i, p]);
await step('decisions', `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, topic_key, review_state, status, extracted_by, decided_at, created_at)
  SELECT $1, $2, mt.id, mt.project_id, mt.series_id, led.text || ' #' || g, 'topic' || (g % 500), 'topic' || (g % 500),
         CASE WHEN g % 10 = 0 THEN 'candidate' ELSE 'confirmed' END, CASE WHEN g % 4 = 0 THEN 'superseded' ELSE 'active' END, 'ai', mt.scheduled_start, mt.scheduled_start
    FROM generate_series(1, $3) g JOIN mt ON mt.n = 1 + (g % $4) JOIN led ON led.id = g % ${L}`, [org, ws, N.decisions, N.meetings]);
await step('actions', `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, series_id, description, assignee_person_id, assignee_user_id, due_date, status, extracted_by, created_at)
  SELECT $1, $2, mt.id, mt.project_id, mt.series_id, led.text || ' #' || g, pp.id, CASE WHEN g % 5 = 0 THEN $5::uuid END, (mt.scheduled_start + interval '7 days')::date,
         (ARRAY['confirmed','in_progress','done','done','done','cancelled','candidate'])[1 + g % 7], 'ai', mt.scheduled_start
    FROM generate_series(1, $3) g JOIN mt ON mt.n = 1 + (g % $4) JOIN led ON led.id = g % ${L} JOIN pp ON pp.n = 1 + g % (SELECT count(*) FROM pp)`, [org, ws, N.actions, N.meetings, user]);
await step('commitments', `INSERT INTO commitments(org_id, workspace_id, meeting_id, project_id, series_id, description, promised_by_person_id, promised_to_person_id, promised_by_user_id, due_date, status, extracted_by, created_at)
  SELECT $1, $2, mt.id, mt.project_id, mt.series_id, led.text || ' #' || g, pp.id, pp2.id, CASE WHEN g % 4 = 0 THEN $5::uuid END, (mt.scheduled_start + interval '5 days')::date,
         (ARRAY['open','done','done','cancelled','candidate'])[1 + g % 5], 'ai', mt.scheduled_start
    FROM generate_series(1, $3) g JOIN mt ON mt.n = 1 + (g % $4) JOIN led ON led.id = g % ${L}
    JOIN pp ON pp.n = 1 + g % (SELECT count(*) FROM pp) JOIN pp pp2 ON pp2.n = 1 + (g * 3) % (SELECT count(*) FROM pp)`, [org, ws, N.commitments, N.meetings, user]);
await step('questions', `INSERT INTO open_questions(org_id, workspace_id, meeting_id, project_id, series_id, question, status, extracted_by, created_at)
  SELECT $1, $2, mt.id, mt.project_id, mt.series_id, '公開日はいつにするか？ #' || g, (ARRAY['open','answered','dropped'])[1 + g % 3], 'ai', mt.scheduled_start
    FROM generate_series(1, $3) g JOIN mt ON mt.n = 1 + (g % $4)`, [org, ws, N.questions, N.meetings]);
// search_docs for ledger items (decisions/actions/commitments/questions) built from phrase tsvectors.
for (const [type, table, col] of [['decision', 'decisions', 'text'], ['action', 'actions', 'description'], ['commitment', 'commitments', 'description'], ['question', 'open_questions', 'question']]) {
  await step(`search_docs ${type}`, `INSERT INTO search_docs(org_id, workspace_id, meeting_id, entity_type, entity_id, title, body, tsv, occurred_at)
    SELECT x.org_id, x.workspace_id, x.meeting_id, '${type}', x.id, NULL, x.${col}, phr.tsv, x.created_at FROM ${table} x
      JOIN phr ON phr.id = abs(hashtext(x.${col})) % ${P} WHERE x.workspace_id = $1 ON CONFLICT DO NOTHING`, [ws]);
}
await step('ANALYZE', 'ANALYZE');
const sizes = await client.query(`SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`);
console.table(sizes.rows);
const counts = await client.query(`SELECT (SELECT count(*) FROM meetings WHERE workspace_id=$1) meetings, (SELECT count(*) FROM transcript_segments) segments,
  (SELECT count(*) FROM decisions WHERE workspace_id=$1) decisions, (SELECT count(*) FROM actions WHERE workspace_id=$1) + (SELECT count(*) FROM commitments WHERE workspace_id=$1) actions_commitments`, [ws]);
console.log(JSON.stringify(counts.rows[0]));
console.log(`total ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
await client.end();
