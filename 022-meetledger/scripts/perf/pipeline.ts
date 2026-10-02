// Pipeline benchmarks (spec §40): upload throughput, real local transcription latency (sherpa-onnx), AI extraction
// (local-rules) on a 1-hour transcript, and audio queue throughput at worker concurrency 1/2/4.
// Usage: PIPELINE_ADMIN_URL=postgres://meetledger:meetledger@127.0.0.1:55432/meetledger npx tsx scripts/perf/pipeline.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../../apps/server/src/config';
import { buildApp } from '../../apps/server/src/app';
import { createPool, withTenant } from '../../apps/server/src/db/pool';
import { migrate } from '../../apps/server/src/db/migrate';
import { Worker } from '../../apps/server/src/jobs/queue';
import { registerJobHandlers } from '../../apps/server/src/modules';
import { toTsvectorLiteral } from '../../packages/shared/src/textIndex';

process.env.MEETLEDGER_FAST_HASH = '1';
const ADMIN = process.env.PIPELINE_ADMIN_URL ?? 'postgres://meetledger:meetledger@127.0.0.1:55432/meetledger';
const MODELS = resolve('models');
const JA = join(MODELS, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/ja.wav');
const tmp = mkdtempSync(join(tmpdir(), 'ml-pipe-'));
const dbName = `ml_pipe_${Date.now().toString(36)}`;
const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const url = ADMIN.replace(/\/[^/]+$/, `/${dbName}`);
const pool = createPool(url, 10);
await migrate(pool);
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, STORAGE_DIR: join(tmp, 'store'), TMP_DIR: join(tmp, 'tmp'), LOG_LEVEL: 'warn', WEB_DIST_DIR: '/nonexistent', LOCAL_ASR_MODEL_DIR: MODELS, MAX_UPLOAD_MB: '2048' });
const { app, deps } = await buildApp({ config, pool, logger: false });
await app.ready();
const results: Record<string, unknown> = { cpus: cpus().length, cpuModel: cpus()[0]?.model };

// --- owner + session
let cookie = '';
let csrf = '';
const call = async (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie, 'x-csrf-token': csrf, ...headers } });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = String(sc).split(';')[0];
  return r;
};
await call('POST', '/api/setup', { email: 'pipe@example.com', name: 'Pipe', password: 'pipeline password 1', orgName: 'Pipe', workspaceName: 'Main' });
const me = (await call('GET', '/api/me')).json();
csrf = me.csrfToken;
const ws = me.workspaces[0].id;
const orgId = me.orgs[0].id;
const mkMeeting = async (title: string, extra: Record<string, unknown> = {}) => {
  const m = (await call('POST', `/api/w/${ws}/meetings`, { title, transcriptionMode: 'local', ...extra })).json();
  await call('POST', `/api/w/${ws}/meetings/${m.id}/consent`, { kind: 'recording', state: 'notified', method: 'verbal' });
  return m.id as string;
};
const loopAudio = (seconds: number, out: string, codec: string[]) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-stream_loop', '-1', '-i', JA, '-t', String(seconds), ...codec, out]);
const upload = async (meetingId: string, file: string, mime: string) => {
  const boundary = '----mlperf' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.split('/').pop()}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const body = Buffer.concat([head, readFileSync(file), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const t = performance.now();
  const r = await call('POST', `/api/w/${ws}/meetings/${meetingId}/media`, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  return { ms: performance.now() - t, status: r.statusCode, body: r.json() };
};

// 1) upload throughput: 60-minute Opus 64 kbps (web recorder) file
// 2) real local transcription latency of that 60-minute recording (sherpa SenseVoice + VAD + diarization)
{
  const f = join(tmp, 'sixty.webm');
  loopAudio(3600, f, ['-c:a', 'libopus', '-b:a', '64k']);
  const mb = statSync(f).size / 1024 / 1024;
  const id = await mkMeeting('upload+asr 60min', { aiEnabled: false });
  const r = await upload(id, f, 'audio/webm');
  results.upload60min = { status: r.status, sizeMB: +mb.toFixed(1), ms: Math.round(r.ms), MBps: +(mb / (r.ms / 1000)).toFixed(1) };
  console.log('upload', results.upload60min);
  const w = new Worker(pool, { concurrency: 1, pollMs: 50 });
  registerJobHandlers(w, deps);
  const t = performance.now();
  await w.drain();
  const ms = performance.now() - t;
  const segs = await withTenant(pool, orgId, async (db) => (await db.query('SELECT count(*)::int n FROM transcript_segments WHERE meeting_id=$1', [id])).rows[0].n);
  const speakers = await withTenant(pool, orgId, async (db) => (await db.query('SELECT count(*)::int n FROM meeting_speakers WHERE meeting_id=$1', [id])).rows[0].n);
  const ext = await withTenant(pool, orgId, async (db) => (await db.query('SELECT count(*)::int n FROM external_calls')).rows[0].n);
  results.localAsr60min = { processMs: Math.round(ms), rtf: +(ms / 1000 / 3600).toFixed(3), segments: segs, speakers, externalCalls: ext, note: 'looped clean ja.wav; includes decode+normalize+VAD+ASR+diarization+DB write' };
  console.log('asr', results.localAsr60min);
}

// 3) AI extraction (local-rules) on a synthetic 1-hour transcript (900 segments)
{
  const id = await mkMeeting('extract 1h');
  const lines = ['価格は月額9800円に決定します', '私が来週金曜までに見積書をお送りします', '公開日はまだ未定ですか？', '田中さんがデモ環境を準備します', 'リリース計画を確認しました', 'サポート体制について議論しました'];
  await withTenant(pool, orgId, async (db) => {
    const t = (await db.query("INSERT INTO transcripts(org_id, meeting_id, version, provider, is_local, language, input_hash) VALUES ($1,$2,1,'fixture',true,'ja','p1') RETURNING id", [orgId, id])).rows[0].id;
    for (let i = 0; i < 900; i++) {
      const text = lines[i % lines.length] + `（議題${i}）`;
      await db.query(`INSERT INTO transcript_segments(org_id, transcript_id, meeting_id, seq, start_ms, end_ms, speaker_label, text, confidence, tsv) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0.9,$9::tsvector)`,
        [orgId, t, id, i, i * 4000, i * 4000 + 3800, `Speaker ${1 + (i % 3)}`, text, toTsvectorLiteral(text)]);
    }
  });
  await call('POST', `/api/w/${ws}/meetings/${id}/extract`, {});
  const w = new Worker(pool, { concurrency: 1, pollMs: 50 });
  registerJobHandlers(w, deps);
  const t0 = performance.now();
  await w.drain();
  const ms = performance.now() - t0;
  const counts = await withTenant(pool, orgId, async (db) => (await db.query(`SELECT (SELECT count(*) FROM decisions WHERE meeting_id=$1)::int d, (SELECT count(*) FROM actions WHERE meeting_id=$1)::int a,
     (SELECT count(*) FROM commitments WHERE meeting_id=$1)::int c, (SELECT count(*) FROM open_questions WHERE meeting_id=$1)::int q`, [id])).rows[0]);
  results.extract1h = { ms: Math.round(ms), candidates: counts, note: 'includes index.meeting job' };
  console.log('extract', results.extract1h);
}

// 4) audio queue throughput: 8 x 60s real local ASR jobs at concurrency 1, 2, 4
{
  const f = join(tmp, 'one.wav');
  loopAudio(60, f, ['-ar', '16000', '-ac', '1']);
  const q: Record<string, unknown> = {};
  for (const c of [1, 2, 4]) {
    for (let i = 0; i < 8; i++) {
      const id = await mkMeeting(`q${c}-${i}`, { aiEnabled: false });
      // distinct bytes per upload (append silence of varying length) so idempotency keys differ
      const fi = join(tmp, `one-${c}-${i}.wav`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-af', `apad=pad_dur=${(i + 1) * 0.1}`, '-ar', '16000', '-ac', '1', fi]);
      await upload(id, fi, 'audio/wav');
    }
    const w = new Worker(pool, { concurrency: c, pollMs: 50 });
    registerJobHandlers(w, deps);
    const t = performance.now();
    await w.drain();
    const ms = performance.now() - t;
    q[`concurrency${c}`] = { jobs: 8, audioSec: 480, wallMs: Math.round(ms), audioSecPerWallSec: +(480 / (ms / 1000)).toFixed(2) };
    console.log('queue', c, q[`concurrency${c}`]);
  }
  results.queue = q;
}

mkdirSync('perf/out', { recursive: true });
writeFileSync('perf/out/pipeline.json', JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2));
console.log(JSON.stringify(results, null, 2));
await app.close();
await pool.end();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.end();
rmSync(tmp, { recursive: true, force: true });
