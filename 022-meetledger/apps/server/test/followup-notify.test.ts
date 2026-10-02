import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTransport } from 'nodemailer';
import { createTestEnv, type Client, type TestEnv } from './helpers';
import { ledger } from './followup-helpers';
import { runFollowupTick, applyQuietHours, inQuietHours } from '../src/modules/followup/engine';
import { createEmailAdapter, OutboxEmail, SmtpEmail } from '../src/modules/notifications/email';
import { withSystem } from '../src/db/pool';

let env: TestEnv;
let owner: { client: Client; orgId: string; workspaceId: string; userId: string };
let bob: { client: Client; userId: string };
let carol: { client: Client; userId: string };
let dave: { client: Client; userId: string };
let ws: string;
let L: ReturnType<typeof ledger>;

// 2026-10-01T13:30Z = 22:30 JST (inside the default quiet hours 22:00-08:00)
beforeAll(async () => {
  env = await createTestEnv({ now: '2026-10-01T13:30:00Z' });
  owner = await env.setupOwner('owner@example.com');
  ws = owner.workspaceId;
  bob = await env.addUser(owner.client, owner.orgId, ws, 'bob@example.com', 'member');
  carol = await env.addUser(owner.client, owner.orgId, ws, 'carol@example.com', 'member');
  dave = await env.addUser(owner.client, owner.orgId, ws, 'dave@example.com', 'member');
  L = ledger({ env, orgId: owner.orgId, workspaceId: ws });
});
afterAll(async () => env?.close());

const tick = () => runFollowupTick(env.deps);
async function notifs(userId: string, kind?: string) {
  const r = await env.tenantTx(owner.orgId, (db) =>
    db.query(`SELECT * FROM notifications WHERE user_id=$1 ${kind ? 'AND kind=$2' : ''} ORDER BY created_at, id`, kind ? [userId, kind] : [userId]),
  );
  return r.rows;
}
async function meeting(c: Client, input: Record<string, unknown>) {
  const r = await c.post(`/api/w/${ws}/meetings`, input);
  if (r.status !== 200) throw new Error(`create meeting ${r.status} ${r.raw}`);
  return r.body;
}
const BLAME = ['遅れ', '遅延', '怠', '至急', '催促', '早急', 'いまだ', '未だに', 'overdue!', 'late', 'failed to'];

describe('followup: notification engine', () => {
  it('quiet hours helper', () => {
    const u = { tz: 'Asia/Tokyo', quietStartMin: 1320, quietEndMin: 480 };
    expect(inQuietHours(23 * 60, 1320, 480)).toBe(true);
    expect(inQuietHours(7 * 60 + 59, 1320, 480)).toBe(true);
    expect(inQuietHours(8 * 60, 1320, 480)).toBe(false);
    expect(inQuietHours(12 * 60, 720, 780)).toBe(true);
    expect(inQuietHours(12 * 60, 600, 600)).toBe(false);
    expect(applyQuietHours(new Date('2026-10-01T13:30:00Z'), u).toISOString()).toBe('2026-10-01T23:00:00.000Z');
    expect(applyQuietHours(new Date('2026-10-01T03:00:00Z'), u).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(applyQuietHours(new Date('2026-10-01T13:30:00Z'), { tz: 'America/New_York', quietStartMin: 1320, quietEndMin: 480 }).toISOString()).toBe('2026-10-01T13:30:00.000Z');
  });

  it('#21 no duplicates across repeated ticks + quiet hours (scheduled at quiet end in the user time zone)', async () => {
    const m = await meeting(owner.client, { title: 'Review me', scheduledStart: '2026-10-01T10:00:00Z' });
    await L.setMeeting(m.id, { status: 'needs_review', ended_at: '2026-10-01T12:30:00Z' });
    await L.decision({ meetingId: m.id, text: '候補の決定', reviewState: 'candidate' });
    await tick();
    await tick();
    let rows = await notifs(owner.userId, 'needs_review');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(new Date(rows[0].scheduled_for).toISOString()).toBe('2026-10-01T23:00:00.000Z'); // 08:00 JST
    expect((await owner.client.get('/api/notifications')).body.items).toHaveLength(0);

    env.clock.set('2026-10-01T23:05:00Z'); // 08:05 JST
    await tick();
    await tick();
    rows = await notifs(owner.userId, 'needs_review');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
    expect(rows[0].title).toContain('確認待ちの候補があります');
    expect(rows[0].body).toContain('1件');
    const inbox = (await owner.client.get('/api/notifications')).body;
    expect(inbox.items.filter((n: any) => n.kind === 'needs_review')).toHaveLength(1);

    // via the job queue (org-less system job), repeatedly → still no duplicates
    for (const k of ['a', 'b']) {
      await withSystem(env.pool, (db) => env.deps.jobs.enqueue(db, { orgId: null, type: 'followup.tick', key: `test-tick-${k}`, maxAttempts: 1 }));
      await env.worker.drain();
    }
    const jobs = await withSystem(env.pool, (db) => db.query(`SELECT status FROM jobs WHERE type='followup.tick'`));
    expect(jobs.rows.every((j) => j.status === 'succeeded')).toBe(true);
    expect(await notifs(owner.userId, 'needs_review')).toHaveLength(1);
  });

  it('action/commitment reminders: due-date morning (user tz), T+1, single overdue digest per week with neutral wording', async () => {
    // now: 2026-10-01T23:05Z = Fri 2026-10-02 08:05 JST ; Los Angeles: Thu 2026-10-01 16:05
    expect((await dave.client.patch('/api/me', { timezone: 'America/Los_Angeles' })).status).toBe(200);
    const m = await meeting(owner.client, { title: '定例', scheduledStart: '2026-09-30T01:00:00Z' });
    const due = await L.action({ meetingId: m.id, description: '見積の前提を整理', assigneeUserId: bob.userId, dueDate: '2026-10-02' });
    const t1 = await L.action({ meetingId: m.id, description: '共有フォルダを作成', assigneeUserId: bob.userId, confirmedAt: '2026-10-01T05:00:00Z' });
    await L.action({ meetingId: m.id, description: '議事録の清書', assigneeUserId: bob.userId, dueDate: '2026-09-28' });
    await L.commitment({ meetingId: m.id, description: '資料送付', promisedByUserId: bob.userId, promisedToText: '先方', dueDate: '2026-09-29' });
    const laDue = await L.action({ meetingId: m.id, description: 'LAの作業', assigneeUserId: dave.userId, dueDate: '2026-10-01' });
    await L.action({ meetingId: m.id, description: 'LAの明日の作業', assigneeUserId: dave.userId, dueDate: '2026-10-02' });
    await L.commitment({ meetingId: m.id, description: '本日期限の約束', promisedByUserId: carol.userId, dueDate: '2026-10-02', promisedToText: '先方' });
    await tick();

    const bobDue = await notifs(bob.userId, 'action_due');
    expect(bobDue.map((n) => n.entity_id)).toEqual([due]);
    expect(bobDue[0].title).toContain('本日が期限のAction');
    expect(bobDue[0].status).toBe('delivered');
    expect((await notifs(bob.userId, 'action_t1')).map((n) => n.entity_id)).toEqual([t1]);
    const digest = await notifs(bob.userId, 'overdue_digest');
    expect(digest).toHaveLength(1);
    expect(digest[0].title).toBe('期限が過ぎています（2件）');
    expect(digest[0].body).toContain('議事録の清書');
    expect(digest[0].body).toContain('資料送付');
    for (const w of BLAME) {
      expect(digest[0].title + digest[0].body).not.toContain(w);
      expect(bobDue[0].title + bobDue[0].body).not.toContain(w);
    }
    // time zone: Dave (Los Angeles) — 10-01 is "today" there, 10-02 is not yet due
    expect((await notifs(dave.userId, 'action_due')).map((n) => n.entity_id)).toEqual([laDue]);
    expect(await notifs(dave.userId, 'overdue_digest')).toHaveLength(0);
    expect((await notifs(carol.userId, 'commitment_due'))[0].title).toContain('本日が期限の約束');

    // repeated ticks / next days in the same ISO week → still one digest
    await tick();
    env.clock.set('2026-10-02T23:05:00Z'); // Sat 10-03 08:05 JST
    await tick();
    expect(await notifs(bob.userId, 'overdue_digest')).toHaveLength(1);
    expect(await notifs(bob.userId, 'action_t1')).toHaveLength(1);
    // next ISO week → a new (single) digest
    env.clock.set('2026-10-04T23:05:00Z'); // Mon 10-05 08:05 JST
    await tick();
    await tick();
    const d2 = await notifs(bob.userId, 'overdue_digest');
    expect(d2).toHaveLength(2);
    expect(d2[1].title).toBe('期限が過ぎています（3件）');
  });

  it('#21 storm control: max_per_hour respected, excess merged into ONE digest; held items flow after the hour', async () => {
    env.clock.set('2026-10-05T01:00:00Z'); // Mon 10:00 JST
    const prefs = await carol.client.put(`/api/w/${ws}/notification-prefs`, { maxPerHour: 3 });
    expect(prefs.status).toBe(200);
    expect(prefs.body.maxPerHour).toBe(3);
    const m = await meeting(owner.client, { title: '大量Action', scheduledStart: '2026-10-02T01:00:00Z' });
    for (let i = 1; i <= 6; i++) await L.action({ meetingId: m.id, description: `作業${i}`, assigneeUserId: carol.userId, dueDate: '2026-10-05' });
    await tick();
    await tick();
    const all = await notifs(carol.userId);
    const today = all.filter((n) => n.kind === 'action_due' || n.kind === 'digest');
    expect(today.filter((n) => n.kind === 'action_due')).toHaveLength(6);
    const delivered = all.filter((n) => n.status === 'delivered' && n.delivered_at && +new Date(n.delivered_at) === +new Date('2026-10-05T01:00:00Z'));
    expect(delivered).toHaveLength(3);
    const digests = all.filter((n) => n.kind === 'digest');
    expect(digests).toHaveLength(1);
    expect(all.filter((n) => n.status === 'digested')).toHaveLength(4);
    const inbox = (await carol.client.get('/api/notifications?unread=1')).body;
    const dg = inbox.items.find((n: any) => n.kind === 'digest');
    expect(dg.items).toHaveLength(4);
    expect(dg.title).toBe('通知4件をまとめました');

    // one more within the same hour → held (pending), not delivered
    const extra = await L.action({ meetingId: m.id, description: '作業7', assigneeUserId: carol.userId, dueDate: '2026-10-05' });
    await tick();
    let x = (await notifs(carol.userId, 'action_due')).find((n) => n.entity_id === extra)!;
    expect(x.status).toBe('pending');
    env.clock.set('2026-10-05T02:01:00Z');
    await tick();
    x = (await notifs(carol.userId, 'action_due')).find((n) => n.entity_id === extra)!;
    expect(x.status).toBe('delivered');
    // never more than max_per_hour deliveries in any one-hour window
    const times = (await notifs(carol.userId)).filter((n) => n.status === 'delivered').map((n) => +new Date(n.delivered_at));
    for (const t of times) expect(times.filter((u) => u > t - 3600_000 && u <= t).length).toBeLessThanOrEqual(3);
  });

  it('upcoming_brief before meetings the user can see; private meetings/items never notify others; quiet hours suppress useless reminders', async () => {
    env.clock.set('2026-10-06T00:30:00Z'); // Tue 09:30 JST
    const soon = await meeting(owner.client, { title: '顧客MTG', scheduledStart: '2026-10-06T01:15:00Z', participants: [{ name: 'Bob', email: 'bob@example.com' }] });
    const later = await meeting(owner.client, { title: '午後のMTG', scheduledStart: '2026-10-06T03:00:00Z', participants: [{ name: 'Bob', email: 'bob@example.com' }] });
    const priv = await meeting(owner.client, { title: '極秘1on1', visibility: 'private', scheduledStart: '2026-10-06T01:20:00Z', participants: [{ name: 'Bob', email: 'bob@example.com' }] });
    const secret = await L.action({ meetingId: priv.id, description: 'SECRET作業', assigneeUserId: bob.userId, dueDate: '2026-10-06' });
    await tick();
    const ob = await notifs(owner.userId, 'upcoming_brief');
    expect(ob.map((n) => n.entity_id).sort()).toEqual([soon.id, priv.id].sort());
    expect(ob.find((n) => n.entity_id === soon.id).title).toContain('10:15');
    const bb = await notifs(bob.userId, 'upcoming_brief');
    expect(bb.map((n) => n.entity_id)).toEqual([soon.id]);
    expect(bb.map((n) => n.entity_id)).not.toContain(later.id);
    const bobAll = await notifs(bob.userId);
    expect(bobAll.some((n) => n.entity_id === secret || n.entity_id === priv.id)).toBe(false);
    expect(JSON.stringify(bobAll)).not.toContain('SECRET');
    expect(JSON.stringify(bobAll)).not.toContain('極秘');

    env.clock.set('2026-10-06T21:45:00Z'); // Wed 06:45 JST (quiet)
    const early = await meeting(owner.client, { title: '早朝MTG', scheduledStart: '2026-10-06T22:30:00Z' }); // 07:30 JST
    await tick();
    const e = (await notifs(owner.userId, 'upcoming_brief')).find((n) => n.entity_id === early.id);
    expect(e.status).toBe('suppressed');
    expect((await owner.client.get('/api/notifications')).body.items.some((n: any) => n.entityId === early.id)).toBe(false);
  });

  it('next_meeting: a series meeting ended without a next one → one suggestion to the owner', async () => {
    env.clock.set('2026-10-07T03:00:00Z');
    const s = (await owner.client.post(`/api/w/${ws}/series`, { title: '隔週レビュー', meetingType: 'internal' })).body;
    const m = await meeting(owner.client, { title: '隔週レビュー #1', seriesId: s.id, scheduledStart: '2026-10-06T05:00:00Z' });
    await L.setMeeting(m.id, { status: 'ready', ended_at: '2026-10-06T06:00:00Z' });
    await tick();
    await tick();
    const n = await notifs(owner.userId, 'next_meeting');
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain('隔週レビュー');
  });

  it('e-mail copies only when enabled (outbox, deduped); inbox read / read-all; prefs', async () => {
    env.clock.set('2026-10-07T04:00:00Z'); // 13:00 JST
    const prefs0 = (await owner.client.get(`/api/w/${ws}/notification-prefs`)).body;
    expect(prefs0).toMatchObject({ quietStart: '22:00', quietEnd: '08:00', emailEnabled: false, maxPerHour: 6, briefLeadMin: 60, timezoneSource: 'profile', emailDriver: 'outbox' });
    expect((await owner.client.put(`/api/w/${ws}/notification-prefs`, { timezone: 'Mars/Olympus' })).status).toBe(400);
    const tzSet = (await owner.client.put(`/api/w/${ws}/notification-prefs`, { timezone: 'Europe/Berlin', quietStart: '23:00' })).body;
    expect(tzSet).toMatchObject({ timezone: 'Europe/Berlin', timezoneSource: 'notification_settings', quietStartMin: 1380 });
    const back = (await owner.client.put(`/api/w/${ws}/notification-prefs`, { timezone: null, quietStart: '22:00', emailEnabled: true })).body;
    expect(back).toMatchObject({ timezone: 'Asia/Tokyo', timezoneSource: 'profile', emailEnabled: true });

    const m = await meeting(owner.client, { title: 'メール通知テスト', scheduledStart: '2026-10-07T01:00:00Z' });
    await L.setMeeting(m.id, { status: 'needs_review', ended_at: '2026-10-07T02:00:00Z' });
    await L.action({ meetingId: m.id, description: 'bobの今日の作業', assigneeUserId: bob.userId, dueDate: '2026-10-07' });
    await tick();
    await tick();
    const outbox = await env.tenantTx(owner.orgId, (db) => db.query('SELECT to_address, subject, status, dedupe_key FROM email_outbox ORDER BY created_at'));
    const mine = outbox.rows.filter((r) => r.to_address === 'owner@example.com');
    expect(mine.some((r) => r.subject.includes('メール通知テスト'))).toBe(true);
    expect(mine.every((r) => r.status === 'held' && r.dedupe_key.startsWith('notification:'))).toBe(true);
    expect(new Set(mine.map((r) => r.dedupe_key)).size).toBe(mine.length);
    expect(outbox.rows.some((r) => r.to_address === 'bob@example.com')).toBe(false); // bob did not enable e-mail
    expect(env.http.byKind('email')).toHaveLength(0);

    // inbox
    const inbox = (await owner.client.get('/api/notifications?unread=1')).body;
    expect(inbox.unreadCount).toBeGreaterThan(0);
    const first = inbox.items[0];
    expect((await bob.client.post(`/api/notifications/${first.id}/read`, {})).status).toBe(404);
    expect((await owner.client.post(`/api/notifications/${first.id}/read`, {})).status).toBe(200);
    const after = (await owner.client.get('/api/notifications?unread=1')).body;
    expect(after.unreadCount).toBe(inbox.unreadCount - 1);
    expect((await owner.client.post('/api/notifications/read-all', {})).body.ok).toBe(true);
    expect((await owner.client.get('/api/notifications?unread=1')).body.unreadCount).toBe(0);
    // other users never see the owner's notifications
    const bobInbox = (await bob.client.get('/api/notifications')).body.items;
    expect(bobInbox.some((n: any) => n.id === first.id)).toBe(false);
    expect((await env.client().get('/api/notifications')).status).toBe(401);
  });

  it('a second organization is processed in its own tenant context (no cross-tenant notifications)', async () => {
    const t = await env.createTenant('other@tenant-b.example');
    const r = await t.client.post(`/api/w/${t.workspaceId}/meetings`, { title: 'Bの会議', scheduledStart: '2026-10-07T01:00:00Z' });
    await env.tenantTx(t.orgId, (db) => db.query(`UPDATE meetings SET status='needs_review', ended_at='2026-10-07T02:00:00Z' WHERE id=$1`, [r.body.id]));
    const res = await tick();
    expect(res.failedOrgs).toBe(0);
    expect(res.orgs).toBeGreaterThanOrEqual(2);
    const b = (await t.client.get('/api/notifications')).body.items;
    expect(b.some((n: any) => n.title.includes('Bの会議'))).toBe(true);
    expect(b.every((n: any) => n.orgId === t.orgId)).toBe(true);
    const a = (await owner.client.get('/api/notifications')).body.items;
    expect(a.some((n: any) => n.title.includes('Bの会議'))).toBe(false);
  });
});

describe('notifications: e-mail adapters', () => {
  it('createEmailAdapter: outbox by default; smtp requires SMTP_URL', () => {
    expect(createEmailAdapter({ EMAIL_DRIVER: 'outbox', SMTP_URL: undefined, EMAIL_FROM: 'x <x@x>' })).toBeInstanceOf(OutboxEmail);
    expect(() => createEmailAdapter({ EMAIL_DRIVER: 'smtp', SMTP_URL: undefined, EMAIL_FROM: 'x <x@x>' })).toThrow(/SMTP_URL/);
    expect(createEmailAdapter({ EMAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://u:p@mail.example.com:587', EMAIL_FROM: 'x <x@x>' })).toBeInstanceOf(SmtpEmail);
  });

  it('SmtpEmail sends via nodemailer (local json transport, no network), dedupes, records metadata only', async () => {
    const sent: any[] = [];
    const json = createTransport({ jsonTransport: true });
    const transport = {
      sendMail: async (m: any) => {
        const info = await json.sendMail(m);
        sent.push(JSON.parse((info as any).message));
        return info;
      },
    };
    const smtp = new SmtpEmail({ smtpUrl: 'smtp://user:secret@mail.example.com:587', from: 'MeetLedger <no-reply@example.com>', transport });
    const msg = { orgId: owner.orgId, to: 'owner@example.com', subject: '[MeetLedger] テスト', body: '本文テキスト', dedupeKey: 'smtp-test-1' };
    const r1 = await env.tenantTx(owner.orgId, (db) => smtp.send(db, msg));
    const r2 = await env.tenantTx(owner.orgId, (db) => smtp.send(db, msg));
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('[MeetLedger] テスト');
    const row = await env.tenantTx(owner.orgId, (db) => db.query(`SELECT status, sent_at FROM email_outbox WHERE dedupe_key='smtp-test-1'`));
    expect(row.rows[0].status).toBe('sent');
    const calls = await env.tenantTx(owner.orgId, (db) => db.query(`SELECT * FROM external_calls WHERE kind='email'`));
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].host).toBe('mail.example.com:587');
    expect(JSON.stringify(calls.rows[0])).not.toContain('本文');
    expect(JSON.stringify(calls.rows[0])).not.toContain('secret');

    const failing = new SmtpEmail({ smtpUrl: 'smtp://mail.example.com', from: 'x <x@example.com>', transport: { sendMail: async () => Promise.reject(new Error('connection refused')) } });
    await env.tenantTx(owner.orgId, (db) => failing.send(db, { ...msg, dedupeKey: 'smtp-test-2' }));
    const f = await env.tenantTx(owner.orgId, (db) => db.query(`SELECT status, error FROM email_outbox WHERE dedupe_key='smtp-test-2'`));
    expect(f.rows[0].status).toBe('failed');
  });
});
