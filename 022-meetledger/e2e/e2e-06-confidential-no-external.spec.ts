// E2E-6: a Confidential (AI OFF) meeting never reaches external AI / transcription services, even when the
//        workspace allows cloud processing. A local fake OpenAI-compatible server counts every request; a normal cloud
//        meeting afterwards is the positive control proving the counter works.
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { waitFor } from './support/api';
import { cloudEnv, startFakeExternal, type FakeExternal } from './support/fakeExternal';
import { fixtureWav, uploadViaApi } from './support/flows';
import { uploadWithConsent } from './support/ui';

let fake: FakeExternal;
const h = useServer(async () => {
  fake = await startFakeExternal();
  return { name: 'e2e06', env: cloudEnv(fake) };
});
test.afterAll(async () => fake?.close());

/** No queued/running tenant jobs left (transcription, AI, indexing...). */
async function settled() {
  await waitFor('jobs to settle', async () => h.srv.sql(`SELECT count(*) FROM jobs WHERE org_id IS NOT NULL AND status IN ('queued','running')`), (n) => n === '0', 60_000, 300);
}

test('confidential meeting: zero external requests; cloud meeting: requests observed', async ({ page, api }) => {
  test.setTimeout(150_000);
  const errors = trackPageErrors(page);
  const { ws } = await setupOwner(api);
  // The workspace opts in to every cloud provider the installation offers (all pointed at the fake).
  await ws.patch('/settings', { transcription: { cloudAllowed: true }, ai: { provider: 'openai', cloudAllowed: true, embeddings: 'openai' }, defaults: { transcriptionMode: 'cloud' } });
  const wsPreview = await ws.get('/ai/privacy-preview');
  expect(JSON.stringify(wsPreview)).toContain(new URL(fake.url).host); // cloud really is configured for this workspace

  // ---- confidential meeting created in the UI
  await page.goto(`/w/${ws.wsId}/meetings/new`);
  await page.getByLabel('タイトル').fill('人事面談（機密）');
  await page.getByRole('switch', { name: /機密（Confidential）プリセット/ }).click();
  await expect(page.getByRole('switch', { name: /機密（Confidential）プリセット/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '作成して記録を始める' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}\/capture/);
  const meetingId = /meetings\/([0-9a-f-]{36})/.exec(page.url())![1];
  const m = await ws.meeting(meetingId);
  expect(m).toMatchObject({ isConfidential: true, aiEnabled: false, transcriptionMode: 'local' });

  // what the participants are told: nothing leaves this server
  const wav = fixtureWav(h, 'confidential', lines('S1: 評価面談を始めます。', 'S2: 異動の希望があります。', 'S1: 公開日は10月にします。'));
  await page.locator('#media-file').setInputFiles(wav);
  await page.locator('#file-upload').getByRole('button', { name: 'アップロード' }).click();
  const dlg = page.getByRole('dialog', { name: 'アップロードする前に（参加者への通知）' });
  await expect(dlg).toContainText('なし（このサーバー内で処理）');
  await expect(dlg).toContainText('AI処理は行いません（AI OFF）');
  await dlg.getByRole('button', { name: 'キャンセル' }).click();
  await uploadWithConsent(page, wav);

  await waitFor('local transcript', () => ws.processing(meetingId), (p: any) => !!p.transcript);
  await settled();
  const proc = await ws.processing(meetingId);
  expect(proc.transcript).toMatchObject({ provider: 'fixture', isLocal: true });
  expect(proc.jobs.filter((j: any) => j.type.startsWith('ai.'))).toEqual([]);

  // transcript is available, but no AI output exists for the meeting
  await page.goto(`/w/${ws.wsId}/meetings/${meetingId}/transcript`);
  await expect(page.getByText('異動の希望があります。')).toBeVisible();
  await page.goto(`/w/${ws.wsId}/meetings/${meetingId}/summary`);
  await expect(page.getByText('このMeetingはAI処理・AI検索の対象外です。')).toBeVisible();
  expect((await ws.review()).filter((x: any) => x.item.meetingId === meetingId)).toEqual([]);

  // the server's own privacy decisions agree
  const pv = await ws.get(`/ai/privacy-preview?meetingId=${meetingId}`);
  expect(pv.transcription).toMatchObject({ destination: 'local', host: null });
  expect(pv.ai).toMatchObject({ allowed: false, destination: 'none' });
  expect(pv.embedding.destination).not.toBe('cloud');
  expect(pv.ask.eligible).toBe(false);
  expect(pv.index.aiChunks).toBe(0);

  // >>> the actual guarantee: the fake external service saw nothing at all
  expect(fake.requests).toEqual([]);

  // ---- positive control: a normal meeting with cloud transcription + cloud AI does reach the fake
  const control = await ws.createMeeting({ title: '通常の定例（クラウド処理）', transcriptionMode: 'cloud', aiEnabled: true });
  const pc = await ws.get(`/ai/privacy-preview?meetingId=${control.id}`);
  expect(pc.transcription).toMatchObject({ destination: 'cloud', host: new URL(fake.url).host });
  await uploadViaApi(ws, control.id, fixtureWav(h, 'control', lines('S1: 通常の会議です。')));
  await waitFor('cloud transcription request', async () => fake.count('/audio/transcriptions'), (n) => n >= 1, 30_000);
  await waitFor('cloud transcript', () => ws.processing(control.id), (p: any) => p.transcript?.provider === 'openai' && p.transcript?.isLocal === false);
  await waitFor('cloud AI request', async () => fake.count('/responses'), (n) => n >= 1, 30_000);
  // and none of those requests belonged to the confidential meeting: its processing was finished before the control started
  expect(h.srv.sql(`SELECT count(*) FROM external_calls WHERE meeting_id='${meetingId}'`)).toBe('0');
  expect(Number(h.srv.sql(`SELECT count(*) FROM external_calls WHERE meeting_id='${control.id}'`))).toBeGreaterThan(0); // the audit trail records cloud calls
  expect(errors).toEqual([]);
});
