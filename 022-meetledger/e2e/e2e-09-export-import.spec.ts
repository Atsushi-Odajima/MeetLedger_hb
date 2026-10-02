// E2E-9: full workspace export (Settings > Data) -> import into the empty workspace of a NEW tenant (self sign-up)
//        -> meetings, decisions (including the supersede link), actions and commitments match.
import path from 'node:path';
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { Api, OWNER, Ws, tokyoDate, waitFor } from './support/api';
import { candidates, jstAt, meetingWithTranscript } from './support/flows';

const h = useServer({ name: 'e2e09', env: { ALLOW_SIGNUP: 'true' } });
const OWNER_B = { name: '高橋 三郎', email: 'owner-b@e2e.example.com', password: 'e2e-password-5678', orgName: 'E2E移行先株式会社' };

/** Comparable snapshot of a workspace's ledger (ids replaced by meeting titles / decision texts). */
async function snapshot(ws: Ws) {
  const meetings = (await ws.get('/meetings?limit=200')).items;
  const title = new Map<string, string>(meetings.map((m: any) => [m.id, m.title]));
  const decisions = (await ws.get('/decisions?view=all&limit=200')).items;
  const dText = new Map<string, string>(decisions.map((d: any) => [d.id, d.text]));
  const actions = (await ws.get('/actions?limit=200')).items;
  const commitments = (await ws.get('/commitments?limit=200')).items;
  const by = <T,>(l: T[], k: (x: T) => string) => [...l].sort((a, b) => k(a).localeCompare(k(b)));
  return {
    meetings: by(meetings, (m: any) => m.title).map((m: any) => ({ title: m.title, scheduledStart: m.scheduledStart, status: m.status })),
    decisions: by(decisions, (d: any) => d.text).map((d: any) => ({
      text: d.text,
      status: d.status,
      reviewState: d.reviewState,
      meeting: title.get(d.meetingId) ?? null,
      supersedes: d.supersedesDecisionId ? (dText.get(d.supersedesDecisionId) ?? 'MISSING') : null,
      supersededBy: d.supersededByDecisionId ? (dText.get(d.supersededByDecisionId) ?? 'MISSING') : null,
    })),
    actions: by(actions, (a: any) => a.description).map((a: any) => ({ description: a.description, status: a.status, dueDate: a.dueDate, meeting: title.get(a.meetingId) ?? null })),
    commitments: by(commitments, (c: any) => c.description).map((c: any) => ({
      description: c.description,
      status: c.status,
      dueDate: c.dueDate,
      promisedBy: c.promisedByText ?? null,
      meeting: title.get(c.meetingId) ?? null,
    })),
  };
}

test('export a workspace and restore it into a new tenant', async ({ page, api, browser }) => {
  test.setTimeout(150_000);
  const errors = trackPageErrors(page);

  // ---- tenant A with a small but linked ledger
  const { ws } = await setupOwner(api);
  const people = [{ name: OWNER.name, email: OWNER.email }, { name: '佐藤 花子', email: 'sato@example.com' }];
  const m1 = await meetingWithTranscript(h, ws, { title: 'D社 定例 #1', scheduledStart: jstAt(-14), participants: people }, lines('S1: 公開日は10月にします。', 'S2: 見積書の作成が必要です。', 'S2: 資料をお送りします。'));
  const sato = (await ws.get('/people')).items.find((p: any) => p.email === 'sato@example.com');
  for (const c of await candidates(ws, m1.id)) {
    if (c.type === 'decision') await ws.post(`/review/decision/${c.id}/accept`, {});
    if (c.type === 'action') await ws.post(`/review/action/${c.id}/accept`, { edits: { assigneePersonId: sato.id, dueDate: tokyoDate(7) } });
    if (c.type === 'commitment') await ws.post(`/review/commitment/${c.id}/accept`, { edits: { dueDate: tokyoDate(2) } });
  }
  const m2 = await meetingWithTranscript(h, ws, { title: 'D社 定例 #2', scheduledStart: jstAt(-3), participants: people }, lines('S1: 公開日は11月に変更します。'));
  const contradiction = await waitFor('contradiction', () => ws.get('/contradictions'), (r: any) => (r.items ?? []).length === 1);
  await ws.post(`/contradictions/${contradiction.items[0].id}/resolve`, { resolution: 'change' });
  expect(m2.id).toBeTruthy();

  const before = await snapshot(ws);
  expect(before.meetings).toHaveLength(2);
  expect(before.decisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: '公開日は10月にします', status: 'superseded', supersededBy: '公開日は11月に変更します', meeting: 'D社 定例 #1' }),
      expect.objectContaining({ text: '公開日は11月に変更します', status: 'active', supersedes: '公開日は10月にします', meeting: 'D社 定例 #2' }),
    ]),
  );
  expect(before.commitments).toHaveLength(1);
  expect(before.actions).toHaveLength(1);

  // ---- Settings > Data: full export, downloaded through the browser
  await page.goto(`/w/${ws.wsId}/settings/data`);
  await page.getByRole('button', { name: 'エクスポートを開始' }).click();
  const link = page.getByRole('link', { name: 'ダウンロード' });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^meetledger-workspace-export-.*\.json$/);
  const file = path.join(h.work, download.suggestedFilename());
  await download.saveAs(file);

  // ---- a NEW tenant signs up in another browser and restores the export into its empty workspace
  const ctxB = await browser.newContext({ baseURL: h.srv.url, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const pageB = await ctxB.newPage();
  const errorsB = trackPageErrors(pageB);
  await pageB.goto('/login');
  await pageB.getByRole('link', { name: '新しく作成' }).click();
  await expect(pageB.getByRole('heading', { name: 'アカウントを作成' })).toBeVisible();
  await pageB.getByLabel('名前').fill(OWNER_B.name);
  await pageB.getByLabel('メールアドレス').fill(OWNER_B.email);
  await pageB.getByLabel('パスワード').fill(OWNER_B.password);
  await pageB.getByLabel('組織名').fill(OWNER_B.orgName);
  await pageB.getByRole('button', { name: 'アカウントを作成' }).click();
  await expect(pageB).toHaveURL(/\/w\/[0-9a-f-]{36}/);
  const wsB = /\/w\/([0-9a-f-]{36})/.exec(pageB.url())![1];
  expect(wsB).not.toBe(ws.wsId);
  const apiB = Api.of(pageB, h.srv.url);
  const meB = await apiB.me();
  expect(meB.orgs.map((o: any) => o.id)).not.toContain((await api.me()).orgs[0].id); // a separate tenant
  const wB = new Ws(apiB, wsB);
  expect((await wB.get('/meetings')).items).toEqual([]);
  await expect(apiB.get(`/api/w/${ws.wsId}/meetings`)).rejects.toThrow(/-> 40[34]/); // tenant isolation

  await pageB.goto(`/w/${wsB}/settings/data`);
  await pageB.locator('#import-file').setInputFiles(file);
  const start = pageB.getByRole('button', { name: '復元を開始' });
  await expect(start).toBeDisabled();
  await pageB.getByRole('checkbox', { name: 'このWorkspaceが空であることを確認しました' }).check();
  await start.click();
  const result = pageB.getByTestId('import-result');
  await expect(result).toContainText('Meeting：2件', { timeout: 60_000 });
  await expect(result).toContainText('決まったこと：2件');
  await expect(result).toContainText('約束：1件');

  // ---- relations survived the move
  const after = await snapshot(wB);
  expect(after).toEqual(before);

  // and the UI of tenant B shows the change history
  await pageB.goto(`/w/${wsB}/ledger?tab=decisions`);
  const current = pageB.locator('ul.items > li').filter({ hasText: '公開日は11月に変更します' });
  await expect(current).toContainText('変更あり');
  await current.getByRole('button', { name: '変更履歴を見る' }).click();
  const history = current.getByRole('list', { name: '決定の変更履歴' });
  await expect(history.locator('li').first()).toContainText('公開日は10月にします');
  await expect(history.locator('li').first()).toContainText('変更済み（以前の決定）');
  // importing again into the now non-empty workspace is refused
  await expect(apiB.call('POST', `/api/w/${wsB}/import/full`, undefined, { multipart: { file: { name: 'again.json', mimeType: 'application/json', buffer: (await import('node:fs')).readFileSync(file) } } })).rejects.toThrow(/-> 409|-> 400/);

  expect(errors).toEqual([]);
  expect(errorsB).toEqual([]);
  await ctxB.close();
});
