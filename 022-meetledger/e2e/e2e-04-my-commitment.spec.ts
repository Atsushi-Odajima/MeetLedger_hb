// E2E-4: 「資料をお送りします」 said by me (speaker mapped to me by a human) -> confirmed with a due date in the past (overdue)
//        -> the next meeting with the same customer lists it in its Brief under "my open commitments".
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { OWNER, tokyoDate, waitFor } from './support/api';
import { candidates, jstAt, meetingWithTranscript } from './support/flows';
import { candidateCard, openTab } from './support/ui';

const h = useServer({ name: 'e2e04' });

test('my commitment becomes overdue and shows up in the next brief', async ({ page, api }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const { ws, userId } = await setupOwner(api);
  const customer = { name: '鈴木 一郎', email: 'suzuki@client.example.com' };

  const m1 = await meetingWithTranscript(
    h,
    ws,
    { title: 'A社 提案打ち合わせ', scheduledStart: jstAt(-10, 14), participants: [{ name: OWNER.name, email: OWNER.email }, customer] },
    lines('S1: 本日はお時間をいただきありがとうございます。', 'S2: 前向きに検討します。', 'S1: 資料をお送りします。'),
  );
  const [before] = await candidates(ws, m1.id, 'commitment');
  expect(before.description).toContain('資料をお送りします');
  expect(before.promisedByPersonId).toBeNull(); // the speaker is not identified yet: no guessing

  // ---- a human maps "Speaker 1" to themself in the transcript and re-extracts the candidates
  await page.goto(`/w/${ws.wsId}/meetings/${m1.id}/transcript`);
  await expect(page.getByText('資料をお送りします。')).toBeVisible();
  const chip = page.locator('.speakers .speaker-chip').filter({ hasText: before.promisedByText ?? 'Speaker 1' });
  await chip.click();
  const dlg = page.getByRole('dialog', { name: /話者「/ });
  await dlg.getByLabel('人（People）と対応づける').selectOption({ label: OWNER.name });
  await dlg.getByRole('button', { name: '保存' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('.speakers')).toContainText(OWNER.name);
  await page.getByRole('button', { name: '候補を抽出し直す' }).click();
  await expect(page.getByText('候補の抽出を開始しました')).toBeVisible();
  const [mapped] = await waitFor('re-extracted commitment', () => candidates(ws, m1.id, 'commitment'), (l) => l.length === 1 && !!l[0].promisedByPersonId);
  expect(mapped.promisedByUserId ?? null).toBe(userId);

  // ---- confirm it with a due date that has already passed
  await page.goto(`/w/${ws.wsId}/review?meetingId=${m1.id}`);
  const card = candidateCard(page, '資料をお送りします');
  await expect(card).toContainText(OWNER.name);
  await card.getByRole('button', { name: '編集', exact: true }).click();
  await card.getByLabel('期限').fill(tokyoDate(-3));
  await card.getByRole('button', { name: '編集して承認' }).click();
  await expect(card).toBeHidden();
  const c = await ws.get(`/commitments/${mapped.id}`);
  expect(c).toMatchObject({ status: 'open', dueDate: tokyoDate(-3), overdue: true, direction: 'mine' });

  // dashboard: "my commitments" + overdue
  await page.goto(`/w/${ws.wsId}`);
  await expect(page.locator('#dash-commitments')).toContainText('資料をお送りします');
  await expect(page.locator('#dash-overdue')).toContainText('資料をお送りします');

  // ---- next meeting with the same customer, created in the UI
  await page.goto(`/w/${ws.wsId}/meetings/new`);
  await page.getByLabel('タイトル').fill('A社 提案打ち合わせ（2回目）');
  await page.getByLabel('開始日時').fill(`${tokyoDate(1)}T15:00`);
  const who = page.getByLabel('参加者', { exact: true });
  await who.fill(`${customer.name} <${customer.email}>`);
  await who.press('Enter');
  await expect(page.locator('.chips')).toContainText(customer.name);
  await page.getByRole('button', { name: '作成して記録を始める' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}\/capture/);
  await openTab(page, 'ブリーフ（Brief）');

  const mine = page.locator('#brief-myCommitments');
  await expect(mine).toBeVisible();
  await expect(mine).toContainText('自分の未完了の約束');
  await expect(mine).toContainText('資料をお送りします');
  await expect(mine).toContainText('期限を過ぎています');
  await expect(page.locator('#brief-theirCommitments')).toHaveCount(0);
  // the brief cites where the promise was made (link to the source meeting's transcript)
  await expect(mine.locator('a.source-link')).toHaveAttribute('href', new RegExp(`/meetings/${m1.id}/transcript`));
  expect(errors).toEqual([]);
});
