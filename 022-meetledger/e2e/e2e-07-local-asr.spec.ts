// E2E-7: Local mode with the REAL on-device recognizer (sherpa-onnx SenseVoice) on the bundled Japanese test WAV:
//        the transcript appears, the (fake) cloud receives zero requests, and the summary comes from local-rules.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { waitFor } from './support/api';
import { cloudEnv, startFakeExternal, type FakeExternal } from './support/fakeExternal';
import { MODELS_DIR } from './support/server';
import { openTab, uploadWithConsent } from './support/ui';

const JA_WAV = path.join(MODELS_DIR, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', 'test_wavs', 'ja.wav');

let fake: FakeExternal;
const h = useServer(async () => {
  fake = await startFakeExternal();
  return { name: 'e2e07', localAsr: 'local-sherpa', env: cloudEnv(fake) };
});
test.afterAll(async () => fake?.close());

test('real local transcription (sherpa) + local-rules summary, nothing sent out', async ({ page, api }) => {
  test.skip(!existsSync(JA_WAV), `local ASR model not downloaded (${JA_WAV}); run scripts/download-models.sh`);
  test.setTimeout(240_000);
  const errors = trackPageErrors(page);
  const { ws } = await setupOwner(api);
  // Cloud transcription is allowed and even the workspace default — the meeting explicitly chooses Local.
  await ws.patch('/settings', { transcription: { cloudAllowed: true, language: 'ja' }, defaults: { transcriptionMode: 'cloud' } });

  await page.goto(`/w/${ws.wsId}/meetings/new`);
  await page.getByLabel('タイトル').fill('ローカル文字起こしの確認');
  await page.getByRole('radio', { name: /ローカル文字起こし（Local）/ }).check();
  await page.getByRole('button', { name: '作成して記録を始める' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}\/capture/);
  const meetingId = /meetings\/([0-9a-f-]{36})/.exec(page.url())![1];
  expect(await ws.meeting(meetingId)).toMatchObject({ transcriptionMode: 'local', aiEnabled: true, isConfidential: false });

  await uploadWithConsent(page, JA_WAV);
  const proc = await waitFor(
    'local-sherpa transcript + summary',
    () => ws.processing(meetingId),
    (p: any) => {
      const bad = p.jobs?.find((j: any) => ['failed', 'dead'].includes(j.status));
      if (bad) throw new Error(`${bad.type} failed: ${bad.error}`);
      return !!p.transcript && p.jobs.some((j: any) => j.type === 'ai.extract' && j.status === 'succeeded');
    },
    180_000,
    1000,
  );
  expect(proc.transcript).toMatchObject({ provider: 'local-sherpa', isLocal: true });

  const tr = await ws.get(`/meetings/${meetingId}/transcript`);
  const text = (tr.segments ?? []).map((s: any) => s.text).join('');
  expect(text).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/); // real Japanese recognition output
  expect(text).toContain('弁当'); // SenseVoice (int8) output for the bundled sample is deterministic
  test.info().annotations.push({ type: 'local-asr transcript', description: text });

  await openTab(page, '文字起こし（Transcript）');
  await expect(page.getByText('ローカル', { exact: true }).first()).toBeVisible();
  await expect(page.locator('ol.segments li').first()).toBeVisible();
  await expect(page.locator('ol.segments')).toContainText(text.slice(0, 4));

  await openTab(page, '要約（Summary）');
  await expect(page.locator('section.card').filter({ has: page.locator('.card-title', { hasText: '要約' }) }).first()).toContainText('local-rules');
  const summary = await ws.get(`/meetings/${meetingId}/summary`);
  expect(summary).toMatchObject({ provider: 'local-rules' });

  // nothing left the server
  expect(fake.requests).toEqual([]);
  expect(h.srv.sql(`SELECT count(*) FROM external_calls WHERE meeting_id='${meetingId}' AND host <> '127.0.0.1'`)).toBe('0');
  expect(errors).toEqual([]);
});
