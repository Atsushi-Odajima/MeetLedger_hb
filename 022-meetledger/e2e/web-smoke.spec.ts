// Web smoke test: first-run setup (or login) → create a meeting → write notes → reload → notes are still there.
// Needs a running server with the built PWA (WEB_DIST_DIR) on E2E_BASE_URL (default http://localhost:8787).
// On an already set-up database, provide the owner credentials with E2E_EMAIL / E2E_PASSWORD.
import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL ?? 'e2e-owner@example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-1234';

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
