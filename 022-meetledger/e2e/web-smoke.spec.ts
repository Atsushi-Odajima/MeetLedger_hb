// Web smoke test: first-run setup in the UI → create a meeting → write notes → reload → notes are still there;
// offline notes are queued (未同期) and a newer server copy is never overwritten.
// Runs against its own isolated server (fresh DB, own port) started by ./support/test.
import { request as pwRequest, type Page } from '@playwright/test';
import { test, expect, useServer } from './support/test';

useServer({ name: 'smoke' });
const EMAIL = 'e2e-owner@example.com';
const PASSWORD = 'e2e-password-1234';

async function signIn(page: Page, needsSetup: boolean) {
  await page.goto('/');
  if (needsSetup) {
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel('名前').fill('E2E オーナー');
    await page.getByLabel('メールアドレス').fill(EMAIL);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await page.getByLabel('組織名').fill('E2E 株式会社');
    const sample = page.getByLabel(/サンプルWorkspace/);
    if (await sample.isVisible().catch(() => false)) await sample.uncheck();
    await page.getByRole('button', { name: 'セットアップを完了' }).click();
  } else {
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('メールアドレス').fill(EMAIL);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
  }
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}/);
}

test('setup → create meeting → notes → reload keeps notes', async ({ page, request }) => {
  const status = await (await request.get('/api/setup/status')).json();
  await signIn(page, !!status.needsSetup);
  const wsPath = new URL(page.url()).pathname.match(/^\/w\/[0-9a-f-]{36}/)![0];

  // Dashboard renders (calm empty states, no errors)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Create a meeting manually
  await page.goto(`${wsPath}/meetings/new`);
  const title = `E2E 定例ミーティング ${Date.now()}`;
  await page.getByLabel('タイトル').fill(title);
  await page.getByRole('button', { name: '作成して記録を始める' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}\/capture$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // Capability notice never claims system audio capture
  await expect(page.getByText('相手側の音声やシステム音声は録音できません', { exact: false })).toBeVisible();

  // Manual notes autosave with baseVersion
  const text = '決まったこと（Decision）: 見積もりは来週金曜までに送付する';
  const editor = page.getByTestId('notes-editor');
  await expect(editor).toBeEditable();
  await editor.fill(text);
  await expect(page.getByTestId('notes-status')).toContainText('保存済み');

  // Reload: the server copy is shown
  await page.reload();
  await expect(page.getByTestId('notes-editor')).toHaveValue(text);
  await expect(page.getByTestId('notes-status')).toContainText('保存済み');

  // The meeting is listed
  await page.goto(`${wsPath}/meetings`);
  await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('offline notes are queued (未同期) and a newer server copy is never overwritten', async ({ page, context, baseURL }) => {
  const status = await (await page.request.get('/api/setup/status')).json();
  await signIn(page, !!status.needsSetup);
  const wsPath = new URL(page.url()).pathname.match(/^\/w\/[0-9a-f-]{36}/)![0];
  await page.goto(`${wsPath}/meetings/new`);
  await page.getByLabel('タイトル').fill(`E2E オフライン ${Date.now()}`);
  await page.getByRole('button', { name: '作成して記録を始める' }).click();
  await expect(page).toHaveURL(/\/capture$/);
  const meetingId = page.url().match(/meetings\/([0-9a-f-]{36})/)![1];
  const editor = page.getByTestId('notes-editor');
  await editor.fill('v1');
  await expect(page.getByTestId('notes-status')).toContainText('保存済み');

  // Offline: the edit is kept on this device and shown as unsynced.
  await context.setOffline(true);
  await editor.fill('v2 オフラインで追記');
  await expect(page.getByTestId('notes-status')).toContainText('未同期');
  await expect(page.locator('.sync-badge')).toContainText('未同期');

  // Meanwhile another device saves a newer version.
  const other = await pwRequest.newContext({ baseURL });
  await other.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD }, headers: { origin: baseURL! } });
  const me = await (await other.get('/api/me')).json();
  const notesUrl = `/api${wsPath}/meetings/${meetingId}/notes`;
  const cur = await (await other.get(notesUrl)).json();
  const put = await other.put(notesUrl, { data: { body: 'v2 別の端末', baseVersion: cur.mine.version }, headers: { 'x-csrf-token': me.csrfToken, origin: baseURL! } });
  expect(put.status()).toBe(200);

  // Back online: the queue replays, detects the conflict and keeps the server copy untouched.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('ほかの端末でメモが更新されています')).toBeVisible();
  expect((await (await other.get(notesUrl)).json()).mine.body).toBe('v2 別の端末');

  // The user chooses to keep both.
  await page.getByRole('button', { name: '両方を残して結合' }).click();
  await expect(page.getByTestId('notes-status')).toContainText('保存済み');
  const merged = (await (await other.get(notesUrl)).json()).mine.body as string;
  expect(merged).toContain('v2 オフラインで追記');
  expect(merged).toContain('v2 別の端末');
  await other.dispose();
});

test('settings: license screen and write connectors (credentials are never shown back)', async ({ page, request }) => {
  const status = await (await request.get('/api/setup/status')).json();
  await signIn(page, !!status.needsSetup);
  const wsPath = new URL(page.url()).pathname.match(/^\/w\/[0-9a-f-]{36}/)![0];

  // このアプリについて・ライセンス
  await page.goto(`${wsPath}/settings`);
  await page.getByRole('link', { name: 'このアプリについて・ライセンス' }).click();
  const sense = page.getByTestId('model-sense-voice');
  await expect(sense).toContainText('SenseVoiceSmall');
  await expect(sense).toContainText('FunASR Model Open Source License Agreement v1.1');
  await expect(sense).toContainText('Converted to ONNX by k2-fsa/sherpa-onnx');
  await expect(page.getByTestId('model-3d-speaker')).toContainText('ライセンス要確認');
  await page.getByRole('button', { name: 'ここに全文を表示' }).click();
  await expect(page.locator('pre.notices-text')).toContainText('THIRD_PARTY_NOTICES');

  // 送信先コネクタ: Slack incoming webhook + HubSpot token are accepted, stored, and never displayed again
  await page.getByRole('link', { name: 'コネクタ', exact: true }).click();
  const form = page.locator('#write-connectors');
  const hook = 'https://hooks.slack.com/services/T0000/B0000/e2eSecretPart';
  await form.getByLabel('種類').selectOption({ label: 'Slack（Incoming Webhook）' });
  await form.getByLabel('Slack Incoming Webhook のURL').fill(hook);
  await form.getByLabel('チャンネル名（表示用）').fill('#sales');
  await form.getByRole('button', { name: '送信先を追加' }).click();
  await expect(page.getByText('送信先を追加しました')).toBeVisible();
  await form.getByLabel('種類').selectOption({ label: 'HubSpot' });
  await form.getByLabel('HubSpot のアクセストークン').fill('pat-na1-e2e-secret-token');
  await form.getByRole('button', { name: '送信先を追加' }).click();
  const connected = page.locator('section.card').filter({ has: page.locator('.card-title', { hasText: '接続中' }) });
  await expect(connected.locator('li.item')).toHaveCount(2);
  await page.reload();
  const html = await page.content();
  expect(html).not.toContain('e2eSecretPart');
  expect(html).not.toContain('pat-na1-e2e-secret-token');
  const api = await (await page.context().request.get(`/api${wsPath}/connectors`)).text();
  expect(api).toContain('"provider":"hubspot"');
  expect(api).not.toContain('e2eSecretPart');
  expect(api).not.toContain('pat-na1-e2e-secret-token');
});
