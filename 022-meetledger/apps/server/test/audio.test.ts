// Audio pipeline / transcripts / media tests. Local mode uses the deterministic fixture provider.
process.env.LOCAL_TRANSCRIPTION_PROVIDER = 'fixture';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toTsqueryLiteral } from '@meetledger/shared';
import { clearFixtureTranscripts, registerFixtureTranscript, type FixtureTranscriptionProvider } from '../src/providers/transcription';
import { DeepgramTranscriptionProvider } from '../src/providers/transcription/deepgram';
import { OpenAiTranscriptionProvider, mapOpenAi } from '../src/providers/transcription/openai';
import { signFileUrl } from '../src/modules/audio/signedUrl';
import { createTestEnv, type Client, type TestEnv } from './helpers';
import { makeSilentWav, makeSineWav, normalizedPcmSha, transcode, uploadMedia } from './audio-helpers';

let env: TestEnv;
let owner: { client: Client; orgId: string; workspaceId: string; userId: string };
let bob: { client: Client; userId: string };
let vic: { client: Client; userId: string };
let ws: string;
const dir = mkdtempSync(join(tmpdir(), 'ml-audio-test-'));

const openAiResponder = (call: any) => {
  if (String(call.url).endsWith('/audio/transcriptions')) {
    return new Response(
      JSON.stringify({
        text: 'x',
        segments: [
          { id: 's1', type: 'transcript.text.segment', start: 0.1, end: 1.2, text: 'クラウドの文字起こしです。', speaker: 'A' },
          { id: 's2', type: 'transcript.text.segment', start: 1.4, end: 2.8, text: '了解です。', speaker: 'B' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', { status: 404 });
};

beforeAll(async () => {
  env = await createTestEnv({ env: { CLOUD_TRANSCRIPTION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real', DEEPGRAM_API_KEY: 'dg-test-not-real', SIGNED_URL_TTL_SEC: '300' } });
  env.http.responder = openAiResponder;
  owner = await env.setupOwner('owner@example.com');
  ws = owner.workspaceId;
  bob = await env.addUser(owner.client, owner.orgId, ws, 'bob@example.com', 'member');
  vic = await env.addUser(owner.client, owner.orgId, ws, 'vic@example.com', 'viewer');
});
afterAll(async () => {
  await env?.close();
  rmSync(dir, { recursive: true, force: true });
});

const fixtureProvider = () => env.deps.providers.transcription('fixture') as FixtureTranscriptionProvider;

async function newMeeting(fields: Record<string, unknown> = {}) {
  const r = await owner.client.post(`/api/w/${ws}/meetings`, { title: 'Audio test', ...fields });
  expect(r.status).toBe(200);
  return r.body as { id: string; version: number };
}

async function jobsFor(meetingId: string) {
  return env.tenantTx(owner.orgId, async (db) => (await db.query(`SELECT * FROM jobs WHERE payload->>'meetingId' = $1 ORDER BY created_at`, [meetingId])).rows);
}

async function externalCallCount(meetingId?: string) {
  return env.tenantTx(owner.orgId, async (db) =>
    Number((await db.query(`SELECT count(*) AS n FROM external_calls WHERE kind='transcription' ${meetingId ? 'AND meeting_id=$1' : ''}`, meetingId ? [meetingId] : [])).rows[0].n),
  );
}

describe('audio upload → processing → transcript', () => {
  let meetingId: string;
  let wav: string;
  let transcriptId: string;

  it('#1 音声アップロード→文字起こし（生成WAV + fixture provider）', async () => {
    const m = await newMeeting({ audioRetention: '30d', participants: [{ name: '田中' }] });
    meetingId = m.id;
    wav = makeSineWav(join(dir, 'meeting1.wav'), { seconds: 3, freq: 440 });
    const sha = await normalizedPcmSha(wav);
    registerFixtureTranscript(sha, {
      language: 'ja',
      segments: [
        { startMs: 0, endMs: 1400, text: '本日は予算の件で集まりました。', speaker: 'spk_a', confidence: 0.92 },
        { startMs: 1500, endMs: 2900, text: '来週までに見積を送ります。', speaker: 'spk_b', confidence: 0.88 },
      ],
    });
    const up = await uploadMedia(owner.client, ws, meetingId, wav);
    expect(up.status).toBe(200);
    expect(up.body.created).toBe(true);
    expect(up.body.transcription).toMatchObject({ allowed: true, provider: 'fixture', isLocal: true, available: true });
    const before = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT status FROM meetings WHERE id=$1', [meetingId])).rows[0]);
    expect(before.status).toBe('processing');

    await env.worker.drain();
    const t = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/transcript`);
    expect(t.status).toBe(200);
    transcriptId = t.body.id;
    expect(t.body.provider).toBe('fixture');
    expect(t.body.isLocal).toBe(true);
    expect(t.body.version).toBe(1);
    expect(t.body.segments.map((s: any) => s.text)).toEqual(['本日は予算の件で集まりました。', '来週までに見積を送ります。']);
    expect(t.body.segments.map((s: any) => s.speakerLabel)).toEqual(['Speaker 1', 'Speaker 2']);
    // Speakers are anonymous clusters; no person is auto-assigned.
    expect(t.body.speakers.every((s: any) => s.personId === null && s.source === 'diarization')).toBe(true);
    expect(t.body.segments[1].endMs).toBeLessThanOrEqual(3000);

    const asset = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT * FROM media_assets WHERE id=$1', [up.body.assetId])).rows[0]);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(asset.size_bytes)).toBe(readFileSync(wav).length);
    expect(asset.duration_ms).toBeGreaterThanOrEqual(2900);
    expect(asset.kind).toBe('original_audio');
    expect(asset.mime).toBe('audio/wav');
    expect(asset.deleted_at).toBeNull();
    expect(new Date(asset.retention_until).getTime()).toBe(env.clock.now().getTime() + 30 * 86400_000);
    // Stored encrypted at rest (original audio and derived transcript are separate).
    const raw = readFileSync(join(env.config.STORAGE_DIR, asset.storage_key));
    expect(raw.subarray(0, 4).toString()).toBe('MLE1');
    expect(raw.includes(Buffer.from('RIFF'))).toBe(false);

    const jobs = await jobsFor(meetingId);
    expect(jobs.find((j) => j.type === 'audio.process')?.status).toBe('succeeded');
    expect(jobs.find((j) => j.type === 'ai.extract')?.idempotency_key).toBe(`ai:${transcriptId}`);
    expect(jobs.some((j) => j.type === 'index.meeting')).toBe(true);
    const seg = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT tsv::text AS tsv FROM transcript_segments WHERE transcript_id=$1 ORDER BY seq', [transcriptId])).rows);
    expect(seg[0].tsv).toContain('予算');
    // Transcript text never reaches the logs.
    expect(env.logs.join('\n')).not.toContain('予算の件');
    expect(env.logs.join('\n')).not.toContain('見積を送ります');
    const proc = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/processing`);
    expect(proc.status).toBe(200);
    expect(proc.body.transcript.id).toBe(transcriptId);
    expect(proc.body.jobs.find((j: any) => j.type === 'audio.process').status).toBe('succeeded');
  });

  it('#2 処理ジョブ再送・同一ファイル再アップロードでtranscript/segmentが重複しない', async () => {
    const calls0 = fixtureProvider().calls;
    const again = await uploadMedia(owner.client, ws, meetingId, wav);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    const first = (await jobsFor(meetingId)).find((j) => j.type === 'audio.process');
    expect(again.body.jobId).toBe(first.id);
    expect(again.body.jobStatus).toBe('succeeded');
    const st = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT status FROM meetings WHERE id=$1', [meetingId])).rows[0].status);
    expect(st).not.toBe('processing');
    await env.worker.drain();
    const rerun = await owner.client.post(`/api/w/${ws}/meetings/${meetingId}/process`, { rerun: true });
    expect(rerun.status).toBe(200);
    expect(rerun.body.jobId).toBe(first.id);
    await env.worker.drain();
    const plain = await owner.client.post(`/api/w/${ws}/meetings/${meetingId}/process`, {});
    expect(plain.body.jobId).toBe(first.id);
    await env.worker.drain();
    const counts = await env.tenantTx(owner.orgId, async (db) => ({
      transcripts: Number((await db.query('SELECT count(*) n FROM transcripts WHERE meeting_id=$1', [meetingId])).rows[0].n),
      segments: Number((await db.query('SELECT count(*) n FROM transcript_segments WHERE meeting_id=$1', [meetingId])).rows[0].n),
      speakers: Number((await db.query('SELECT count(*) n FROM meeting_speakers WHERE meeting_id=$1', [meetingId])).rows[0].n),
      assets: Number((await db.query('SELECT count(*) n FROM media_assets WHERE meeting_id=$1', [meetingId])).rows[0].n),
      aiJobs: Number((await db.query(`SELECT count(*) n FROM jobs WHERE type='ai.extract' AND payload->>'meetingId'=$1`, [meetingId])).rows[0].n),
    }));
    expect(counts).toEqual({ transcripts: 1, segments: 2, speakers: 2, assets: 1, aiJobs: 1 });
    // The rerun found the existing (meeting, input_hash, provider) transcript before calling the provider.
    expect(fixtureProvider().calls).toBe(calls0);
    const versions = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/transcript/versions`);
    expect(versions.body.items).toHaveLength(1);
  });

  it('#3 [inaudible] はAI補完されずそのまま残る（空・低信頼度・表記揺れ）', async () => {
    const m = await newMeeting({ audioRetention: '7d', aiEnabled: false });
    const wav3 = makeSineWav(join(dir, 'inaudible.wav'), { seconds: 6, freq: 523 });
    registerFixtureTranscript(await normalizedPcmSha(wav3), {
      segments: [
        { startMs: 0, endMs: 800, text: '', speaker: 'A', confidence: 0.2 },
        { startMs: 1300, endMs: 2000, text: 'えーと', speaker: 'B', confidence: 0.1 },
        { startMs: 2600, endMs: 3300, text: '[INAUDIBLE]', speaker: 'A' },
        { startMs: 3900, endMs: 4600, text: '(inaudible)', speaker: 'B' },
        { startMs: 5100, endMs: 5900, text: '予算は [inaudible] 円です', speaker: 'A', confidence: 0.8 },
        { startMs: 5950, endMs: 5960, text: '', speaker: 'A' },
      ],
    });
    expect((await uploadMedia(owner.client, ws, m.id, wav3)).status).toBe(200);
    await env.worker.drain();
    const t = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    const segs = t.body.segments;
    expect(segs.map((s: any) => s.text)).toEqual(['[inaudible]', 'えーと', '[inaudible]', '[inaudible]', '予算は [inaudible] 円です']);
    expect(segs[0].flags).toContain('inaudible');
    expect(segs[1].flags).toEqual(['low_confidence']);
    expect(segs[1].confidence).toBeCloseTo(0.1, 5);
    expect(segs[2].flags).toContain('inaudible');
    expect(segs[4].flags).toContain('inaudible');
    expect(segs[4].flags).not.toContain('low_confidence');
    expect(t.body.qualityFlags).toMatchObject({ inaudibleCount: 4, lowConfidenceCount: 2 });
    // AI OFF meeting: no ai.extract job is enqueued (index only).
    const jobs = await jobsFor(m.id);
    expect(jobs.some((j) => j.type === 'ai.extract')).toBe(false);
    expect(jobs.some((j) => j.type === 'index.meeting')).toBe(true);
  });

  it('#4 話者マッピング編集（同一Workspaceの人物のみ・viewer不可・音声から自動特定しない）', async () => {
    const t = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/transcript`);
    const sp1 = t.body.speakers.find((s: any) => s.label === 'Speaker 1');
    expect(sp1.personId).toBeNull();
    const person = await owner.client.post(`/api/w/${ws}/people`, { name: '田中 一郎', email: 'tanaka@example.com' });
    expect(person.status).toBe(200);
    const r = await owner.client.patch(`/api/w/${ws}/meetings/${meetingId}/speakers/${sp1.id}`, { personId: person.body.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: sp1.id, personId: person.body.id, displayName: '田中 一郎' });
    const t2 = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/transcript`);
    expect(t2.body.segments[0].speakerName).toBe('田中 一郎');
    expect(t2.body.segments[1].speakerName).toBeNull();
    const sp2 = t2.body.speakers.find((s: any) => s.label === 'Speaker 2');
    const named = await bob.client.patch(`/api/w/${ws}/meetings/${meetingId}/speakers/${sp2.id}`, { displayName: '取引先 担当者' });
    expect(named.status).toBe(200);
    expect(named.body.displayName).toBe('取引先 担当者');
    // A person of another tenant/workspace cannot be mapped.
    const other = await env.createTenant('other@example.org');
    const foreign = await other.client.post(`/api/w/${other.workspaceId}/people`, { name: 'Foreign' });
    expect(foreign.status).toBe(200);
    expect((await owner.client.patch(`/api/w/${ws}/meetings/${meetingId}/speakers/${sp1.id}`, { personId: foreign.body.id })).status).toBe(400);
    expect((await vic.client.patch(`/api/w/${ws}/meetings/${meetingId}/speakers/${sp1.id}`, { displayName: 'x' })).status).toBe(403);
    // Unmapping is allowed.
    const un = await owner.client.patch(`/api/w/${ws}/meetings/${meetingId}/speakers/${sp1.id}`, { personId: null });
    expect(un.body.personId).toBeNull();
    const audit = await env.tenantTx(owner.orgId, async (db) => (await db.query(`SELECT meta FROM audit_events WHERE action='speaker.mapped'`)).rows);
    expect(audit.length).toBe(3);
  });

  it('segment編集: expectedRevisionで楽観ロック(409)・revision履歴・tsv更新', async () => {
    const t = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/transcript`);
    const seg = t.body.segments[0];
    expect(seg.revision).toBe(1);
    const e1 = await owner.client.patch(`/api/w/${ws}/segments/${seg.id}`, { text: '本日は決算の件で集まりました。', expectedRevision: 1 });
    expect(e1.status).toBe(200);
    expect(e1.body.revision).toBe(2);
    expect(e1.body.flags).toContain('edited');
    const stale = await bob.client.patch(`/api/w/${ws}/segments/${seg.id}`, { text: '上書き', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.server.text).toBe('本日は決算の件で集まりました。');
    expect(stale.body.error.details.server.revision).toBe(2);
    const sp2 = t.body.speakers.find((s: any) => s.label === 'Speaker 2');
    const e2 = await bob.client.patch(`/api/w/${ws}/segments/${seg.id}`, { speakerId: sp2.id, expectedRevision: 2 });
    expect(e2.status).toBe(200);
    expect(e2.body.speakerLabel).toBe('Speaker 2');
    expect((await vic.client.patch(`/api/w/${ws}/segments/${seg.id}`, { text: 'x', expectedRevision: 3 })).status).toBe(403);
    const revs = await vic.client.get(`/api/w/${ws}/segments/${seg.id}/revisions`);
    expect(revs.status).toBe(200);
    expect(revs.body.items.map((r: any) => r.revision)).toEqual([3, 2]);
    expect(revs.body.items[1]).toMatchObject({ oldText: '本日は予算の件で集まりました。', newText: '本日は決算の件で集まりました。' });
    expect(revs.body.items[0]).toMatchObject({ oldSpeakerLabel: 'Speaker 1', newSpeakerLabel: 'Speaker 2' });
    const hit = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT tsv @@ $2::tsquery AS ok FROM transcript_segments WHERE id=$1', [seg.id, toTsqueryLiteral('決算')])).rows[0]);
    expect(hit.ok).toBe(true);
    const idx = (await jobsFor(meetingId)).filter((j) => j.type === 'index.meeting');
    expect(idx.length).toBeGreaterThanOrEqual(3);
  });

  it('#26 署名URL: 期限切れ・別ユーザー・改ざんは403、ACL外/削除済みは404', async () => {
    const media = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/media`);
    expect(media.status).toBe(200);
    const item = media.body.items[0];
    expect(item.playable).toBe(true);
    expect(JSON.stringify(media.body)).not.toContain('storage_key');
    expect(JSON.stringify(media.body)).not.toContain('org/');
    const ok = await owner.client.get(item.url);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/wav');
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(ok.raw, 'binary').subarray(0, 4).toString()).toBe('RIFF');
    // Wrong user: bob replays owner's URL.
    expect((await bob.client.get(item.url)).status).toBe(403);
    // Bob's own URL works (workspace meeting).
    const bobMedia = await bob.client.get(`/api/w/${ws}/meetings/${meetingId}/media`);
    expect((await bob.client.get(bobMedia.body.items[0].url)).status).toBe(200);
    // Tampered signature / expiry.
    expect((await owner.client.get(item.url.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
    expect((await owner.client.get(item.url.replace(/exp=\d+/, (x: string) => `exp=${Number(x.slice(4)) + 1000}`))).status).toBe(403);
    // Anonymous.
    expect((await env.client().get(item.url)).status).toBe(401);
    // Expired (FakeClock).
    env.clock.advance((env.config.SIGNED_URL_TTL_SEC + 1) * 1000);
    expect((await owner.client.get(item.url)).status).toBe(403);
    const fresh = await owner.client.get(`/api/w/${ws}/meetings/${meetingId}/media`);
    expect((await owner.client.get(fresh.body.items[0].url)).status).toBe(200);
    // Private meeting: a valid signature for bob still fails the meeting ACL (404).
    const priv = await newMeeting({ visibility: 'private', audioRetention: '7d' });
    const wavP = makeSineWav(join(dir, 'private.wav'), { seconds: 2, freq: 660 });
    const upP = await uploadMedia(owner.client, ws, priv.id, wavP);
    expect(upP.status).toBe(200);
    const forged = signFileUrl(env.config, env.clock, upP.body.assetId, bob.userId);
    expect((await bob.client.get(forged.url)).status).toBe(404);
    expect((await bob.client.get(`/api/w/${ws}/meetings/${priv.id}/media`)).status).toBe(404);
    // Deleted asset => 404.
    await env.tenantTx(owner.orgId, (db) => db.query('UPDATE media_assets SET deleted_at=now() WHERE id=$1', [upP.body.assetId]));
    const ownerSigned = signFileUrl(env.config, env.clock, upP.body.assetId, owner.userId);
    expect((await owner.client.get(ownerSigned.url)).status).toBe(404);
    await env.worker.drain();
  });
});

describe('#28 privacy: local mode never sends audio out; cloud only via guarded http', () => {
  it('#28 Local modeではtranscription外部呼び出し0件・external_calls 0件', async () => {
    const m = await newMeeting({ transcriptionMode: 'local', audioRetention: '7d' });
    const wav = makeSineWav(join(dir, 'local.wav'), { seconds: 2, freq: 700 });
    registerFixtureTranscript(await normalizedPcmSha(wav), { segments: [{ startMs: 0, endMs: 1800, text: 'ローカルのみで処理します。' }] });
    const before = env.http.byKind('transcription').length;
    expect((await uploadMedia(owner.client, ws, m.id, wav)).status).toBe(200);
    await env.worker.drain();
    const t = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t.body.isLocal).toBe(true);
    expect(env.http.byKind('transcription').length).toBe(before);
    expect(env.http.calls.filter((c) => c.meetingIds?.includes(m.id))).toHaveLength(0);
    expect(await externalCallCount(m.id)).toBe(0);
    expect(await externalCallCount()).toBe(0);
  });

  let cloudMeeting: string;
  it('#28 Cloud modeは許可時のみ1回だけ送信（PolicyDecision + meetingIds付き）、再実行で再送しない', async () => {
    const blocked = await newMeeting({ transcriptionMode: 'cloud', audioRetention: '7d' });
    const wavB = makeSineWav(join(dir, 'cloud-blocked.wav'), { seconds: 2, freq: 750 });
    const upB = await uploadMedia(owner.client, ws, blocked.id, wavB);
    expect(upB.body.transcription.allowed).toBe(false); // workspace has not opted in
    await env.worker.drain();
    expect(env.http.byKind('transcription')).toHaveLength(0);

    const s = await owner.client.patch(`/api/w/${ws}/settings`, { transcription: { cloudAllowed: true } });
    expect(s.status).toBe(200);
    const m = await newMeeting({ transcriptionMode: 'cloud', audioRetention: '7d' });
    cloudMeeting = m.id;
    const wav = makeSineWav(join(dir, 'cloud.wav'), { seconds: 3, freq: 800 });
    const up = await uploadMedia(owner.client, ws, m.id, wav);
    expect(up.body.transcription).toMatchObject({ allowed: true, provider: 'openai', isLocal: false });
    await env.worker.drain();
    const calls = env.http.byKind('transcription');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.provider).toBe('openai');
    expect(c.meetingIds).toEqual([m.id]);
    expect(c.decision).toMatchObject({ allowed: true, isLocal: false, provider: 'openai' });
    expect(c.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const bodyText = Buffer.from(c.init!.body as Buffer).toString('latin1');
    expect(bodyText).toContain('name="model"\r\n\r\ngpt-4o-transcribe-diarize');
    expect(bodyText).toContain('name="response_format"\r\n\r\ndiarized_json');
    expect(bodyText).toContain('name="chunking_strategy"\r\n\r\nauto');
    expect(bodyText).toContain('filename="audio.wav"');
    expect((c.init!.headers as any).authorization).toBe('Bearer sk-test-not-real');
    const t = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t.body).toMatchObject({ provider: 'openai', isLocal: false });
    expect(t.body.segments.map((x: any) => x.speakerLabel)).toEqual(['Speaker 1', 'Speaker 2']);
    const ext = await env.tenantTx(owner.orgId, async (db) => (await db.query(`SELECT * FROM external_calls WHERE meeting_id=$1`, [m.id])).rows);
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ kind: 'transcription', provider: 'openai', host: 'api.openai.com', status: '200' });
    expect(Number(ext[0].bytes_sent)).toBeGreaterThan(90_000);
    // Re-run: the same input+provider transcript exists => no second external call.
    await owner.client.post(`/api/w/${ws}/meetings/${m.id}/process`, { rerun: true });
    await env.worker.drain();
    expect(env.http.byKind('transcription')).toHaveLength(1);
  });

  it('#28 Confidential Meetingはクラウド文字起こしがブロックされる（ジョブ判定 + GuardedHttpの二重防御）', async () => {
    const m = await newMeeting({ transcriptionMode: 'cloud', audioRetention: '7d' });
    // The API forces confidential meetings to local; simulate a stale/forged row to prove both defenses.
    await env.tenantTx(owner.orgId, (db) => db.query(`UPDATE meetings SET is_confidential=true, transcription_mode='cloud' WHERE id=$1`, [m.id]));
    const wav = makeSineWav(join(dir, 'confidential.wav'), { seconds: 2, freq: 900 });
    const up = await uploadMedia(owner.client, ws, m.id, wav);
    expect(up.body.transcription.allowed).toBe(false);
    await env.worker.drain();
    expect(env.http.byKind('transcription')).toHaveLength(1); // unchanged from the previous test
    const job = (await jobsFor(m.id)).find((j) => j.type === 'audio.process');
    expect(job.status).toBe('succeeded');
    expect(job.result.skipped).toBe('transcription_not_allowed');
    expect((await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`)).body).toBeNull();
    // Even a forged "allowed" decision is refused by the guarded HTTP layer (DB re-check), nothing is recorded as sent.
    const provider = new OpenAiTranscriptionProvider(env.config);
    const wavPath = makeSineWav(join(dir, 'direct.wav'), { seconds: 1, freq: 950 });
    await expect(
      provider.transcribe(
        { audioPath: wavPath, durationMs: 1000, language: 'ja' },
        { http: env.http, orgId: owner.orgId, meetingId: m.id, decision: { allowed: true, isLocal: false, provider: 'openai', reason: 'forged' } },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(await externalCallCount(m.id)).toBe(0);
  });

  it('Deepgram / OpenAI(whisper) リクエスト形状とレスポンス変換（FakeHttp, ネットワーク不使用）', async () => {
    const dg = new DeepgramTranscriptionProvider(env.config);
    const prev = env.http.responder;
    env.http.responder = (call: any) =>
      new Response(
        JSON.stringify({
          results: {
            channels: [{ detected_language: 'ja', alternatives: [{ transcript: 'x' }] }],
            utterances: [
              { start: 0.2, end: 1.0, transcript: 'はい、始めます。', confidence: 0.91, speaker: 0 },
              { start: 1.2, end: 2.0, transcript: 'お願いします。', confidence: 0.3, speaker: 1 },
            ],
          },
        }),
        { status: String(call.url).includes('deepgram.com') ? 200 : 404 },
      );
    try {
      const wavPath = makeSineWav(join(dir, 'dg.wav'), { seconds: 2, freq: 1000 });
      const r = await dg.transcribe(
        { audioPath: wavPath, durationMs: 2000, language: 'ja' },
        { http: env.http, orgId: owner.orgId, meetingId: cloudMeeting, decision: { allowed: true, isLocal: false, provider: 'deepgram', reason: 'test' } },
      );
      const call = env.http.calls[env.http.calls.length - 1];
      const u = new URL(call.url);
      expect(u.host).toBe('api.deepgram.com');
      expect(u.pathname).toBe('/v1/listen');
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ model: 'nova-3', diarize: 'true', language: 'ja', mip_opt_out: 'true', utterances: 'true' });
      expect((call.init!.headers as any).authorization).toBe('Token dg-test-not-real');
      expect((call.init!.headers as any)['content-type']).toBe('audio/wav');
      expect(call.kind).toBe('transcription');
      expect(r.diarization).toBe('provider');
      expect(r.segments).toEqual([
        { startMs: 200, endMs: 1000, text: 'はい、始めます。', confidence: 0.91, speaker: 'speaker_0' },
        { startMs: 1200, endMs: 2000, text: 'お願いします。', confidence: 0.3, speaker: 'speaker_1' },
      ]);
    } finally {
      env.http.responder = prev;
    }
    // whisper-1 verbose_json: confidence from avg_logprob; Whisper's own no-speech rule leaves text empty (-> [inaudible]).
    const mapped = mapOpenAi(
      { segments: [{ start: 0, end: 1, text: 'hello', avg_logprob: -0.1, no_speech_prob: 0.01 }, { start: 1, end: 2, text: 'ご視聴ありがとうございました', avg_logprob: -1.5, no_speech_prob: 0.9 }] },
      'verbose_json',
      2000,
    );
    expect(mapped.segments[0].confidence).toBeCloseTo(Math.exp(-0.1), 5);
    expect(mapped.segments[1]).toMatchObject({ text: '', confidence: 0 });
  });
});

describe('upload validation & retention', () => {
  it('magic byte / 拡張子 / MIME 不一致は415、非multipartも415', async () => {
    const m = await newMeeting({ audioRetention: '7d' });
    const wav = makeSineWav(join(dir, 'valid.wav'), { seconds: 1, freq: 300 });
    const txt = join(dir, 'fake.wav');
    writeFileSync(txt, 'this is not audio at all, just text pretending to be a wav file');
    expect((await uploadMedia(owner.client, ws, m.id, txt)).status).toBe(415);
    expect((await uploadMedia(owner.client, ws, m.id, wav, { filename: 'audio.mp3', contentType: 'audio/mpeg' })).status).toBe(415);
    expect((await uploadMedia(owner.client, ws, m.id, wav, { filename: 'audio.wav', contentType: 'video/mp4' })).status).toBe(415);
    const exe = join(dir, 'evil.webm');
    writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]));
    expect((await uploadMedia(owner.client, ws, m.id, exe, { contentType: 'audio/webm' })).status).toBe(415);
    // Valid magic bytes but undecodable body.
    const broken = join(dir, 'broken.flac');
    writeFileSync(broken, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(100, 7)]));
    expect((await uploadMedia(owner.client, ws, m.id, broken, { contentType: 'audio/flac' })).status).toBe(415);
    expect((await owner.client.post(`/api/w/${ws}/meetings/${m.id}/media`, { file: 'x' })).status).toBe(415);
    // Viewer cannot upload; nothing was stored for rejected uploads.
    expect((await uploadMedia(vic.client, ws, m.id, wav)).status).toBe(403);
    const n = await env.tenantTx(owner.orgId, async (db) => Number((await db.query('SELECT count(*) n FROM media_assets WHERE meeting_id=$1', [m.id])).rows[0].n));
    expect(n).toBe(0);
    // Accepted containers (ffmpeg-encoded): m4a, webm/opus, ogg/opus, flac, mp3.
    const encoded: [string, string, string[]][] = [
      ['a.m4a', 'audio/mp4', ['-c:a', 'aac']],
      ['a.webm', 'audio/webm;codecs=opus', ['-c:a', 'libopus']],
      ['a.ogg', 'audio/ogg', ['-c:a', 'libopus']],
      ['a.flac', 'audio/flac', ['-c:a', 'flac']],
      ['a.mp3', 'audio/mpeg', ['-c:a', 'libmp3lame']],
    ];
    for (const [name, mime, codec] of encoded) {
      const f = transcode(wav, join(dir, name), codec);
      const r = await uploadMedia(owner.client, ws, m.id, f, { contentType: mime });
      expect(r.status, name).toBe(200);
    }
    await env.tenantTx(owner.orgId, (db) => db.query(`UPDATE jobs SET status='cancelled' WHERE payload->>'meetingId'=$1 AND status='queued'`, [m.id]));
  });

  it("retention 'until_processed': 成功後に元音声を削除（再生不可・再処理不可）", async () => {
    const m = await newMeeting({ audioRetention: 'until_processed' });
    const wav = makeSineWav(join(dir, 'until.wav'), { seconds: 2, freq: 1100 });
    registerFixtureTranscript(await normalizedPcmSha(wav), { segments: [{ startMs: 0, endMs: 1500, text: '処理後に音声を削除します。' }] });
    const up = await uploadMedia(owner.client, ws, m.id, wav);
    const asset0 = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT * FROM media_assets WHERE id=$1', [up.body.assetId])).rows[0]);
    expect(await env.deps.storage.exists(asset0.storage_key)).toBe(true);
    const pre = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/media`);
    expect(pre.body.items[0].playable).toBe(true);
    await env.worker.drain();
    const asset = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT * FROM media_assets WHERE id=$1', [up.body.assetId])).rows[0]);
    expect(asset.deleted_at).not.toBeNull();
    expect(await env.deps.storage.exists(asset.storage_key)).toBe(false);
    expect((await owner.client.get(pre.body.items[0].url)).status).toBe(404);
    const after = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/media`);
    expect(after.body.items[0]).toMatchObject({ playable: false, url: null });
    expect((await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`)).body.segments).toHaveLength(1);
    const again = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/process`, { rerun: true });
    expect(again.status).toBe(409);
  });

  it("retention 'never': 処理中も再生不可、成功でも失敗でも元音声が残らない", async () => {
    // success
    const m = await newMeeting({ audioRetention: 'never' });
    const wav = makeSineWav(join(dir, 'never.wav'), { seconds: 2, freq: 1200 });
    registerFixtureTranscript(await normalizedPcmSha(wav), { segments: [{ startMs: 0, endMs: 1500, text: '音声は保存しません。' }] });
    const up = await uploadMedia(owner.client, ws, m.id, wav);
    const pending = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/media`);
    expect(pending.body.items[0]).toMatchObject({ playable: false, url: null });
    const forged = signFileUrl(env.config, env.clock, up.body.assetId, owner.userId);
    expect((await owner.client.get(forged.url)).status).toBe(404);
    await env.worker.drain();
    const a1 = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT * FROM media_assets WHERE id=$1', [up.body.assetId])).rows[0]);
    expect(a1.deleted_at).not.toBeNull();
    expect(await env.deps.storage.exists(a1.storage_key)).toBe(false);
    expect((await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`)).body.segments[0].text).toBe('音声は保存しません。');

    // failure (no fixture for this audio => permanent provider error)
    const m2 = await newMeeting({ audioRetention: 'never' });
    const wav2 = makeSilentWav(join(dir, 'never-fail.wav'), 2);
    const up2 = await uploadMedia(owner.client, ws, m2.id, wav2);
    await env.worker.drain();
    const job = (await jobsFor(m2.id)).find((j) => j.type === 'audio.process');
    expect(job.status).toBe('dead');
    expect(job.last_error).toContain('fixture transcript not found');
    const a2 = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT * FROM media_assets WHERE id=$1', [up2.body.assetId])).rows[0]);
    expect(a2.deleted_at).not.toBeNull();
    expect(await env.deps.storage.exists(a2.storage_key)).toBe(false);
    const st = await env.tenantTx(owner.orgId, async (db) => (await db.query('SELECT status FROM meetings WHERE id=$1', [m2.id])).rows[0].status);
    expect(st).toBe('needs_review');
    // temp files are cleaned up
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(env.config.TMP_DIR).filter((f) => f.startsWith('audio-') || f.startsWith('upload-'))).toHaveLength(0);
  });
});

describe('transcript import / desktop local result', () => {
  it('SRT/VTT/TXT/JSON import with "Name: text" speakers; re-import is idempotent', async () => {
    const m = await newMeeting();
    const srt = `1\n00:00:01,000 --> 00:00:03,500\n田中: 今日の議題は価格です。\n\n2\n00:00:04,000 --> 00:00:06,000\nSmith: Sounds good.\n\n3\n00:00:06,500 --> 00:00:08,000\n続きの発言です。\n`;
    const r1 = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'srt', content: srt, language: 'ja' });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ created: true, version: 1, segmentCount: 3 });
    const again = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'srt', content: srt, language: 'ja' });
    expect(again.body).toMatchObject({ created: false, transcriptId: r1.body.transcriptId });
    const t = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t.body.provider).toBe('import');
    expect(t.body.segments.map((s: any) => [s.speakerLabel, s.text, s.startMs])).toEqual([
      ['田中', '今日の議題は価格です。', 1000],
      ['Smith', 'Sounds good.', 4000],
      ['Smith', '続きの発言です。', 6500],
    ]);
    expect(t.body.speakers.every((s: any) => s.personId === null && s.source === 'import')).toBe(true);

    const vtt = `WEBVTT\n\n00:00.000 --> 00:02.000\n<v 佐藤>よろしくお願いします。</v>\n\nNOTE comment\n\n00:02.500 --> 00:04.000\n<v Lee>Hello <b>there</b></v>\n`;
    const r2 = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'vtt', content: vtt });
    expect(r2.body.version).toBe(2);
    const t2 = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t2.body.segments.map((s: any) => [s.speakerLabel, s.text])).toEqual([
      ['佐藤', 'よろしくお願いします。'],
      ['Lee', 'Hello there'],
    ]);
    const old = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript?version=1`);
    expect(old.body.version).toBe(1);
    const versions = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript/versions`);
    expect(versions.body.items.map((v: any) => [v.version, v.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);

    const txt = `[00:00:05] 山田：開始します。\n会議は10:00から始まりました。\n\n[00:00:09] 鈴木: 了解。`;
    const r3 = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'txt', content: txt });
    expect(r3.status).toBe(200);
    const t3 = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t3.body.segments.map((s: any) => [s.speakerLabel, s.text])).toEqual([
      ['山田', '開始します。'],
      ['山田', '会議は10:00から始まりました。'],
      ['鈴木', '了解。'],
    ]);
    expect(t3.body.segments[1].flags).toContain('no_timestamp');

    const json = JSON.stringify({ segments: [{ start: 0.5, end: 1.5, text: 'From JSON', speaker: 'A' }, { start: 2, end: 3, text: '' }] });
    const r4 = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'json', content: json });
    expect(r4.status).toBe(200);
    const t4 = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t4.body.segments.map((s: any) => [s.startMs, s.text])).toEqual([
      [500, 'From JSON'],
      [2000, '[inaudible]'],
    ]);
    expect((await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'vtt', content: 'not vtt' })).status).toBe(400);
    expect((await vic.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/import`, { format: 'txt', content: 'a' })).status).toBe(403);
    expect(env.http.calls.filter((c) => c.meetingIds?.includes(m.id))).toHaveLength(0);
  });

  it('desktop local result: local provider only, channel suggestion, idempotent, no audio upload', async () => {
    const m = await newMeeting({ transcriptionMode: 'local' });
    const payload = {
      provider: 'local-sherpa',
      model: 'sherpa-onnx/sense-voice',
      language: 'ja',
      segments: [
        { startMs: 0, endMs: 2000, text: 'こちらマイク側です。', speaker: 'mic' },
        { startMs: 2500, endMs: 4000, text: '相手側の音声です。', speaker: 'system', confidence: 0.9 },
        { startMs: 4500, endMs: 5000, text: '', speaker: 'system' },
      ],
    };
    expect((await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/local`, { ...payload, provider: 'openai' })).status).toBe(400);
    const r = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/local`, payload);
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    const again = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/transcript/local`, payload);
    expect(again.body.created).toBe(false);
    const t = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/transcript`);
    expect(t.body).toMatchObject({ provider: 'local-sherpa', isLocal: true });
    expect(t.body.segments.map((s: any) => s.text)).toEqual(['こちらマイク側です。', '相手側の音声です。', '[inaudible]']);
    const mic = t.body.speakers.find((s: any) => s.label === 'Speaker 1');
    expect(mic).toMatchObject({ source: 'channel', suggestion: 'あなた（マイク）', personId: null, displayName: null });
    expect(t.body.speakers.find((s: any) => s.label === 'Speaker 2').suggestion).toBe('相手側（システム音声）');
    const media = await env.tenantTx(owner.orgId, async (db) => Number((await db.query('SELECT count(*) n FROM media_assets WHERE meeting_id=$1', [m.id])).rows[0].n));
    expect(media).toBe(0);
    const off = await newMeeting({ transcriptionMode: 'none' });
    expect((await owner.client.post(`/api/w/${ws}/meetings/${off.id}/transcript/local`, payload)).status).toBe(409);
    clearFixtureTranscripts();
  });
});

describe('upload size limit', () => {
  it('MAX_UPLOAD_MB を超えるアップロードは413（保存されない）', async () => {
    const small = await createTestEnv({ env: { MAX_UPLOAD_MB: '1' } });
    try {
      const o = await small.setupOwner('limit@example.com');
      const m = await o.client.post(`/api/w/${o.workspaceId}/meetings`, { title: 'big' });
      const big = makeSineWav(join(dir, 'big.wav'), { seconds: 40, freq: 400 }); // ~1.28 MB
      const r = await uploadMedia(o.client, o.workspaceId, m.body.id, big);
      expect(r.status).toBe(413);
      const n = await small.tenantTx(o.orgId, async (db) => Number((await db.query('SELECT count(*) n FROM media_assets').then((x) => x.rows[0].n))));
      expect(n).toBe(0);
      expect(await small.deps.storage.list(`org/${o.orgId}/`)).toHaveLength(0);
    } finally {
      await small.close();
    }
  });
});
