import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Client, type TestEnv } from './helpers';
import { ledger } from './followup-helpers';
import { loadConfig } from '../src/config';
import { createProviders } from '../src/providers/registry';
import type { AiProvider } from '../src/providers/ai/types';
import { composeDraft, validatePolish } from '../src/modules/followup/drafts';

// Fake AI polish: tries to inject a promise into the greeting; returns a harmless rewording for the closing.
const polishCalls: { kind: string; text: string }[] = [];
const fakePolish: AiProvider['polish'] = async (input) => {
  polishCalls.push({ kind: input.kind, text: input.text });
  if (input.text.includes('いつもお世話になっております') || input.text.includes('本日は')) {
    return '本日はお時間をいただきありがとうございました。来週までに見積をお送りします。';
  }
  return 'ご確認のほど、よろしくお願いいたします。';
};

let env: TestEnv;
let owner: { client: Client; orgId: string; workspaceId: string; userId: string };
let bob: { client: Client; userId: string };
let ws: string;
let L: ReturnType<typeof ledger>;

async function meeting(c: Client, input: Record<string, unknown>) {
  const r = await c.post(`/api/w/${ws}/meetings`, input);
  if (r.status !== 200) throw new Error(`create meeting ${r.status} ${r.raw}`);
  return r.body;
}

beforeAll(async () => {
  const providers = createProviders(loadConfig({ NODE_ENV: 'test' }));
  const stub: AiProvider = {
    id: 'local-rules',
    isLocal: true,
    model: null,
    available: async () => ({ ok: true }),
    extract: async () => ({ summary: { executive: '', topics: [], risks: [] }, decisions: [], actions: [], commitments: [], questions: [] }),
    answer: async () => ({ answer: '', citedRefs: [], insufficient: true }),
  };
  const real = providers.a.get('local-rules') ?? stub;
  providers.a.set('local-rules', Object.assign(Object.create(real), { polish: fakePolish }));
  env = await createTestEnv({ providers });
  owner = await env.setupOwner('owner@example.com');
  ws = owner.workspaceId;
  bob = await env.addUser(owner.client, owner.orgId, ws, 'bob@example.com', 'member');
  L = ledger({ env, orgId: owner.orgId, workspaceId: ws });
});
afterAll(async () => env?.close());

describe('followup: drafts', () => {
  it('#11 follow-up never contains promises/items that are not confirmed in the ledger (AI polish injection is rejected)', async () => {
    const m = await meeting(owner.client, {
      title: 'Acme 定例',
      meetingType: 'client',
      scheduledStart: '2026-09-30T05:00:00Z',
      participants: [{ name: '佐藤', email: 'sato@acme.example' }],
    });
    const sato = m.participants[0].personId;
    const d = await L.decision({ meetingId: m.id, text: '次フェーズはβ版から開始する', reason: '社内リソース都合で値引き余地を残すため' });
    const a = await L.action({ meetingId: m.id, description: '要件一覧を共有する', assigneeUserId: owner.userId, dueDate: '2026-10-07' });
    const c = await L.commitment({ meetingId: m.id, description: '契約書ドラフトを確認する', promisedByPersonId: sato, promisedToUserId: owner.userId });
    const q = await L.question({ meetingId: m.id, question: 'SSO対応は必要か' });
    // NOT confirmed → must never appear
    await L.commitment({ meetingId: m.id, description: '来週までに見積をお送りします', status: 'candidate', promisedByUserId: owner.userId });
    await L.action({ meetingId: m.id, description: '却下された作業XYZ', status: 'rejected' });
    await L.decision({ meetingId: m.id, text: '候補の決定ABC', reviewState: 'candidate' });
    // private memo (internal only)
    await owner.client.put(`/api/w/${ws}/meetings/${m.id}/notes`, { body: '社内メモ: 値引きは10%まで', baseVersion: 0 });

    const r = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'client_recap', polish: true });
    expect(r.status).toBe(200);
    const f = r.body;
    expect(f.status).toBe('draft');
    for (const t of ['次フェーズはβ版から開始する', '要件一覧を共有する', '契約書ドラフトを確認する', 'SSO対応は必要か']) expect(f.body).toContain(t);
    for (const t of ['見積', '来週', 'XYZ', 'ABC', '値引き', '社内メモ', '社内リソース']) expect(f.body).not.toContain(t);
    expect(new Set(f.referencedItems.map((x: any) => x.id))).toEqual(new Set([d, a, c, q]));
    expect(f.referencedItems).toHaveLength(4);
    // AI polish: greeting tried to add a promise → rejected (template text kept); closing rewording accepted.
    expect(f.polish.rejected.map((x: any) => x.part)).toContain('greeting');
    expect(['promise_added', 'date_added']).toContain(f.polish.rejected[0].reason);
    expect(f.polish.applied).toEqual(['closing']);
    expect(f.body).toContain('ご確認のほど、よろしくお願いいたします。');
    expect(f.body).toContain('いつもお世話になっております。');
    expect(f.generatedBy).toBe('ai');
    expect(f.aiGenerated).toBe(true);
    expect(f.warnings.some((w: string) => w.startsWith('candidates_excluded'))).toBe(true);
    // the AI only ever saw greeting/closing text, never the item list
    for (const call of polishCalls) {
      expect(call.text).not.toContain('要件一覧');
      expect(call.text).not.toContain('契約書');
    }

    // internal recap includes the decision reason; still no unconfirmed items
    const internal = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'internal_recap' });
    expect(internal.body.body).toContain('社内リソース都合');
    expect(internal.body.body).not.toContain('見積');
    expect(internal.body.generatedBy).toBe('template');
    // thank-you email (client facing) excludes the reason too; English locale works
    const ty = await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'thank_you_email', locale: 'en' });
    expect(ty.body.body).toContain('Thank you very much');
    expect(ty.body.body).not.toContain('社内リソース');
    expect(ty.body.subject).toBe('Thank you — Acme 定例');

    // nothing was sent anywhere
    const outbox = await env.tenantTx(owner.orgId, (db) => db.query('SELECT count(*)::int AS n FROM email_outbox'));
    expect(outbox.rows[0].n).toBe(0);
    expect(env.http.calls.length).toBe(0);
  });

  it('draft lifecycle: edit (edited flag, optimistic concurrency) → approve → mark-sent; never auto-sent', async () => {
    const m = await meeting(owner.client, { title: 'Lifecycle', scheduledStart: '2026-09-29T01:00:00Z' });
    await L.action({ meetingId: m.id, description: 'テスト項目を書く', assigneeUserId: owner.userId });
    const f = (await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'slack_update' })).body;
    expect(f.subject).toBeNull();
    expect(f.body).toContain('• テスト項目を書く');
    // regenerate (unedited) → same draft updated in place
    const again = (await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'slack_update' })).body;
    expect(again.id).toBe(f.id);
    expect((await owner.client.post(`/api/w/${ws}/followups/${f.id}/mark-sent`, {})).status).toBe(409);
    const edited = await owner.client.patch(`/api/w/${ws}/followups/${f.id}`, { body: again.body + '\n追記: 人間が編集', version: again.version });
    expect(edited.status).toBe(200);
    expect(edited.body.edited).toBe(true);
    expect((await owner.client.patch(`/api/w/${ws}/followups/${f.id}`, { body: 'stale', version: again.version })).status).toBe(409);
    // an edited draft is never overwritten by regeneration
    const regen = (await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'slack_update' })).body;
    expect(regen.id).not.toBe(f.id);
    const approved = await owner.client.post(`/api/w/${ws}/followups/${f.id}/approve`, {});
    expect(approved.body.status).toBe('approved');
    const sent = await owner.client.post(`/api/w/${ws}/followups/${f.id}/mark-sent`, { channel: 'slack' });
    expect(sent.body.status).toBe('sent');
    expect((await owner.client.post(`/api/w/${ws}/followups/${f.id}/discard`, {})).status).toBe(409);
    const list = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/followups`);
    expect(list.body.items.length).toBe(2);
    // viewer-level / other users cannot see drafts of meetings they cannot see
    const priv = await meeting(owner.client, { title: 'Private', visibility: 'private' });
    const pf = (await owner.client.post(`/api/w/${ws}/meetings/${priv.id}/followups`, { kind: 'internal_recap' })).body;
    expect((await bob.client.patch(`/api/w/${ws}/followups/${pf.id}`, { body: 'x', version: pf.version })).status).toBe(404);
    expect((await bob.client.get(`/api/w/${ws}/meetings/${priv.id}/followups`)).status).toBe(404);
  });

  it('approve refuses drafts whose referenced items were un-confirmed after drafting (unless acknowledged)', async () => {
    const m = await meeting(owner.client, { title: 'Stale', scheduledStart: '2026-09-28T01:00:00Z' });
    const a = await L.action({ meetingId: m.id, description: 'あとで取り消される作業' });
    const f = (await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'internal_recap' })).body;
    await env.tenantTx(owner.orgId, (db) => db.query(`UPDATE actions SET status='rejected' WHERE id=$1`, [a]));
    const r = await owner.client.post(`/api/w/${ws}/followups/${f.id}/approve`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.details.code).toBe('stale_items');
    expect((await owner.client.post(`/api/w/${ws}/followups/${f.id}/approve`, { acknowledgeStale: true })).body.status).toBe('approved');
  });

  it('AI OFF meeting: polish is skipped and the provider is never called', async () => {
    const before = polishCalls.length;
    const m = await meeting(owner.client, { title: 'AI off', aiEnabled: false, scheduledStart: '2026-09-28T01:00:00Z' });
    await L.decision({ meetingId: m.id, text: '手作業で記録した決定' });
    const f = (await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'client_recap', polish: true })).body;
    expect(f.polish.skipped).toBe('ai_off');
    expect(f.generatedBy).toBe('template');
    expect(polishCalls.length).toBe(before);
  });

  it('validatePolish rejects added dates, numbers, promise verbs, lists and links', () => {
    const o = '本日はお時間をいただき、誠にありがとうございました。';
    expect(validatePolish(o, '本日は貴重なお時間をいただき、誠にありがとうございました。', '').ok).toBe(true);
    expect(validatePolish(o, '本日はありがとうございました。来週までに見積をお送りします。', '')).toMatchObject({ ok: false });
    expect(validatePolish(o, '本日はありがとうございました。3日以内にご連絡します。', '')).toMatchObject({ ok: false, reason: 'number_added' });
    expect(validatePolish(o, '本日はありがとうございました。必ず対応します。', '')).toMatchObject({ ok: false, reason: 'promise_added' });
    expect(validatePolish(o, '本日はありがとうございました。\n・追加項目', '')).toMatchObject({ ok: false });
    expect(validatePolish(o, '詳細は https://evil.example を参照', '')).toMatchObject({ ok: false, reason: 'link_added' });
    expect(validatePolish('Thanks for today.', 'Thanks for today. We will send the quote by Friday.', '')).toMatchObject({ ok: false });
    expect(validatePolish('Thanks for today.', 'Thank you for your time today.', '').ok).toBe(true);
    expect(validatePolish(o, 42 as any, '')).toMatchObject({ ok: false, reason: 'invalid_output' });
  });

  it('composeDraft is deterministic and lists exactly the given items', () => {
    const input = {
      kind: 'client_recap' as const,
      locale: 'ja' as const,
      tone: 'formal' as const,
      meeting: { title: 'X', date: '2026-10-01' },
      decisions: [{ id: 'd1', text: '決定1', reason: '内部理由' }],
      actions: [{ id: 'a1', description: '作業1', assignee: null, due: null }],
      commitments: [],
      questions: [],
    };
    const p1 = composeDraft(input);
    const p2 = composeDraft(input);
    expect(p1).toEqual(p2);
    expect(p1.referencedItems).toEqual([
      { type: 'decision', id: 'd1' },
      { type: 'action', id: 'a1' },
    ]);
    expect(p1.sections).not.toContain('内部理由');
    expect(p1.sections).not.toContain('期限');
    expect(p1.greeting).toContain('2026年10月1日');
  });
});

describe('followup: brief, memory, timeline, recurring, dashboard', () => {
  it('#10 open question appears in the next meeting brief (with source meeting title/date)', async () => {
    const a = await meeting(owner.client, {
      title: '初回ヒアリング',
      meetingType: 'client',
      scheduledStart: '2026-09-10T02:00:00Z',
      participants: [{ name: '田中', email: 'tanaka@beta.example' }],
    });
    const tanaka = a.participants[0].personId;
    await L.question({ meetingId: a.id, question: 'API連携の仕様はどうするか' });
    await L.question({ meetingId: a.id, question: '候補の質問QQQ', status: 'candidate' });
    const b = await meeting(owner.client, { title: '2回目', meetingType: 'client', scheduledStart: '2026-10-08T02:00:00Z', participants: [{ personId: tanaka }] });
    const brief = await owner.client.get(`/api/w/${ws}/meetings/${b.id}/brief`);
    expect(brief.status).toBe(200);
    expect(brief.body.firstMeeting).toBe(false);
    expect(brief.body.previousMeeting.id).toBe(a.id);
    expect(brief.body.previousMeeting.via).toBe('participants');
    const q = brief.body.openQuestions.find((x: any) => x.question === 'API連携の仕様はどうするか');
    expect(q).toBeTruthy();
    expect(q.source.meetingTitle).toBe('初回ヒアリング');
    expect(q.source.meetingDate).toBe('2026-09-10T02:00:00.000Z');
    expect(JSON.stringify(brief.body)).not.toContain('QQQ');
  });

  it('brief for a first meeting is minimal (firstMeeting=true, no invented content)', async () => {
    const m = await meeting(owner.client, {
      title: '初対面の打ち合わせ',
      meetingType: 'sales',
      scheduledStart: '2026-10-09T02:00:00Z',
      participants: [{ name: '新規 太郎', email: 'new@gamma.example' }],
    });
    const brief = await owner.client.get(`/api/w/${ws}/meetings/${m.id}/brief`);
    expect(brief.body.firstMeeting).toBe(true);
    expect(brief.body.previousMeeting).toBeNull();
    expect(brief.body.currentDecisions).toEqual([]);
    expect(brief.body.openActions).toEqual([]);
    expect(brief.body.commitments).toEqual({ mine: [], theirs: [], others: [] });
    expect(brief.body.openQuestions).toEqual([]);
    expect(brief.body.personNotes).toEqual([]);
    expect(brief.body.participants.map((p: any) => p.name)).toEqual(['新規 太郎']);
    expect(brief.body.agendaTemplate.length).toBeGreaterThan(0);
  });

  it('E2E-4: my overdue commitment 資料送付 from the last meeting is listed in the next meeting brief (mine vs theirs)', async () => {
    const c = await meeting(owner.client, {
      title: 'Delta 打ち合わせ',
      meetingType: 'client',
      scheduledStart: '2026-09-20T02:00:00Z',
      participants: [{ name: '鈴木', email: 'suzuki@delta.example' }, { name: 'Owner', email: 'owner@example.com' }],
    });
    const suzuki = c.participants.find((p: any) => p.email === 'suzuki@delta.example').personId;
    await L.commitment({ meetingId: c.id, description: '資料送付', promisedByUserId: owner.userId, promisedToPersonId: suzuki, dueDate: '2026-09-25' });
    await L.commitment({ meetingId: c.id, description: '社内稟議の結果を連絡', promisedByPersonId: suzuki, promisedToText: '当社', dueDate: '2026-10-10' });
    const d = await meeting(owner.client, {
      title: 'Delta 2回目',
      meetingType: 'client',
      scheduledStart: '2026-10-05T02:00:00Z',
      participants: [{ personId: suzuki }, { name: 'Owner', email: 'owner@example.com' }],
    });
    const brief = (await owner.client.get(`/api/w/${ws}/meetings/${d.id}/brief`)).body;
    const mine = brief.commitments.mine.find((x: any) => x.description === '資料送付');
    expect(mine).toBeTruthy();
    expect(mine.overdue).toBe(true);
    expect(mine.source.meetingTitle).toBe('Delta 打ち合わせ');
    expect(brief.commitments.theirs.map((x: any) => x.description)).toContain('社内稟議の結果を連絡');
    expect(brief.commitments.mine.map((x: any) => x.description)).not.toContain('社内稟議の結果を連絡');
    // the owner's own person record is not treated as "the other side"
    expect(brief.participants.find((p: any) => p.name === 'Owner')?.isMe).toBe(true);
    // dashboard lists it as overdue, neutral (no blame) data only
    const dash = (await owner.client.get(`/api/w/${ws}/dashboard`)).body;
    expect(dash.overdue.commitments.map((x: any) => x.description)).toContain('資料送付');
    expect(dash.myCommitments.map((x: any) => x.description)).toContain('資料送付');
    expect(dash.waitingOnOthers.commitments.map((x: any) => x.description)).toContain('社内稟議の結果を連絡');
  });

  it('#14 recurring: the previous meeting’s open action appears in the next meeting brief and agenda (idempotent suggest)', async () => {
    const s = (await owner.client.post(`/api/w/${ws}/series`, { title: '週次定例', meetingType: 'internal', cadence: 'weekly' })).body;
    const m1 = await meeting(owner.client, { title: '週次定例 #1', seriesId: s.id, scheduledStart: '2026-09-24T01:00:00Z', participants: [{ name: 'Bob', email: 'bob@example.com' }] });
    await L.action({ meetingId: m1.id, description: '議事録テンプレを更新', assigneeUserId: bob.userId, dueDate: '2026-09-30' });
    await L.action({ meetingId: m1.id, description: '完了済みの作業', status: 'done' });
    await L.action({ meetingId: m1.id, description: '未確認の候補作業', status: 'candidate' });
    await L.question({ meetingId: m1.id, question: 'リリース日はいつにするか' });

    const next = await owner.client.post(`/api/w/${ws}/series/${s.id}/meetings`, { scheduledStart: '2026-10-08T01:00:00Z' });
    expect(next.status).toBe(200);
    expect(next.body.seriesId).toBe(s.id);
    expect(next.body.title).toBe('週次定例');
    expect(next.body.participants.map((p: any) => p.email)).toContain('bob@example.com');
    expect(next.body.agendaSuggested).toBeGreaterThanOrEqual(2);

    const brief = (await owner.client.get(`/api/w/${ws}/meetings/${next.body.id}/brief`)).body;
    expect(brief.previousMeeting.id).toBe(m1.id);
    expect(brief.previousMeeting.via).toBe('series');
    const descs = brief.openActions.map((x: any) => x.description);
    expect(descs).toContain('議事録テンプレを更新');
    expect(descs).not.toContain('完了済みの作業');
    expect(descs).not.toContain('未確認の候補作業');
    expect(brief.openActions.find((x: any) => x.description === '議事録テンプレを更新').overdue).toBe(true);

    const agenda = (await owner.client.get(`/api/w/${ws}/meetings/${next.body.id}/agenda`)).body.items;
    expect(agenda.some((i: any) => i.text.includes('議事録テンプレを更新') && i.sourceType === 'action' && i.status === 'candidate')).toBe(true);
    expect(agenda.some((i: any) => i.text.includes('リリース日はいつにするか'))).toBe(true);
    expect(agenda.some((i: any) => i.sourceType === 'template')).toBe(true);
    const again = await owner.client.post(`/api/w/${ws}/meetings/${next.body.id}/agenda/suggest`, {});
    expect(again.body.created).toBe(0);
    expect(again.body.items.length).toBe(agenda.length);
    // manual item + PATCH
    const manual = await owner.client.post(`/api/w/${ws}/meetings/${next.body.id}/agenda`, { text: '新メンバー紹介' });
    expect(manual.body.status).toBe('accepted');
    const patched = await owner.client.patch(`/api/w/${ws}/agenda/${manual.body.id}`, { status: 'done', position: 0 });
    expect(patched.body.status).toBe('done');
    // series memory
    const mem = (await owner.client.get(`/api/w/${ws}/series/${s.id}/memory`)).body;
    expect(mem.openActions.map((x: any) => x.description)).toContain('議事録テンプレを更新');
    expect(mem.openQuestions.map((x: any) => x.question)).toContain('リリース日はいつにするか');
    expect(mem.nextMeeting.id).toBe(next.body.id);
  });

  it('#13 project memory shows current decisions only (superseded excluded, listed under recent changes)', async () => {
    const p = (await owner.client.post(`/api/w/${ws}/projects`, { name: 'Project Orion', kind: 'project' })).body;
    const m1 = await meeting(owner.client, { title: 'Orion キックオフ', projectId: p.id, scheduledStart: '2026-09-15T01:00:00Z' });
    const m2 = await meeting(owner.client, { title: 'Orion 見直し', projectId: p.id, scheduledStart: '2026-09-29T01:00:00Z' });
    const d1 = await L.decision({ meetingId: m1.id, text: '価格は月額10万円とする', topic: '価格', confirmedAt: '2026-09-15T02:00:00Z' });
    const d2 = await L.decision({ meetingId: m2.id, text: '価格は月額12万円とする', topic: '価格', confirmedAt: '2026-09-29T02:00:00Z' });
    await L.supersede(d1, d2);
    await L.decision({ meetingId: m2.id, text: '候補: 価格は無料', reviewState: 'candidate' });
    const d3 = await L.decision({ meetingId: m1.id, text: 'リリースは11月', confirmedAt: '2026-09-15T02:00:00Z' });
    await L.commitment({ meetingId: m2.id, description: '価格表を更新して共有', promisedByUserId: owner.userId });
    const mem = await owner.client.get(`/api/w/${ws}/projects/${p.id}/memory`);
    expect(mem.status).toBe(200);
    const cur = mem.body.currentDecisions.map((x: any) => x.id);
    expect(cur).toContain(d2);
    expect(cur).toContain(d3);
    expect(cur).not.toContain(d1);
    expect(mem.body.currentDecisions.some((x: any) => x.text.includes('無料'))).toBe(false);
    expect(mem.body.recentChanges[0].previous.id).toBe(d1);
    expect(mem.body.recentChanges[0].current.id).toBe(d2);
    expect(mem.body.outstandingCommitments.map((x: any) => x.description)).toContain('価格表を更新して共有');
    expect(mem.body.recentMeetings.map((x: any) => x.id)).toEqual([m2.id, m1.id]);
    // topic memory (token match)
    const topic = (await owner.client.get(`/api/w/${ws}/memory?topic=${encodeURIComponent('価格')}`)).body;
    expect(topic.currentDecisions.map((x: any) => x.id)).toEqual([d2]);
    expect(topic.recentChanges.map((x: any) => x.previous.id)).toContain(d1);
    expect(topic.outstandingCommitments.map((x: any) => x.description)).toContain('価格表を更新して共有');
    expect(topic.currentDecisions.map((x: any) => x.id)).not.toContain(d3);
  });

  it('#12 person timeline: facts in chronological order (meetings, decisions, commitments, actions, follow-ups, notes)', async () => {
    const p = (await owner.client.post(`/api/w/${ws}/people`, { name: '山本', organization: 'Epsilon', email: 'yamamoto@eps.example' })).body;
    const m1 = await meeting(owner.client, { title: 'Epsilon 1', scheduledStart: '2026-09-01T01:00:00Z', participants: [{ personId: p.id }] });
    const m2 = await meeting(owner.client, { title: 'Epsilon 2', scheduledStart: '2026-09-15T01:00:00Z', participants: [{ personId: p.id }] });
    await L.decision({ meetingId: m1.id, text: 'PoCを実施する', ownerPersonId: p.id });
    await L.commitment({ meetingId: m2.id, description: '検証データを提供', promisedByPersonId: p.id, promisedToUserId: owner.userId });
    await L.action({ meetingId: m2.id, description: '環境を準備', assigneePersonId: p.id });
    await L.action({ meetingId: m2.id, description: '候補アクションZZZ', assigneePersonId: p.id, status: 'candidate' });
    await owner.client.post(`/api/w/${ws}/people/${p.id}/notes`, { body: '技術窓口' });
    const f = (await owner.client.post(`/api/w/${ws}/meetings/${m2.id}/followups`, { kind: 'thank_you_email' })).body;
    await owner.client.post(`/api/w/${ws}/followups/${f.id}/approve`, {});

    const tl = await owner.client.get(`/api/w/${ws}/people/${p.id}/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.body.factsOnly).toBe(true);
    const types = new Set(tl.body.events.map((e: any) => e.type));
    for (const t of ['meeting', 'decision', 'commitment', 'action', 'followup', 'note']) expect(types).toContain(t);
    expect(JSON.stringify(tl.body)).not.toContain('ZZZ');
    const dated = tl.body.events.filter((e: any) => e.at).map((e: any) => Date.parse(e.at));
    expect([...dated].sort((x, y) => y - x)).toEqual(dated);
    expect(tl.body.events.find((e: any) => e.type === 'commitment').role).toBe('promised_by');
    expect(tl.body.stats.meetings).toBe(2);
    // no AI characterization fields
    expect(Object.keys(tl.body.person).sort()).toEqual(['email', 'id', 'name', 'organization', 'roleTitle', 'tags']);
    const asc = (await owner.client.get(`/api/w/${ws}/people/${p.id}/timeline?order=asc`)).body.events.filter((e: any) => e.type === 'meeting');
    expect(asc.map((e: any) => e.meeting.id)).toEqual([m1.id, m2.id]);
  });

  it('ACL: private meeting items never appear in another user’s brief, dashboard, timeline or memory', async () => {
    const p = (await owner.client.post(`/api/w/${ws}/people`, { name: '伊藤', email: 'ito@zeta.example' })).body;
    const proj = (await owner.client.post(`/api/w/${ws}/projects`, { name: 'Zeta' })).body;
    const priv = await meeting(owner.client, {
      title: '1on1 極秘',
      meetingType: 'one_on_one',
      projectId: proj.id,
      scheduledStart: '2026-09-20T01:00:00Z',
      participants: [{ personId: p.id }],
    });
    expect(priv.visibility).toBe('private');
    await L.action({ meetingId: priv.id, description: 'SECRET-ACTION', assigneeUserId: bob.userId, dueDate: '2026-09-25' });
    await L.commitment({ meetingId: priv.id, description: 'SECRET-COMMIT', promisedByUserId: bob.userId, promisedToPersonId: p.id, dueDate: '2026-09-25' });
    await L.question({ meetingId: priv.id, question: 'SECRET-QUESTION', ownerPersonId: p.id });
    await L.decision({ meetingId: priv.id, text: 'SECRET-DECISION', ownerPersonId: p.id });

    const pub = await bob.client.post(`/api/w/${ws}/meetings`, { title: 'Zeta 公開', projectId: proj.id, scheduledStart: '2026-10-06T01:00:00Z', participants: [{ personId: p.id }] });
    expect(pub.status).toBe(200);
    const bodies = [
      await bob.client.get(`/api/w/${ws}/meetings/${pub.body.id}/brief`),
      await bob.client.get(`/api/w/${ws}/dashboard`),
      await bob.client.get(`/api/w/${ws}/people/${p.id}/timeline`),
      await bob.client.get(`/api/w/${ws}/projects/${proj.id}/memory`),
      await bob.client.get(`/api/w/${ws}/memory?topic=SECRET`),
    ];
    for (const r of bodies) {
      expect(r.status).toBe(200);
      const json = JSON.stringify({ ...r.body, topic: undefined }); // the topic query echoes the search term itself
      expect(json).not.toContain('SECRET');
      expect(json).not.toContain('1on1 極秘');
    }
    expect(bodies[0].body.firstMeeting).toBe(true);
    expect((await bob.client.get(`/api/w/${ws}/meetings/${priv.id}/brief`)).status).toBe(404);
    expect((await bob.client.get(`/api/w/${ws}/meetings/${priv.id}/agenda`)).status).toBe(404);
    // the creator does see them
    const own = await owner.client.get(`/api/w/${ws}/people/${p.id}/timeline`);
    expect(own.raw).toContain('SECRET-DECISION');
    // agenda items copied from private items are hidden from users who cannot see the source
    await owner.client.post(`/api/w/${ws}/meetings/${pub.body.id}/agenda/suggest`, {});
    const ownerAgenda = (await owner.client.get(`/api/w/${ws}/meetings/${pub.body.id}/agenda`)).raw;
    const bobAgenda = (await bob.client.get(`/api/w/${ws}/meetings/${pub.body.id}/agenda`)).raw;
    expect(bobAgenda).not.toContain('SECRET');
    expect(ownerAgenda).toContain('SECRET-ACTION');
  });

  it('dashboard: today / upcoming / needs review / my actions', async () => {
    // clock: 2026-10-01T01:00Z = 10:00 JST
    const t = await meeting(owner.client, { title: '今日の会議', scheduledStart: '2026-10-01T05:00:00Z' });
    const u = await meeting(owner.client, { title: '来週の会議', scheduledStart: '2026-10-04T05:00:00Z' });
    const r = await meeting(owner.client, { title: 'レビュー待ち', scheduledStart: '2026-09-30T05:00:00Z' });
    await L.decision({ meetingId: r.id, text: '候補決定', reviewState: 'candidate' });
    await L.action({ meetingId: r.id, description: '自分のAction', assigneeUserId: owner.userId, dueDate: '2026-10-03' });
    const dash = (await owner.client.get(`/api/w/${ws}/dashboard`)).body;
    expect(dash.today.map((x: any) => x.id)).toContain(t.id);
    expect(dash.upcoming.map((x: any) => x.id)).toContain(u.id);
    expect(dash.today.map((x: any) => x.id)).not.toContain(u.id);
    expect(dash.needsReview.find((x: any) => x.id === r.id).candidates).toBe(1);
    expect(dash.myActions.map((x: any) => x.description)).toContain('自分のAction');
    expect(dash.counts.needsReview).toBeGreaterThanOrEqual(1);
    for (const k of ['today', 'upcoming', 'needsReview', 'myActions', 'myCommitments', 'waitingOnOthers', 'overdue', 'decisionsChanged', 'openQuestions']) expect(dash).toHaveProperty(k);
  });

  it('templates: built-ins + custom (admin only); custom tone drives follow-up wording', async () => {
    const list = (await owner.client.get(`/api/w/${ws}/templates`)).body.items;
    expect(list.filter((t: any) => t.builtIn).length).toBeGreaterThanOrEqual(8);
    const denied = await bob.client.post(`/api/w/${ws}/templates`, { key: 'casual_client', name: 'x', meetingType: 'client' });
    expect(denied.status).toBe(403);
    const reserved = await owner.client.post(`/api/w/${ws}/templates`, { key: 'client', name: 'x', meetingType: 'client' });
    expect(reserved.status).toBe(409);
    const created = await owner.client.post(`/api/w/${ws}/templates`, {
      key: 'casual_client',
      name: 'カジュアル顧客',
      meetingType: 'client',
      followupStyle: { tone: 'casual' },
      agenda: ['近況'],
    });
    expect(created.status).toBe(200);
    expect(created.body.followupStyle.tone).toBe('casual');
    expect(created.body.followupStyle.defaultKinds.length).toBeGreaterThan(0);
    expect((await owner.client.post(`/api/w/${ws}/templates`, { key: 'casual_client', name: 'dup', meetingType: 'client' })).status).toBe(409);
    const m = await meeting(owner.client, { title: 'カジュアル', meetingType: 'client', templateKey: 'casual_client', scheduledStart: '2026-09-30T01:00:00Z' });
    const f = (await owner.client.post(`/api/w/${ws}/meetings/${m.id}/followups`, { kind: 'thank_you_email' })).body;
    expect(f.tone).toBe('casual');
    expect(f.body).toContain('今日はありがとうございました！');
    const after = (await owner.client.get(`/api/w/${ws}/templates`)).body.items;
    expect(after.find((t: any) => t.key === 'casual_client').builtIn).toBe(false);
  });
});
