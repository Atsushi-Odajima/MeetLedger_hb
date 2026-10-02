// E2E-1: ICS import (Settings > Connectors) -> Pre-brief -> Capture (consent -> upload) -> Transcript -> Summary
//        -> Review Inbox -> confirm Decision / Action / Commitment -> Follow-up draft (confirmed items only)
//        -> the next meeting of the series shows them in its Brief.
import { test, expect, useServer, setupOwner, trackPageErrors } from './support/test';
import { lines, makeFixtureMeetingAudio } from './support/audio';
import { OWNER, tokyoDate, waitFor } from './support/api';
import { candidateCard, cardByTitle, openTab, uploadWithConsent } from './support/ui';

const h = useServer({ name: 'e2e01' });

const TITLE = '週次定例（E2E）';

function ics(): string {
  const d1 = tokyoDate(1).replace(/-/g, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MeetLedger E2E//JA',
    'X-WR-CALNAME:E2Eカレンダー',
    'X-WR-TIMEZONE:Asia/Tokyo',
    'BEGIN:VEVENT',
    'UID:e2e-weekly-001@example.com',
    'DTSTAMP:20261001T000000Z',
    `DTSTART;TZID=Asia/Tokyo:${d1}T100000`,
    `DTEND;TZID=Asia/Tokyo:${d1}T110000`,
    'RRULE:FREQ=WEEKLY;COUNT=2',
    `SUMMARY:${TITLE}`,
    `ORGANIZER;CN=${OWNER.name}:mailto:${OWNER.email}`,
    'ATTENDEE;CN=佐藤 花子;ROLE=REQ-PARTICIPANT:mailto:sato@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

test('ICS import → brief → capture → review → follow-up → next brief', async ({ page, api }) => {
  test.setTimeout(180_000);
  const errors = trackPageErrors(page);
  const { ws } = await setupOwner(api);

  // ---- 1. Settings > Connectors: preview the .ics file, then import both occurrences
  await page.goto(`/w/${ws.wsId}/settings/connectors`);
  const icsCard = cardByTitle(page, 'ICS（iCalendar）から取り込む');
  await icsCard.locator('#ics-file').setInputFiles({ name: 'team.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics(), 'utf8') });
  await icsCard.getByRole('button', { name: 'プレビュー' }).click();
  const preview = page.getByRole('dialog', { name: /予定のプレビュー（2件）/ });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(TITLE)).toHaveCount(2);
  await preview.getByRole('button', { name: 'すべて選択' }).click();
  await preview.getByRole('button', { name: '2件を取り込む' }).click();
  await expect(preview).toBeHidden();
  await expect(page.getByText('2件の予定を取り込みました')).toBeVisible();

  const list = (await ws.get('/meetings?limit=50')).items ?? [];
  const imported = list.filter((m: any) => m.title === TITLE).sort((a: any, b: any) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart));
  expect(imported).toHaveLength(2);
  const [m1, m2] = imported;
  expect(m1.seriesId).toBeTruthy();
  expect(m2.seriesId).toBe(m1.seriesId);
  expect(m1.source).toBe('calendar');

  // ---- 2. Pre-brief of the first occurrence (no history yet: participants + "first meeting")
  await page.goto(`/w/${ws.wsId}/meetings`);
  await expect(page.getByRole('link', { name: TITLE })).toHaveCount(2);
  await page.locator(`a[href$="/meetings/${m1.id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${m1.id}`));
  await openTab(page, 'ブリーフ（Brief）');
  const participants = cardByTitle(page, '参加者');
  await expect(participants.getByText('佐藤 花子')).toBeVisible();
  await expect(page.getByText('初めてのMeetingです')).toBeVisible();

  // ---- 3. Capture: consent dialog -> upload (deterministic Japanese transcript via the fixture provider)
  const wav = makeFixtureMeetingAudio(
    h.srv.fixturesDir,
    h.work,
    'weekly-1',
    440,
    lines(
      'S1: 本日の定例を始めます。',
      'S1: 公開日は10月にします。',
      'S2: 見積書の作成が必要です。',
      'S2: 資料をお送りします。',
      'S1: 議事録の共有が必要です。',
      'S2: 予算はまだ決まっていません。',
    ),
  );
  await openTab(page, '記録（Capture）');
  await uploadWithConsent(page, wav);
  await waitFor('transcript + extraction', () => ws.processing(m1.id), (p: any) => !!p.transcript && p.jobs.some((j: any) => j.type === 'ai.extract' && j.status === 'succeeded'));
  const consent = await h.srv.sql(`SELECT kind || ':' || state || ':' || method FROM consent_records WHERE meeting_id='${m1.id}'`);
  expect(consent).toContain('recording:notified:verbal');

  // ---- 4. Transcript + Summary
  await openTab(page, '文字起こし（Transcript）');
  await expect(page.getByText('公開日は10月にします。')).toBeVisible();
  await expect(page.getByText('資料をお送りします。')).toBeVisible();
  await openTab(page, '要約（Summary）');
  const summary = cardByTitle(page, '要約');
  await expect(summary).toContainText('公開日は10月にします');
  await expect(summary).toContainText('local-rules');

  // ---- 5. Review Inbox: candidates are NOT ledger items until a human confirms them
  await page.goto(`/w/${ws.wsId}/review?meetingId=${m1.id}`);
  const decision = candidateCard(page, '公開日は10月にします');
  const action = candidateCard(page, '見積書の作成が必要です');
  const commitment = candidateCard(page, '資料をお送りします');
  const minutes = candidateCard(page, '議事録の共有が必要です');
  const question = candidateCard(page, '予算はまだ決まっていません');
  for (const c of [decision, action, commitment, minutes, question]) await expect(c).toBeVisible();
  expect((await ws.get('/decisions')).items.filter((d: any) => d.reviewState === 'confirmed')).toHaveLength(0);

  await decision.getByRole('button', { name: '承認', exact: true }).click();
  await expect(decision).toBeHidden();

  // the action has no owner: assign it explicitly while confirming
  await expect(action.getByText('担当者が決まっていません')).toBeVisible();
  await action.getByRole('button', { name: '編集', exact: true }).click();
  await action.getByLabel('担当').selectOption({ label: '佐藤 花子' });
  await action.getByLabel('期限').fill(tokyoDate(5));
  await action.getByRole('button', { name: '編集して承認' }).click();
  await expect(action).toBeHidden();

  await commitment.getByRole('button', { name: '承認', exact: true }).click();
  await expect(commitment).toBeHidden();

  await minutes.getByRole('button', { name: '却下', exact: true }).click();
  await expect(minutes).toBeHidden();
  await expect(question).toBeVisible(); // left unreviewed on purpose

  // ---- 6. Follow-up draft contains confirmed items only
  await page.goto(`/w/${ws.wsId}/meetings/${m1.id}/followup`);
  await page.getByRole('button', { name: '下書きを作成' }).click();
  const body = page.getByLabel('本文');
  await expect(body).toBeVisible();
  const text = await body.inputValue();
  expect(text).toContain('公開日は10月にします');
  expect(text).toContain('見積書の作成');
  expect(text).toContain('資料をお送りします');
  expect(text).not.toContain('議事録の共有');
  expect(text).not.toContain('予算はまだ決まっていません');
  await expect(page.getByText('未確認の候補 1 件は含めていません')).toBeVisible();
  await page.getByRole('button', { name: '内容を承認' }).click();
  await expect(page.getByText('承認済み', { exact: false }).first()).toBeVisible();

  // ---- 7. The next meeting in the series carries the confirmed items in its Brief
  await page.goto(`/w/${ws.wsId}/meetings/${m2.id}/brief`);
  const prev = cardByTitle(page, '前回のMeeting');
  await expect(prev).toContainText(TITLE);
  await expect(prev).toContainText('同じ定例');
  await expect(cardByTitle(page, /最近の決まったこと/)).toContainText('公開日は10月にします');
  await expect(cardByTitle(page, /未完了のやること/)).toContainText('見積書の作成が必要です');
  await expect(page.locator('#brief-otherCommitments, #brief-theirCommitments, #brief-myCommitments')).toContainText(['資料をお送りします']);
  await expect(page.getByText('議事録の共有が必要です')).toHaveCount(0);
  await expect(page.getByText('初めてのMeetingです')).toHaveCount(0);

  expect(errors).toEqual([]);
});
