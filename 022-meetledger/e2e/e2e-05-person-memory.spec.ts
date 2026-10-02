// E2E-5: People -> person -> Timeline shows past meetings / decisions / promises with source citations
//        (meeting title + date + link to the transcript), and Search finds them with title/date/timestamp citations.
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines } from './support/audio';
import { OWNER, waitFor } from './support/api';
import { candidates, jstAt, meetingWithTranscript } from './support/flows';

const h = useServer({ name: 'e2e05' });

test('person timeline and search cite their sources', async ({ page, api }) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const { ws } = await setupOwner(api);
  const customer = { name: '鈴木 一郎', email: 'suzuki@client.example.com' };
  const people = [{ name: OWNER.name, email: OWNER.email }, customer];

  const m1 = await meetingWithTranscript(h, ws, { title: 'B社 定例 #1', scheduledStart: jstAt(-14, 11), participants: people }, lines('S1: 本日の議題です。', 'S2: 公開日は10月にします。'));
  const m2 = await meetingWithTranscript(h, ws, { title: 'B社 定例 #2', scheduledStart: jstAt(-3, 11), participants: people }, lines('S1: 前回の続きです。', 'S2: 来週までに資料をお送りします。'));

  // speaker 2 of meeting 2 is the customer (mapped by a human; E2E-4 covers doing this in the UI) -> re-extract
  const suzuki = (await ws.get('/people')).items.find((p: any) => p.email === customer.email);
  const sp = (await ws.get(`/meetings/${m2.id}/speakers`)).items.find((s: any) => s.label === 'Speaker 2');
  await ws.patch(`/meetings/${m2.id}/speakers/${sp.id}`, { personId: suzuki.id });
  await ws.post(`/meetings/${m2.id}/extract`, { rerun: true });
  const [commitment] = await waitFor('commitment by the customer', () => candidates(ws, m2.id, 'commitment'), (l) => l.length === 1 && l[0].promisedByPersonId === suzuki.id);
  const [decision] = await candidates(ws, m1.id, 'decision');
  await ws.post(`/review/decision/${decision.id}/accept`, {});
  await ws.post(`/review/commitment/${commitment.id}/accept`, { confirmInferred: true });

  // ---- People -> person
  await page.goto(`/w/${ws.wsId}/people`);
  await page.getByRole('link', { name: customer.name }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: customer.name })).toBeVisible();
  const timeline = page.locator('section.card').filter({ has: page.locator('.card-title', { hasText: 'これまでの流れ（Timeline）' }) });
  const items = timeline.locator('li.timeline-item');
  await expect(items.filter({ hasText: 'B社 定例 #1' }).first()).toBeVisible();

  // meetings
  await expect(items.filter({ has: page.locator(`a[href$="/meetings/${m1.id}"]`) })).toHaveCount(1);
  await expect(items.filter({ has: page.locator(`a[href$="/meetings/${m2.id}"]`) })).toHaveCount(1);
  // decision with citation (source meeting title + date + link to its transcript)
  const d = items.filter({ hasText: '公開日は10月にします' });
  await expect(d).toHaveCount(1);
  await expect(d).toContainText('決まったこと');
  const dLink = d.locator('a.source-link');
  await expect(dLink).toContainText('B社 定例 #1');
  await expect(dLink.locator('.muted')).not.toBeEmpty();
  await expect(dLink).toHaveAttribute('href', new RegExp(`/meetings/${m1.id}/transcript`));
  // promise made by this person
  const c = items.filter({ hasText: '資料をお送りします' });
  await expect(c).toContainText('この人がした約束');
  await expect(c.locator('a.source-link')).toContainText('B社 定例 #2');
  // newest first: meeting #2 before meeting #1
  const order = await items.allInnerTexts();
  expect(order.findIndex((x) => x.includes('資料をお送りします'))).toBeLessThan(order.findIndex((x) => x.includes('公開日は10月にします')));

  // following the citation opens the transcript of the source meeting
  await dLink.click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${m1.id}/transcript`));
  await expect(page.getByText('公開日は10月にします。')).toBeVisible();

  // ---- Search: filtered by the person, results cite meeting title, date and timestamp
  await waitFor('search index', () => ws.get(`/search?q=${encodeURIComponent('資料')}&personId=${suzuki.id}`), (r: any) => (r.hits ?? r.results ?? r.items ?? []).length > 0);
  await page.goto(`/w/${ws.wsId}/search`);
  await page.getByLabel('キーワード').fill('資料');
  await page.locator('summary', { hasText: '絞り込み' }).click();
  await page.getByLabel('人（People）', { exact: true }).selectOption({ label: customer.name });
  await page.getByRole('button', { name: '検索', exact: true }).click();
  const results = page.locator('ol.results > li.result');
  await expect(results.first()).toBeVisible();
  const hit = results.filter({ hasText: 'B社 定例 #2' }).filter({ has: page.locator('.timestamp') }).first();
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark').first()).toHaveText('資料');
  await expect(hit.locator('.timestamp')).toContainText('0:04');
  await hit.locator('a.result-title').click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${m2.id}/transcript\\?t=4000`));
  expect(errors).toEqual([]);
});
