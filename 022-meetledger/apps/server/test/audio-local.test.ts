// Real on-server local transcription (sherpa-onnx SenseVoice + Silero VAD [+ pyannote/CAM++ diarization]) through the
// full audio.process pipeline. Skipped with a clear message when the models are not downloaded.
delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;

import { localAsrAvailable } from '@meetledger/local-asr';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { uploadMedia } from './audio-helpers';

const MODEL_DIR = resolve(process.env.LOCAL_ASR_MODEL_DIR ?? join(__dirname, '..', '..', '..', 'models'));
const SV = join(MODEL_DIR, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', 'test_wavs');
const avail = localAsrAvailable(MODEL_DIR);
const ready = avail.ok && existsSync(join(SV, 'ja.wav')) && existsSync(join(SV, 'en.wav'));
if (!ready) console.warn(`[audio-local] SKIPPED: local ASR models not available in ${MODEL_DIR} (${avail.reason ?? 'test wavs missing'}). Run: bash scripts/download-models.sh`);

const dir = mkdtempSync(join(tmpdir(), 'ml-audio-local-'));
const envs: TestEnv[] = [];
afterAll(async () => {
  for (const e of envs) await e.close();
  rmSync(dir, { recursive: true, force: true });
});

const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function setup(diarization: 'auto' | 'off') {
  process.env.LOCAL_ASR_DIARIZATION = diarization;
  const env = await createTestEnv({ env: { LOCAL_ASR_MODEL_DIR: MODEL_DIR } });
  envs.push(env);
  const o = await env.setupOwner(`local-${diarization}@example.com`);
  return { env, o };
}

describe.skipIf(!ready)('real local-sherpa transcription through audio.process', () => {
  it('ja + en + ja (m4a upload) → SenseVoice text, local diarization clusters, 0 external calls', async () => {
    const { env, o } = await setup('auto');
    const wav = join(dir, 'mix.wav');
    ff([
      '-i', join(SV, 'ja.wav'), '-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=16000:cl=mono', '-i', join(SV, 'en.wav'), '-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=16000:cl=mono', '-i', join(SV, 'ja.wav'),
      '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ]);
    const m4a = join(dir, 'mix.m4a');
    ff(['-i', wav, '-c:a', 'aac', '-b:a', '96k', m4a]);
    const m = await o.client.post(`/api/w/${o.workspaceId}/meetings`, { title: 'Local ASR', transcriptionMode: 'local', language: 'auto', audioRetention: 'until_processed' });
    const up = await uploadMedia(o.client, o.workspaceId, m.body.id, m4a, { contentType: 'audio/mp4' });
    expect(up.status).toBe(200);
    expect(up.body.transcription.provider).toBe('local-sherpa');
    const t0 = Date.now();
    await env.worker.drain();
    const elapsed = Date.now() - t0;
    const job = (await env.tenantTx(o.orgId, (db) => db.query(`SELECT status, last_error FROM jobs WHERE type='audio.process'`))).rows[0];
    expect(job).toMatchObject({ status: 'succeeded', last_error: null });
    const t = await o.client.get(`/api/w/${o.workspaceId}/meetings/${m.body.id}/transcript`);
    console.info('[audio-local] mix.m4a ->', JSON.stringify(t.body.segments.map((s: any) => [s.startMs, s.endMs, s.speakerLabel, s.text])), JSON.stringify(t.body.qualityFlags), `${elapsed} ms`);
    expect(t.body.provider).toBe('local-sherpa');
    expect(t.body.isLocal).toBe(true);
    const segs = t.body.segments;
    expect(segs).toHaveLength(3);
    expect(segs[0].text).toContain('中学');
    expect(segs[1].text.toLowerCase()).toContain('tribal chieftain');
    expect(segs[2].text).toContain('弁当');
    expect(t.body.qualityFlags.diarization).toBe('provider');
    expect(segs[0].speakerLabel).toBe('Speaker 1');
    expect(segs[2].speakerLabel).toBe('Speaker 1');
    expect(segs[1].speakerLabel).toBe('Speaker 2');
    expect(t.body.speakers.every((s: any) => s.personId === null)).toBe(true);
    // Local mode: nothing went out.
    expect(env.http.calls).toHaveLength(0);
    const ext = (await env.tenantTx(o.orgId, (db) => db.query('SELECT count(*) n FROM external_calls'))).rows[0].n;
    expect(Number(ext)).toBe(0);
    expect(env.logs.join('\n')).not.toContain('中学');
    // until_processed: original deleted after success.
    const a = (await env.tenantTx(o.orgId, (db) => db.query('SELECT deleted_at FROM media_assets WHERE id=$1', [up.body.assetId]))).rows[0];
    expect(a.deleted_at).not.toBeNull();
  });

  it('stereo capture (ch0 = mic, ch1 = system) without diarization → channel-based speakers with mic suggestion', async () => {
    const { env, o } = await setup('off');
    const st = join(dir, 'stereo.wav');
    // Left: ja.wav then silence. Right: silence then en.wav.
    ff([
      '-i', join(SV, 'ja.wav'), '-i', join(SV, 'en.wav'),
      '-filter_complex', '[0:a]apad=pad_dur=8[l];[1:a]adelay=8000[r];[l][r]amerge=inputs=2,atrim=0:16[a]', '-map', '[a]', '-ar', '16000', '-c:a', 'pcm_s16le', st,
    ]);
    const m = await o.client.post(`/api/w/${o.workspaceId}/meetings`, { title: 'Stereo', transcriptionMode: 'local', audioRetention: '7d' });
    const up = await uploadMedia(o.client, o.workspaceId, m.body.id, st);
    expect(up.status).toBe(200);
    await env.worker.drain();
    const t = await o.client.get(`/api/w/${o.workspaceId}/meetings/${m.body.id}/transcript`);
    console.info('[audio-local] stereo ->', JSON.stringify(t.body.segments.map((s: any) => [s.startMs, s.endMs, s.speakerLabel, s.text])), JSON.stringify(t.body.speakers));
    expect(t.body.qualityFlags.diarization).toBe('channel');
    const segs = t.body.segments;
    expect(segs.length).toBeGreaterThanOrEqual(2);
    const jaSeg = segs.find((s: any) => s.text.includes('中学'));
    const enSeg = segs.find((s: any) => /chieftain/i.test(s.text));
    expect(jaSeg && enSeg).toBeTruthy();
    const sp = (label: string) => t.body.speakers.find((s: any) => s.label === label);
    expect(sp(jaSeg.speakerLabel)).toMatchObject({ source: 'channel', suggestion: 'あなた（マイク）', personId: null });
    expect(sp(enSeg.speakerLabel).suggestion).toBe('相手側（システム音声）');
    expect(jaSeg.speakerLabel).not.toBe(enSeg.speakerLabel);
    expect(env.http.calls).toHaveLength(0);
  });
});
