// E2E-8: Mobile (iPhone 15 / Pixel 8 viewports, emulated in Chromium): manifest + service worker
//        -> Upcoming / Brief / My Actions visible -> offline: cached views render and an Action status change is kept as
//        「未同期」 -> back online it syncs -> a desktop session sees the result and reviews a meeting.
import { devices, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { Api, OWNER, Ws, tokyoDate, waitFor } from './support/api';
import { candidates, jstAt, meetingWithTranscript } from './support/flows';
import { candidateCard, expectNoHorizontalScroll } from './support/ui';

const h = useServer({ name: 'e2e08' });
test.describe.configure({ mode: 'serial' });

let ws: Ws;
let apiCtx: APIRequestContext;
test.afterAll(async () => apiCtx?.dispose());
const data: { upcomingId: string; reviewId: string; actions: Record<string, string> } = { upcomingId: '', reviewId: '', actions: {} };
const DEVICES = ['iPhone 15', 'Pixel 8'] as const;
const ACTION_TEXT: Record<(typeof DEVICES)[number], string> = { 'iPhone 15': 'デモ環境の準備が必要です', 'Pixel 8': '見積書の作成が必要です' };

async function mobileContext(browser: Browser, name: (typeof DEVICES)[number]): Promise<BrowserContext> {
  // WebKit is not installed in this environment: emulate the device viewport/UA/touch in Chromium.
  const { defaultBrowserType: _ignored, ...descriptor } = devices[name];
  const ctx = await browser.newContext({ ...descriptor, baseURL: h.srv.url, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'allow' });
  const r = await ctx.request.post(`${h.srv.url}/api/auth/login`, { data: { email: OWNER.email, password: OWNER.password }, headers: { origin: h.srv.url } });
  expect(r.ok()).toBe(true);
  return ctx;
}

async function swControlled(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
}

test('prepare: meetings, my actions and a meeting waiting for review', async ({ api }) => {
  const s = await setupOwner(api);
  // a long-lived API session for the following tests (each test gets its own browser context)
  apiCtx = await request.newContext();
  const longLived = new Api(apiCtx, h.srv.url);
  await longLived.login();
  ws = new Ws(longLived, s.ws.wsId);
  const people = [{ name: OWNER.name, email: OWNER.email }, { name: '田中 次郎', email: 'tanaka@client.example.com' }];
  const prev = await meetingWithTranscript(h, ws, { title: 'C社 定例（前回）', scheduledStart: jstAt(-7), participants: people }, lines('S1: デモ環境の準備が必要です。', 'S1: 見積書の作成が必要です。', 'S2: 公開日は10月にします。'));
  for (const a of await candidates(ws, prev.id, 'action')) {
    await ws.post(`/review/action/${a.id}/accept`, { edits: { assigneeUserId: s.userId, dueDate: tokyoDate(3) } });
    data.actions[a.description] = a.id;
  }
  const [d] = await candidates(ws, prev.id, 'decision');
  await ws.post(`/review/decision/${d.id}/accept`, {});
  const upcoming = await ws.createMeeting({ title: 'C社 定例（次回）', scheduledStart: jstAt(1, 15), participants: people, transcriptionMode: 'local' });
  data.upcomingId = upcoming.id;
  const review = await meetingWithTranscript(h, ws, { title: '社内レビュー会', scheduledStart: jstAt(-1), participants: people.slice(0, 1) }, lines('S1: 価格は据え置きにします。'));
  data.reviewId = review.id;
  expect(Object.keys(data.actions)).toHaveLength(2);
});

for (const device of DEVICES) {
  test(`mobile ${device}: PWA, offline views and 未同期 sync`, async ({ browser }) => {
    test.setTimeout(150_000);
    const ctx = await mobileContext(browser, device);
    const page = await ctx.newPage();
    const errors = trackPageErrors(page);
    const actionText = ACTION_TEXT[device];
    const actionId = data.actions[actionText];

    // ---- installable PWA: manifest + service worker
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/w/${ws.wsId}`));
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await page.request.get(new URL(manifestHref!, h.srv.url).toString())).json();
    expect(manifest).toMatchObject({ name: 'MeetLedger', display: 'standalone', start_url: '/', theme_color: '#0F4C5C', background_color: '#F6F9F9' });
    expect(manifest.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    await swControlled(page);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL)).toMatch(/\/sw\.js$/);

    // ---- online: Upcoming / My Actions / Brief (these responses are what the SW keeps for offline use)
    await page.reload();
    await expect(page.locator('.bottom-nav')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('#dash-upcoming')).toContainText('C社 定例（次回）');
    await expect(page.locator('#dash-actions')).toContainText(actionText);
    await expectNoHorizontalScroll(page);
    await page.locator('#dash-upcoming').getByRole('link', { name: 'C社 定例（次回）' }).click();
    await expect(page).toHaveURL(new RegExp(`/meetings/${data.upcomingId}`));
    await page.getByRole('navigation', { name: 'Meetingの表示切り替え' }).getByRole('link', { name: 'ブリーフ（Brief）' }).click();
    await expect(page.locator('#brief-openActions')).toContainText(actionText);
    await expect(page.locator('#brief-decisions')).toContainText('公開日は10月にします');
    await expectNoHorizontalScroll(page);
    await page.goto(`/w/${ws.wsId}/ledger?tab=actions&assignee=me`);
    const row = page.locator('ul.items > li').filter({ hasText: actionText });
    await expect(row).toBeVisible();

    // ---- offline: the server goes away and the device loses its connection
    await h.srv.kill();
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.locator('.banner-offline')).toBeVisible();
    await expect(page.getByText(/オフライン保存データ（.+ 時点）を表示しています/).first()).toBeVisible();
    await expect(row).toBeVisible();
    // cached Home (Upcoming + My Actions) and the cached Brief
    await page.locator('.bottom-nav').getByRole('link', { name: 'ホーム' }).click();
    await expect(page.locator('#dash-upcoming')).toContainText('C社 定例（次回）');
    await expect(page.locator('#dash-actions')).toContainText(actionText);
    await page.locator('#dash-upcoming').getByRole('link', { name: 'C社 定例（次回）' }).click();
    await page.getByRole('navigation', { name: 'Meetingの表示切り替え' }).getByRole('link', { name: 'ブリーフ（Brief）' }).click();
    await expect(page.locator('#brief-openActions')).toContainText(actionText);

    // offline status change -> kept on the device as 「未同期」
    await page.goto(`/w/${ws.wsId}/ledger?tab=actions&assignee=me`); // full navigation, served by the service worker
    await expect(row).toBeVisible();
    await row.getByRole('checkbox', { name: `「${actionText}」を完了にする` }).check();
    await expect(page.getByText('オフラインのため端末に保存しました（未同期）')).toBeVisible();
    await expect(row.getByText('未同期')).toBeVisible();
    const badge = page.locator('.topbar').getByRole('button', { name: /未同期 1/ });
    await expect(badge).toBeVisible();

    // ---- back online: the queue is replayed automatically
    await h.srv.restart();
    expect((await ws.get(`/actions/${actionId}`)).status).toBe('confirmed'); // the device has not reached the server yet
    await ctx.setOffline(false);
    await expect(badge).toBeHidden({ timeout: 30_000 });
    await expect(row.getByText('未同期')).toHaveCount(0);
    await waitFor('synced action', () => ws.get(`/actions/${actionId}`), (a: any) => a.status === 'done');
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test('desktop: sees the synced changes and reviews a meeting', async ({ page }) => {
  const errors = trackPageErrors(page);
  // fresh desktop session
  const r = await page.context().request.post(`${h.srv.url}/api/auth/login`, { data: { email: OWNER.email, password: OWNER.password }, headers: { origin: h.srv.url } });
  expect(r.ok()).toBe(true);
  await page.goto(`/w/${ws.wsId}/ledger?tab=actions`);
  for (const text of Object.values(ACTION_TEXT)) {
    const row = page.locator('ul.items > li').filter({ hasText: text });
    await expect(row.getByLabel('状態')).toHaveValue('done');
  }
  await page.goto(`/w/${ws.wsId}/review?meetingId=${data.reviewId}`);
  const card = candidateCard(page, '価格は据え置きにします');
  await card.getByRole('button', { name: '承認', exact: true }).click();
  await expect(card).toBeHidden();
  await page.goto(`/w/${ws.wsId}/meetings/${data.reviewId}/ledger`);
  await expect(page.getByText('価格は据え置きにします')).toBeVisible();
  expect(errors).toEqual([]);
});
