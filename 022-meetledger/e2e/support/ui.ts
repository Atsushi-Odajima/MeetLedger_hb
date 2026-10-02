import { expect, type Locator, type Page } from '@playwright/test';

/** Click a meeting tab ("ブリーフ（Brief）" etc.) in the meeting tab bar. */
export async function openTab(page: Page, label: string | RegExp) {
  await page.getByRole('navigation', { name: 'Meetingの表示切り替え' }).getByRole('link', { name: label }).click();
}

/** Capture tab: choose a file, confirm the participant notice (consent) dialog and upload. */
export async function uploadWithConsent(page: Page, file: string, method = '口頭で伝えた') {
  await page.locator('#media-file').setInputFiles(file);
  await page.locator('#file-upload').getByRole('button', { name: 'アップロード' }).click();
  const dlg = page.getByRole('dialog', { name: 'アップロードする前に（参加者への通知）' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('radio', { name: method }).check();
  const confirm = dlg.getByRole('button', { name: '通知を記録してアップロード' });
  await expect(confirm).toBeDisabled();
  await dlg.getByRole('checkbox', { name: '録音時に、参加者全員へ録音・文字起こし・AI処理・保存期間を伝えました' }).check();
  await confirm.click();
  await expect(dlg).toBeHidden();
  return dlg;
}

/** A candidate card in the Review Inbox, found by its text. */
export function candidateCard(page: Page, text: string): Locator {
  return page.locator('article.review-card').filter({ hasText: text });
}

/** A Card (section) by its heading text. */
export function cardByTitle(page: Page | Locator, title: string | RegExp): Locator {
  return page.locator('section.card').filter({ has: page.locator('.card-title', { hasText: title }) });
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
