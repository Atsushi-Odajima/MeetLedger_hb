// E2E-3: an Action without an owner stays an unassigned candidate (no automatic assignment)
//        -> a human assigns owner + due date -> the due-date reminder is delivered (followup.tick) -> marked Done.
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { OWNER, tokyoDate, waitFor } from './support/api';
import { candidates, jstAt, meetingWithTranscript } from './support/flows';
import { candidateCard } from './support/ui';

const h = useServer({ name: 'e2e03' });

/** Runs one notification tick: inserts a `followup.tick` system job and waits for the worker to finish it. */
async function followupTick(label: string) {
  const key = `e2e-tick-${label}-${Date.now()}`;
  h.srv.sql(`INSERT INTO jobs(org_id, type, idempotency_key, payload, run_after, max_attempts) VALUES (NULL, 'followup.tick', '${key}', '{}', now(), 1)`);
  await waitFor(`followup.tick ${label}`, async () => h.srv.sql(`SELECT status FROM jobs WHERE idempotency_key='${key}'`), (s) => s === 'succeeded' || s === 'failed' || s === 'dead', 30_000, 250);
  expect(h.srv.sql(`SELECT status FROM jobs WHERE idempotency_key='${key}'`)).toBe('succeeded');
}

test('unassigned action → human assigns → due reminder → done', async ({ page, api }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const { ws, userId } = await setupOwner(api);
  // Quiet hours off (start = end) and a generous hourly cap, so delivery does not depend on the time of day.
  await ws.put('/notification-prefs', { timezone: 'Asia/Tokyo', quietStart: '00:00', quietEnd: '00:00', maxPerHour: 60, emailEnabled: false });

  const m = await meetingWithTranscript(
    h,
    ws,
    { title: '見積もり打ち合わせ', scheduledStart: jstAt(0, 9), participants: [{ name: OWNER.name, email: OWNER.email }, { name: '佐藤 花子', email: 'sato@example.com' }] },
    lines('S1: 本日はありがとうございます。', 'S2: 見積書の作成が必要です。'),
  );
  const [cand] = await candidates(ws, m.id, 'action');
  expect(cand.description).toContain('見積書の作成');
  expect(cand).toMatchObject({ status: 'candidate', assigneePersonId: null, assigneeUserId: null, dueDate: null });
  expect(cand.flags.missingOwner).toBe(true);

  // A tick before review: nothing is assigned or reminded automatically.
  await followupTick('before-review');
  const stillCandidate = await ws.get(`/actions/${cand.id}`);
  expect(stillCandidate).toMatchObject({ status: 'candidate', assigneePersonId: null, assigneeUserId: null });
  expect(h.srv.sql(`SELECT count(*) FROM notifications WHERE entity_id='${cand.id}'`)).toBe('0');

  // ---- Review Inbox shows it as unassigned; the human assigns themself and sets today's due date
  await page.goto(`/w/${ws.wsId}/review?meetingId=${m.id}`);
  const card = candidateCard(page, '見積書の作成が必要です');
  await expect(card).toContainText('担当');
  await expect(card).toContainText('未設定');
  await expect(card.getByText('担当者が決まっていません')).toBeVisible();
  await card.getByRole('button', { name: '編集', exact: true }).click();
  await card.getByLabel('担当').selectOption({ label: OWNER.name });
  await card.getByLabel('期限').fill(tokyoDate(0));
  await card.getByRole('button', { name: '編集して承認' }).click();
  await expect(card).toBeHidden();
  const confirmed = await ws.get(`/actions/${cand.id}`);
  expect(confirmed).toMatchObject({ status: 'confirmed', assigneeUserId: userId, dueDate: tokyoDate(0), assigneeInferred: false });

  // ---- due-date reminder
  await followupTick('after-review');
  const notes = await waitFor('action_due notification', () => api.get('/api/notifications'), (r: any) => (r.items ?? r.notifications ?? []).some((n: any) => n.kind === 'action_due'));
  const due = (notes.items ?? notes.notifications).find((n: any) => n.kind === 'action_due');
  expect(due.title).toBe('本日が期限のAction：見積書の作成が必要です');

  await page.goto(`/w/${ws.wsId}`);
  await expect(page.getByRole('link', { name: /通知（未読 \d+ 件）/ })).toBeVisible();
  await page.getByRole('link', { name: /通知（未読 \d+ 件）/ }).click();
  const item = page.locator('li.item').filter({ hasText: '本日が期限のAction：見積書の作成が必要です' });
  await expect(item).toBeVisible();
  await item.getByRole('link', { name: /本日が期限のAction/ }).click();

  // ---- the link opens "my actions"; mark it done
  await expect(page).toHaveURL(/ledger\?.*tab=actions/);
  const row = page.locator('ul.items > li').filter({ hasText: '見積書の作成が必要です' });
  await expect(row).toBeVisible();
  await row.getByRole('checkbox', { name: '「見積書の作成が必要です」を完了にする' }).check();
  await expect(row.getByLabel('状態')).toHaveValue('done');
  await waitFor('action done', () => ws.get(`/actions/${cand.id}`), (a: any) => a.status === 'done');
  // a done action is not reminded again
  await followupTick('after-done');
  expect(h.srv.sql(`SELECT count(*) FROM notifications WHERE entity_id='${cand.id}' AND kind='action_due'`)).toBe('1');
  expect(errors).toEqual([]);
});
