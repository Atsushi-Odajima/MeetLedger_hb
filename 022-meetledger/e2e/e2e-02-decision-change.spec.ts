// E2E-2: 「公開日は10月にします」 confirmed -> next meeting 「公開日は11月に変更します」 -> Review Inbox asks 「変更ですか？」
//        -> human confirms the change -> the old decision is Superseded in the history, the current view shows the new one.
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { OWNER, waitFor } from './support/api';
import { candidates, jstAt, meetingWithTranscript } from './support/flows';
import { candidateCard } from './support/ui';

const h = useServer({ name: 'e2e02' });

test('decision change is detected, confirmed by a human and kept in the history', async ({ page, api }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const { ws } = await setupOwner(api);
  const people = [{ name: OWNER.name, email: OWNER.email }, { name: '佐藤 花子', email: 'sato@example.com' }];

  // ---- meeting 1: decision "October", confirmed by a human in the Review Inbox
  const m1 = await meetingWithTranscript(h, ws, { title: 'リリース計画 #1', scheduledStart: jstAt(-7), participants: people }, lines('S1: 公開日は10月にします。', 'S2: 承知しました。'));
  await page.goto(`/w/${ws.wsId}/review?meetingId=${m1.id}`);
  const oct = candidateCard(page, '公開日は10月にします');
  await expect(oct).toBeVisible();
  await oct.getByRole('button', { name: '承認', exact: true }).click();
  await expect(oct).toBeHidden();
  const [octDecision] = (await ws.get('/decisions?view=current')).items.filter((d: any) => d.text.includes('10月'));
  expect(octDecision).toMatchObject({ reviewState: 'confirmed', status: 'active' });

  // ---- meeting 2: "changed to November" -> contradiction candidate, nothing changes automatically
  const m2 = await meetingWithTranscript(h, ws, { title: 'リリース計画 #2', scheduledStart: jstAt(-1), participants: people }, lines('S1: 前回の確認です。', 'S1: 公開日は11月に変更します。'));
  const [novCandidate] = await candidates(ws, m2.id, 'decision');
  expect(novCandidate.text).toContain('11月');
  await waitFor('contradiction candidate', () => ws.get('/contradictions'), (r: any) => (r.items ?? []).length > 0);
  expect((await ws.get(`/decisions/${octDecision.id}`)).status).toBe('active'); // AI never supersedes on its own

  await page.goto(`/w/${ws.wsId}/review`);
  const card = page.locator('article.contradiction');
  await expect(card).toBeVisible();
  await expect(card).toContainText('変更ですか？');
  await expect(card).toContainText('公開日は10月にします');
  await expect(card).toContainText('公開日は11月に変更します');
  await card.getByRole('button', { name: 'はい（変更）' }).click();
  await expect(card).toBeHidden();

  // ---- ledger: current view shows November only; the history keeps October as superseded
  await page.goto(`/w/${ws.wsId}/ledger?tab=decisions`);
  const current = page.locator('ul.items > li').filter({ hasText: '公開日は11月に変更します' });
  await expect(current).toBeVisible();
  await expect(current).toContainText('有効');
  await expect(current).toContainText('変更あり');
  await expect(page.locator('ul.items > li').filter({ hasText: '公開日は10月にします' })).toHaveCount(0);
  await current.getByRole('button', { name: '変更履歴を見る' }).click();
  const history = current.getByRole('list', { name: '決定の変更履歴' });
  await expect(history.locator('li')).toHaveCount(2);
  await expect(history.locator('li').nth(0)).toContainText('公開日は10月にします');
  await expect(history.locator('li').nth(0)).toContainText('変更済み（以前の決定）');
  await expect(history.locator('li').nth(0)).toContainText('リリース計画 #1');
  await expect(history.locator('li').nth(1)).toContainText('公開日は11月に変更します');
  await expect(history.locator('li').nth(1)).toContainText('有効');

  await page.getByLabel('表示').selectOption({ label: '変更前のもの' });
  const old = page.locator('ul.items > li').filter({ hasText: '公開日は10月にします' });
  await expect(old).toContainText('変更済み（以前の決定）');

  // dashboard surfaces the change
  await page.goto(`/w/${ws.wsId}`);
  await expect(page.locator('#dash-changed')).toContainText('公開日は11月に変更します');

  // ---- API: supersede link in both directions
  const before = await ws.get(`/decisions/${octDecision.id}`);
  const after = await ws.get(`/decisions/${before.supersededByDecisionId}`);
  expect(before.status).toBe('superseded');
  expect(after).toMatchObject({ status: 'active', reviewState: 'confirmed', supersedesDecisionId: octDecision.id });
  expect(after.text).toContain('11月');
  expect(after.meetingId).toBe(m2.id);
  expect(errors).toEqual([]);
});
