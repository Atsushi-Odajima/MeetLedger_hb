import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { createMeeting, extract, ledger, transcript, type Owner } from './ledger-helpers';
import { dnsResolver } from '../src/modules/connectors/netguard';

let env: TestEnv;
let o: Owner;
let ws: string;

beforeAll(async () => {
  env = await createTestEnv();
  o = await env.setupOwner('owner@example.com');
  ws = o.workspaceId;
});
afterAll(async () => env?.close());

const W = () => `/api/w/${ws}`;

describe('ledger: AI extraction (local-rules), review, decisions, actions, commitments, questions', () => {
  let m5: any;
  let seg5: string[];
  let d5: any;

  it('#5 AI抽出のDecisionはCandidate（人間確認前はConfirmedにならない）', async () => {
    m5 = await createMeeting(o.client, ws, { title: '#5 定例' });
    const t = await transcript(env, o.orgId, m5.id, [
      { speaker: 'Speaker 1', text: 'それでは始めます。' },
      { speaker: 'Speaker 1', text: '公開日は10月にします。' },
      { speaker: 'Speaker 2', text: '了解です。' },
    ]);
    seg5 = t.segmentIds;
    const r = await extract(env, o.client, ws, m5.id);
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe('local-rules');
    expect(r.body.isLocal).toBe(true);
    const l = await ledger(o.client, ws, m5.id);
    expect(l.decisions).toHaveLength(1);
    d5 = l.decisions[0];
    expect(d5.reviewState).toBe('candidate');
    expect(d5.status).toBe('active');
    expect(d5.extractedBy).toBe('ai');
    expect(d5.aiProvider).toBe('local-rules');
    expect(d5.topic).toBe('公開日');
    const current = await o.client.get(`${W()}/decisions?view=current`);
    expect(current.body.items.map((d: any) => d.id)).not.toContain(d5.id);
    const cands = await o.client.get(`${W()}/decisions?view=candidates`);
    expect(cands.body.items.map((d: any) => d.id)).toContain(d5.id);
    // local-rules never touches the network
    expect(env.http.calls).toHaveLength(0);
    const meeting = await o.client.get(`${W()}/meetings/${m5.id}`);
    expect(meeting.body.status).toBe('needs_review');
    const summary = await o.client.get(`${W()}/meetings/${m5.id}/summary`);
    expect(summary.body.aiGenerated).toBe(true);
    expect(summary.body.sections.executive).toContain('公開日は10月にします');
    expect(summary.body.sections.topics[0].title).toBe('公開日');
    expect(summary.body.sections.topics[0].source.segmentIds).toEqual([seg5[1]]);
  });

  it('#6 Confirmed Decisionは発言範囲（segment ids + ms）を保持する', async () => {
    const acc = await o.client.post(`${W()}/review/decision/${d5.id}/accept`, {});
    expect(acc.status).toBe(200);
    expect(acc.body.item.reviewState).toBe('confirmed');
    const d = await o.client.get(`${W()}/decisions/${d5.id}`);
    expect(d.body.reviewState).toBe('confirmed');
    expect(d.body.source).toMatchObject({ meetingId: m5.id, segmentIds: [seg5[1]], startMs: 5000, endMs: 9500, quote: '公開日は10月にします。', status: 'ok' });
    expect(d.body.source.meetingTitle).toBe('#5 定例');
    const current = await o.client.get(`${W()}/decisions?view=current`);
    expect(current.body.items.map((x: any) => x.id)).toContain(d5.id);
  });

  it('meeting Ask: 根拠セグメントのタイムスタンプ付きで回答し、無い場合は「記録からは分かりません」', async () => {
    const a = await o.client.post(`${W()}/meetings/${m5.id}/ask`, { question: '公開日はいつですか？' });
    expect(a.status).toBe(200);
    expect(a.body.insufficient).toBe(false);
    expect(a.body.provider).toBe('local-rules');
    expect(a.body.answer).toContain('公開日は10月にします');
    expect(a.body.citations[0]).toMatchObject({ entityType: 'segment', entityId: seg5[1], meetingId: m5.id, startMs: 5000, endMs: 9500 });
    const u = await o.client.post(`${W()}/meetings/${m5.id}/ask`, { question: '予算の上限はいくらですか？' });
    expect(u.body.insufficient).toBe(true);
    expect(u.body.answer).toBe('記録からは分かりません');
    expect(u.body.citations).toEqual([]);
  });

  it('#29 抽出後にTranscriptを編集するとsource statusがeditedになり、ids/quoteは保持される', async () => {
    await env.tenantTx(o.orgId, async (db) => {
      await db.query("UPDATE transcript_segments SET text='公開日は10月下旬にします。', revision=revision+1, edited_by=$2, edited_at=now() WHERE id=$1", [seg5[1], o.userId]);
      await db.query(
        "INSERT INTO segment_revisions(org_id, segment_id, revision, old_text, new_text, edited_by) VALUES ($1,$2,2,'公開日は10月にします。','公開日は10月下旬にします。',$3)",
        [o.orgId, seg5[1], o.userId],
      );
    });
    const d = await o.client.get(`${W()}/decisions/${d5.id}`);
    expect(d.body.source.status).toBe('edited');
    expect(d.body.source.segmentIds).toEqual([seg5[1]]);
    expect(d.body.source.quote).toBe('公開日は10月にします。');
    expect(d.body.source.startMs).toBe(5000);
    const s = await o.client.get(`${W()}/meetings/${m5.id}/summary`);
    expect(s.body.sections.topics[0].source.status).toBe('edited');
  });

  it('#7 Supersede: 古いDecisionは削除されずSupersededになり、current viewは新しいものだけ', async () => {
    const r = await o.client.post(`${W()}/decisions/${d5.id}/supersede`, { text: '公開日は11月にする' });
    expect(r.status).toBe(200);
    expect(r.body.old).toMatchObject({ id: d5.id, status: 'superseded', supersededByDecisionId: r.body.new.id, reviewState: 'confirmed' });
    expect(r.body.new).toMatchObject({ status: 'active', reviewState: 'confirmed', supersedesDecisionId: d5.id, topic: '公開日' });
    const current = await o.client.get(`${W()}/decisions?view=current`);
    const ids = current.body.items.map((x: any) => x.id);
    expect(ids).toContain(r.body.new.id);
    expect(ids).not.toContain(d5.id);
    const sup = await o.client.get(`${W()}/decisions?view=superseded`);
    expect(sup.body.items.map((x: any) => x.id)).toContain(d5.id);
    expect((await o.client.get(`${W()}/decisions/${d5.id}`)).status).toBe(200);
    const h = await o.client.get(`${W()}/decisions/${r.body.new.id}/history`);
    expect(h.body.chain.map((x: any) => x.id)).toEqual([d5.id, r.body.new.id]);
    expect(h.body.current.id).toBe(r.body.new.id);
    expect(h.body.events.map((e: any) => e.event)).toEqual(expect.arrayContaining(['extracted', 'accepted', 'superseded', 'supersedes', 'created']));
    // superseding again from the old one is refused
    expect((await o.client.post(`${W()}/decisions/${d5.id}/supersede`, { text: 'x' })).status).toBe(409);
  });

  it('#8 担当/期限が不明なActionはnull（捏造しない）、相対期限は推測フラグ付き', async () => {
    const m = await createMeeting(o.client, ws, { title: '#8 Project sync', participants: [{ name: '田中 一郎' }] });
    const tanaka = m.participants.find((p: any) => p.displayName === '田中 一郎').personId;
    await transcript(env, o.orgId, m.id, [
      { speaker: 'Speaker 1', text: '資料の修正が必要です。' },
      { speaker: 'Speaker 1', text: '来週金曜までに見積もりを作成してください。' },
      { speaker: 'Speaker 2', text: '田中さんが10月15日までに提案書を作成します。' },
    ]);
    await extract(env, o.client, ws, m.id);
    const l = await ledger(o.client, ws, m.id);
    expect(l.actions).toHaveLength(3);
    const a1 = l.actions.find((a: any) => a.description.startsWith('資料の修正'));
    const a2 = l.actions.find((a: any) => a.description.includes('見積もり'));
    const a3 = l.actions.find((a: any) => a.description.includes('提案書'));
    expect(a1).toMatchObject({ status: 'candidate', assigneePersonId: null, assigneeUserId: null, assigneeText: null, dueDate: null, dueText: null, assigneeInferred: false, dueInferred: false });
    expect(a2).toMatchObject({ assigneePersonId: null, assigneeText: null, dueDate: '2026-10-09', dueText: '来週金曜', dueInferred: true });
    expect(a3).toMatchObject({ assigneePersonId: tanaka, assigneeText: '田中', assigneeInferred: false, dueDate: '2026-10-15', dueInferred: false });
    const review = await o.client.get(`${W()}/review?meetingId=${m.id}`);
    const f1 = review.body.items.find((i: any) => i.item.id === a1.id);
    expect(f1.flags).toMatchObject({ missingOwner: true, missingDue: true, assigneeInferred: false });
    expect(review.body.items.find((i: any) => i.item.id === a2.id).flags.dueInferred).toBe(true);
    // accepting an inferred due date requires explicit confirmation or an edit
    const bad = await o.client.post(`${W()}/review/action/${a2.id}/accept`, {});
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toMatchObject({ code: 'confirm_inferred_required', fields: ['due'] });
    const ok = await o.client.post(`${W()}/review/action/${a2.id}/accept`, { confirmInferred: true });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ status: 'confirmed', dueDate: '2026-10-09', dueInferred: false });
    // an explicit edit of the due date also satisfies the rule
    const m2 = await createMeeting(o.client, ws, { title: '#8b' });
    await transcript(env, o.orgId, m2.id, [{ speaker: 'Speaker 1', text: '明日までに議事録を共有してください。' }]);
    await extract(env, o.client, ws, m2.id);
    const a4 = (await ledger(o.client, ws, m2.id)).actions[0];
    expect(a4).toMatchObject({ dueDate: '2026-10-02', dueInferred: true });
    const edited = await o.client.post(`${W()}/review/action/${a4.id}/accept`, { edits: { dueDate: '2026-10-05' } });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ status: 'confirmed', dueDate: '2026-10-05', dueInferred: false, dueText: null });
  });

  it('#9 Commitment: 話者マッピング→Personで promisedBy/To を記録し、自分/相手の方向を区別する', async () => {
    const m = await createMeeting(o.client, ws, {
      title: '#9 Client',
      meetingType: 'client',
      participants: [
        { name: '佐藤 花子', email: 'owner@example.com' },
        { name: '山田 太郎', email: 'yamada@client.example' },
      ],
    });
    const sato = m.participants.find((p: any) => p.displayName === '佐藤 花子').personId;
    const yamada = m.participants.find((p: any) => p.displayName === '山田 太郎').personId;
    const t = await transcript(env, o.orgId, m.id, [
      { speaker: 'Speaker 1', text: '山田様に見積書を金曜日までにお送りします。' },
      { speaker: 'Speaker 2', text: 'ありがとうございます。弊社からも来週中に要件をご共有します。' },
    ]);
    await env.tenantTx(o.orgId, async (db) => {
      await db.query('UPDATE meeting_speakers SET person_id=$1 WHERE meeting_id=$2 AND label=$3', [sato, m.id, 'Speaker 1']);
      await db.query('UPDATE meeting_speakers SET person_id=$1 WHERE meeting_id=$2 AND label=$3', [yamada, m.id, 'Speaker 2']);
    });
    await extract(env, o.client, ws, m.id);
    const l = await ledger(o.client, ws, m.id);
    expect(l.commitments).toHaveLength(2);
    const mine = l.commitments.find((c: any) => c.description.includes('見積書'));
    const theirs = l.commitments.find((c: any) => c.description.includes('要件'));
    expect(mine).toMatchObject({
      status: 'candidate',
      promisedByPersonId: sato,
      promisedBySpeakerId: t.speakerIds['Speaker 1'],
      promisedByText: '佐藤 花子',
      promisedToPersonId: yamada,
      promisedToText: '山田',
      dueDate: '2026-10-02',
      dueInferred: true,
      direction: 'mine',
    });
    expect(theirs).toMatchObject({ promisedByPersonId: yamada, promisedToPersonId: null, dueDate: '2026-10-09', direction: 'theirs' });
    for (const c of [mine, theirs]) expect((await o.client.post(`${W()}/review/commitment/${c.id}/accept`, { confirmInferred: true })).status).toBe(200);
    const listMine = await o.client.get(`${W()}/commitments?direction=mine&status=open`);
    expect(listMine.body.items.map((c: any) => c.id)).toEqual([mine.id]);
    const listTheirs = await o.client.get(`${W()}/commitments?direction=theirs&status=open`);
    expect(listTheirs.body.items.map((c: any) => c.id)).toEqual([theirs.id]);
    // no reminder / message is ever sent to the other party
    expect(env.http.calls).toHaveLength(0);
  });

  it('#10 未解決の質問はCandidateとして抽出され、Accept後もopenのまま', async () => {
    const m = await createMeeting(o.client, ws, { title: '#10' });
    await transcript(env, o.orgId, m.id, [
      { speaker: 'Speaker 1', text: '予算の上限はまだ未定です。' },
      { speaker: 'Speaker 2', text: '納期はいつになりますか？' },
      { speaker: 'Speaker 1', text: 'よろしいですか？' },
    ]);
    await extract(env, o.client, ws, m.id);
    const l = await ledger(o.client, ws, m.id);
    expect(l.questions.map((q: any) => q.question).sort()).toEqual(['予算の上限はまだ未定です', '納期はいつになりますか？'].sort());
    for (const q of l.questions) {
      expect(q.status).toBe('candidate');
      const r = await o.client.post(`${W()}/review/question/${q.id}/accept`, {});
      expect(r.body.item.status).toBe('open');
    }
    const open = await o.client.get(`${W()}/questions?status=open&meetingId=${m.id}`);
    expect(open.body.items).toHaveLength(2);
    expect(open.body.items.every((q: any) => q.status === 'open' && q.answerText === null)).toBe(true);
    // answering is an explicit human action
    const ans = await o.client.patch(`${W()}/questions/${l.questions[0].id}`, { status: 'answered', answerText: '来週確認' });
    expect(ans.body.status).toBe('answered');
  });

  it('#30 Review Inbox: accept / edit / reject と ledger_events、ACL', async () => {
    const m = await createMeeting(o.client, ws, { title: '#30 Review' });
    await transcript(env, o.orgId, m.id, [
      { speaker: 'Speaker 1', text: '価格は月額5万円で合意しました。' },
      { speaker: 'Speaker 2', text: 'デモ環境の準備をお願いします。' },
      { speaker: 'Speaker 1', text: '導入時期はまだ決まっていません。' },
    ]);
    await extract(env, o.client, ws, m.id);
    const inbox = await o.client.get(`${W()}/review?meetingId=${m.id}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.counts).toMatchObject({ decision: 1, action: 1, question: 1 });
    expect(inbox.body.unmappedSpeakers.map((s: any) => s.label).sort()).toEqual(['Speaker 1', 'Speaker 2']);
    const dec = inbox.body.items.find((i: any) => i.type === 'decision').item;
    const act = inbox.body.items.find((i: any) => i.type === 'action').item;
    const que = inbox.body.items.find((i: any) => i.type === 'question').item;
    expect(dec.topic).toBe('価格');

    // edit (stays candidate)
    const e = await o.client.patch(`${W()}/review/action/${act.id}`, { assigneeText: '鈴木', dueDate: '2026-10-20' });
    expect(e.status).toBe(200);
    expect(e.body.item).toMatchObject({ status: 'candidate', assigneeText: '鈴木', dueDate: '2026-10-20', dueInferred: false });
    // status cannot be smuggled through edits
    expect((await o.client.patch(`${W()}/review/action/${act.id}`, { status: 'confirmed' })).status).toBe(400);
    // nor through the resource endpoint for candidates
    expect((await o.client.patch(`${W()}/actions/${act.id}`, { status: 'done' })).status).toBe(409);

    // accept with edits / reject
    const a = await o.client.post(`${W()}/review/decision/${dec.id}/accept`, { edits: { text: '価格は月額5万円（税別）で合意' } });
    expect(a.body.item).toMatchObject({ reviewState: 'confirmed', text: '価格は月額5万円（税別）で合意' });
    expect(a.body.item.source.quote).toBe('価格は月額5万円で合意しました。');
    const rj = await o.client.post(`${W()}/review/question/${que.id}/reject`, { reason: '不要' });
    expect(rj.body.item.status).toBe('rejected');
    expect((await o.client.post(`${W()}/review/question/${que.id}/accept`, {})).status).toBe(409);

    const ev = await o.client.get(`${W()}/review/action/${act.id}/events`);
    expect(ev.body.items.map((x: any) => x.event)).toEqual(['extracted', 'edited']);
    const evd = await o.client.get(`${W()}/review/decision/${dec.id}/events`);
    expect(evd.body.items.map((x: any) => x.event)).toEqual(['extracted', 'accepted']);
    expect(evd.body.items[1].byUserId).toBe(o.userId);

    // re-run: confirmed / rejected / human-edited items are never duplicated
    await extract(env, o.client, ws, m.id, true);
    const l = await ledger(o.client, ws, m.id);
    expect(l.decisions).toHaveLength(1);
    expect(l.actions).toHaveLength(1);
    expect(l.actions[0].id).toBe(act.id);
    expect(l.questions).toHaveLength(0);
    const all = await ledgerWithRejected(m.id);
    expect(all.questions).toHaveLength(1);

    // RBAC: viewer cannot accept; a member without access to a private meeting gets 404
    const viewer = await env.addUser(o.client, o.orgId, ws, 'viewer30@example.com', 'viewer');
    expect((await viewer.client.post(`${W()}/review/action/${act.id}/accept`, {})).status).toBe(403);
    const priv = await createMeeting(o.client, ws, { title: '1on1 private', meetingType: 'one_on_one' });
    await transcript(env, o.orgId, priv.id, [{ speaker: 'Speaker 1', text: '評価面談の資料を作成してください。' }]);
    await extract(env, o.client, ws, priv.id);
    const privAction = (await ledger(o.client, ws, priv.id)).actions[0];
    const bob = await env.addUser(o.client, o.orgId, ws, 'bob30@example.com', 'member');
    expect((await bob.client.post(`${W()}/review/action/${privAction.id}/accept`, {})).status).toBe(404);
    expect((await bob.client.get(`${W()}/actions/${privAction.id}`)).status).toBe(404);
    const bobInbox = await bob.client.get(`${W()}/review`);
    expect(bobInbox.body.items.map((i: any) => i.item.id)).not.toContain(privAction.id);
    const bobActions = await bob.client.get(`${W()}/actions`);
    expect(bobActions.body.items.map((x: any) => x.id)).not.toContain(privAction.id);
    expect((await bob.client.get(`${W()}/meetings/${priv.id}/ledger`)).status).toBe(404);
  });

  async function ledgerWithRejected(meetingId: string) {
    return (await o.client.get(`${W()}/meetings/${meetingId}/ledger?includeRejected=1`)).body;
  }

  it('E2E-2 10月公開 → 11月公開 → Contradiction → change で旧Decisionは削除されずSuperseded', async () => {
    const p = await o.client.post(`${W()}/projects`, { name: 'Website renewal' });
    expect(p.status).toBe(200);
    const m1 = await createMeeting(o.client, ws, { title: 'E2E-2 #1', projectId: p.body.id });
    await transcript(env, o.orgId, m1.id, [{ speaker: 'Speaker 1', text: '公開日は10月にします。' }]);
    await extract(env, o.client, ws, m1.id);
    const d1 = (await ledger(o.client, ws, m1.id)).decisions[0];
    await o.client.post(`${W()}/review/decision/${d1.id}/accept`, {});

    const m2 = await createMeeting(o.client, ws, { title: 'E2E-2 #2', projectId: p.body.id, scheduledStart: '2026-10-08T01:00:00Z' });
    await transcript(env, o.orgId, m2.id, [{ speaker: 'Speaker 1', text: '前回の件ですが、公開日は11月に変更しましょう。' }]);
    await extract(env, o.client, ws, m2.id);
    const l2 = await ledger(o.client, ws, m2.id);
    const d2 = l2.decisions[0];
    expect(d2).toMatchObject({ reviewState: 'candidate', topic: '公開日' });
    const open = await o.client.get(`${W()}/contradictions?status=open&meetingId=${m2.id}`);
    expect(open.body.items).toHaveLength(1);
    const c = open.body.items[0];
    expect(c.existingDecision.id).toBe(d1.id);
    expect(c.newDecision.id).toBe(d2.id);
    expect(c.reason).toContain('10月');
    expect(c.reason).toContain('11月');
    expect((await o.client.get(`${W()}/review?meetingId=${m2.id}`)).body.contradictions).toHaveLength(1);

    const res = await o.client.post(`${W()}/contradictions/${c.id}/resolve`, { resolution: 'change' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed_change');
    expect(res.body.existingDecision).toMatchObject({ id: d1.id, status: 'superseded', supersededByDecisionId: d2.id });
    expect(res.body.newDecision).toMatchObject({ id: d2.id, reviewState: 'confirmed', status: 'active', supersedesDecisionId: d1.id });
    const current = await o.client.get(`${W()}/decisions?view=current&projectId=${p.body.id}`);
    expect(current.body.items.map((x: any) => x.id)).toEqual([d2.id]);
    const old = await o.client.get(`${W()}/decisions/${d1.id}`);
    expect(old.status).toBe(200);
    expect(old.body.text).toBe('公開日は10月にします');
    const h = await o.client.get(`${W()}/decisions/${d2.id}/history`);
    expect(h.body.chain.map((x: any) => x.id)).toEqual([d1.id, d2.id]);
    expect((await o.client.post(`${W()}/contradictions/${c.id}/resolve`, { resolution: 'dismiss' })).status).toBe(409);
  });

  it('E2E-3 担当不明Action → 未割当Candidateのまま → 人が担当を決めて確認 → 完了', async () => {
    const m = await createMeeting(o.client, ws, { title: 'E2E-3' });
    await transcript(env, o.orgId, m.id, [{ speaker: 'Speaker 1', text: '議事録の作成をお願いします。' }]);
    await extract(env, o.client, ws, m.id);
    let a = (await ledger(o.client, ws, m.id)).actions[0];
    expect(a).toMatchObject({ status: 'candidate', assigneePersonId: null, assigneeUserId: null, assigneeText: null });
    // re-running extraction does not assign anybody nor duplicate the item
    await extract(env, o.client, ws, m.id, true);
    const again = (await ledger(o.client, ws, m.id)).actions;
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: 'candidate', assigneeUserId: null, assigneeText: null });
    a = again[0];
    const inbox = await o.client.get(`${W()}/review?meetingId=${m.id}`);
    expect(inbox.body.items.find((i: any) => i.item.id === a.id).flags.missingOwner).toBe(true);
    const assigned = await o.client.patch(`${W()}/review/action/${a.id}`, { assigneeUserId: o.userId });
    expect(assigned.body.item).toMatchObject({ status: 'candidate', assigneeUserId: o.userId, assigneeText: 'Owner', assigneeInferred: false });
    const acc = await o.client.post(`${W()}/review/action/${a.id}/accept`, {});
    expect(acc.body.item.status).toBe('confirmed');
    const mine = await o.client.get(`${W()}/actions?assignee=me&status=open`);
    expect(mine.body.items.map((x: any) => x.id)).toContain(a.id);
    const done = await o.client.patch(`${W()}/actions/${a.id}`, { status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');
    expect(done.body.completedAt).toBeTruthy();
    const ev = await o.client.get(`${W()}/review/action/${a.id}/events`);
    expect(ev.body.items.map((x: any) => x.event)).toEqual(['extracted', 'edited', 'accepted', 'status_changed']);
  });

  it('overdue はユーザーのタイムゾーンとclockで導出される', async () => {
    const r = await o.client.post(`${W()}/actions`, { description: '契約書の確認', dueDate: '2026-09-30', assigneeUserId: o.userId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'confirmed', extractedBy: 'user', overdue: true, assigneeUserId: o.userId });
    const fut = await o.client.post(`${W()}/actions`, { description: '来月の準備', dueDate: '2026-10-01' });
    expect(fut.body.overdue).toBe(false);
    const od = await o.client.get(`${W()}/actions?overdue=1`);
    const ids = od.body.items.map((x: any) => x.id);
    expect(ids).toContain(r.body.id);
    expect(ids).not.toContain(fut.body.id);
    env.clock.advance(86_400_000);
    expect((await o.client.get(`${W()}/actions/${fut.body.id}`)).body.overdue).toBe(true);
    env.clock.advance(-86_400_000);
  });

  it('Transcriptが無いMeetingはメモ行を疑似セグメントとして抽出（quoteのみ、タイムスタンプなし）', async () => {
    const m = await createMeeting(o.client, ws, { title: 'Notes only' });
    expect((await o.client.put(`${W()}/meetings/${m.id}/notes`, { body: '- 決定: 公開日は10月にします\n- 田中さんが資料を作成します', baseVersion: 0 })).status).toBe(200);
    await extract(env, o.client, ws, m.id);
    const l = await ledger(o.client, ws, m.id);
    expect(l.decisions[0].source).toMatchObject({ segmentIds: [], startMs: null, endMs: null, quote: '決定: 公開日は10月にします' });
    expect(l.actions[0]).toMatchObject({ assigneeText: '田中', status: 'candidate' });
  });

  it('AI OFF Meetingは抽出・Askを拒否し、何も作られない', async () => {
    const m = await createMeeting(o.client, ws, { title: 'AI OFF', aiEnabled: false });
    await transcript(env, o.orgId, m.id, [{ speaker: 'Speaker 1', text: '公開日は12月にします。' }]);
    const r = await o.client.post(`${W()}/meetings/${m.id}/extract`, {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('policy_denied');
    const ask = await o.client.post(`${W()}/meetings/${m.id}/ask`, { question: '公開日は？' });
    expect(ask.body).toMatchObject({ insufficient: true, provider: 'none', aiGenerated: false, excludedMeetings: 1 });
    const l = await ledger(o.client, ws, m.id);
    expect(l.decisions).toHaveLength(0);
  });

  it('Coach は事実ベースの指標のみ（話者順は登場順、ランキング・評価なし）', async () => {
    const m = await createMeeting(o.client, ws, { title: 'Coach' });
    await transcript(env, o.orgId, m.id, [
      { speaker: 'Speaker 1', text: '今日の議題はリリース計画についてです。', startMs: 0, endMs: 2000 },
      { speaker: 'Speaker 2', text: 'テスト環境の準備をお願いします。', startMs: 2000, endMs: 8000 },
      { speaker: 'Speaker 1', text: '納期はいつですか？', startMs: 8000, endMs: 10000 },
    ]);
    await extract(env, o.client, ws, m.id);
    const c = await o.client.get(`${W()}/meetings/${m.id}/coach`);
    expect(c.status).toBe(200);
    expect(c.body.factsOnly).toBe(true);
    expect(c.body.disclaimer).toContain('能力・性格・感情');
    expect(c.body.durationMs).toBe(10000);
    expect(c.body.speakers.map((s: any) => s.label)).toEqual(['Speaker 1', 'Speaker 2']);
    expect(c.body.speakers.map((s: any) => s.share)).toEqual([0.4, 0.6]);
    expect(c.body).toMatchObject({ openQuestions: 1, actions: 1, actionsWithoutOwner: 1, actionsWithoutDue: 1, decisionCount: 0 });
    expect(c.body.topicsWithoutDecision).toContain('リリース計画');
    expect(JSON.stringify(c.body)).not.toMatch(/rank|score|personality|emotion/i);
  });

  it('抽出ジョブキーは音声パイプラインと共通（ai:<transcriptId>）で二重実行しない／メモのみはメモ版ごと', async () => {
    const m = await createMeeting(o.client, ws, { title: 'Job key' });
    const t = await transcript(env, o.orgId, m.id, [{ speaker: 'Speaker 1', text: '公開日は10月にします。' }]);
    // what modules/audio does after writing a transcript
    const pj = await env.tenantTx(o.orgId, (db) =>
      env.deps.jobs.enqueue(db, { orgId: o.orgId, type: 'ai.extract', key: `ai:${t.transcriptId}`, payload: { meetingId: m.id, transcriptId: t.transcriptId } }),
    );
    await env.worker.drain();
    const r = await o.client.post(`${W()}/meetings/${m.id}/extract`, {});
    expect(r.body).toMatchObject({ jobId: pj.id, created: false, status: 'succeeded' });
    const rr = await o.client.post(`${W()}/meetings/${m.id}/extract`, { rerun: true });
    expect(rr.body).toMatchObject({ jobId: pj.id, status: 'queued' });
    await env.worker.drain();
    expect((await ledger(o.client, ws, m.id)).decisions).toHaveLength(1);

    const n = await createMeeting(o.client, ws, { title: 'Notes key' });
    await o.client.put(`${W()}/meetings/${n.id}/notes`, { body: '公開日は10月にします', baseVersion: 0 });
    const j1 = await o.client.post(`${W()}/meetings/${n.id}/extract`, {});
    expect(j1.body.created).toBe(true);
    await env.worker.drain();
    expect((await o.client.post(`${W()}/meetings/${n.id}/extract`, {})).body).toMatchObject({ jobId: j1.body.jobId, created: false });
    await o.client.put(`${W()}/meetings/${n.id}/notes`, { body: '公開日は10月にします\n見積もりを作成してください', baseVersion: 1 });
    const j2 = await o.client.post(`${W()}/meetings/${n.id}/extract`, {});
    expect(j2.body.created).toBe(true);
    expect(j2.body.jobId).not.toBe(j1.body.jobId);
    await env.worker.drain();
    const l = await ledger(o.client, ws, n.id);
    expect(l.decisions).toHaveLength(1);
    expect(l.actions).toHaveLength(1);
  });

  it('Webhookは人が確定・変更したときだけ、idのみで発行される（AI候補では発行しない）', async () => {
    // deterministic DNS for the connectors SSRF guard (no real resolver / network)
    const original = dnsResolver.lookup;
    dnsResolver.lookup = async () => ['93.184.216.34'];
    const wh = await o.client.post(`${W()}/webhooks`, { url: 'https://hooks.example.com/ledger', events: ['decision.confirmed', 'decision.changed', 'action.created'] });
    dnsResolver.lookup = original;
    expect(wh.status).toBe(200);
    const deliveries = () =>
      env.tenantTx(o.orgId, async (db) => (await db.query('SELECT event, payload::text AS payload FROM webhook_deliveries WHERE workspace_id=$1 ORDER BY created_at', [ws])).rows);
    const m = await createMeeting(o.client, ws, { title: 'Webhook' });
    await transcript(env, o.orgId, m.id, [{ speaker: 'Speaker 1', text: '価格は月額3万円で合意しました。' }]);
    await extract(env, o.client, ws, m.id);
    expect(await deliveries()).toHaveLength(0);
    const d = (await ledger(o.client, ws, m.id)).decisions[0];
    await o.client.post(`${W()}/review/decision/${d.id}/accept`, {});
    const after = await deliveries();
    expect(after.map((x: any) => x.event)).toEqual(['decision.confirmed']);
    expect(after[0].payload).toContain(d.id);
    expect(after[0].payload).not.toContain('3万円');
    await o.client.post(`${W()}/decisions/${d.id}/supersede`, { text: '価格は月額4万円にする' });
    expect((await deliveries()).map((x: any) => x.event)).toEqual(['decision.confirmed', 'decision.changed', 'decision.confirmed']);
  });

  it('一覧はkeysetページング（limit + cursor + total）、不正なcursorは400', async () => {
    const all = await o.client.get(`${W()}/decisions?view=all`);
    const n = all.body.total;
    expect(n).toBeGreaterThan(4);
    const seen: string[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const r: any = await o.client.get(`${W()}/decisions?view=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      expect(r.body.total).toBe(first ? n : null);
      first = false;
      seen.push(...r.body.items.map((d: any) => d.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(n);
    expect(new Set(seen).size).toBe(n);
    expect(seen).toEqual(all.body.items.map((d: any) => d.id));
    const acts = await o.client.get(`${W()}/actions?limit=1`);
    expect(acts.body.items).toHaveLength(1);
    expect(acts.body.nextCursor).toBeTruthy();
    const next = await o.client.get(`${W()}/actions?limit=1&cursor=${acts.body.nextCursor}`);
    expect(next.body.items[0].id).not.toBe(acts.body.items[0].id);
    expect((await o.client.get(`${W()}/actions?cursor=bm90LWEtY3Vyc29y`)).status).toBe(400);
    expect((await o.client.get(`${W()}/decisions?limit=1000`)).status).toBe(400);
  });

  it('Review Inboxは会議ごとにグループ化され、全体件数・会議別件数・ページングを返す', async () => {
    const full = await o.client.get(`${W()}/review?groupLimit=50&limit=300`);
    expect(full.status).toBe(200);
    const totalItems = full.body.counts.decision + full.body.counts.action + full.body.counts.commitment + full.body.counts.question;
    expect(full.body.total).toBe(totalItems);
    expect(full.body.items).toHaveLength(totalItems);
    expect(full.body.nextCursor).toBeNull();
    expect(full.body.groups.reduce((s: number, g: any) => s + g.total, 0)).toBe(totalItems);
    // newest meeting first, every item belongs to a listed group
    const groupIds = full.body.groups.map((g: any) => g.meetingId);
    expect(full.body.items.every((i: any) => groupIds.includes(i.item.meetingId))).toBe(true);
    const dates = full.body.groups.map((g: any) => g.meetingDate);
    expect([...dates].sort().reverse()).toEqual(dates);
    // one meeting per page: pages cover every group exactly once, counts stay inbox-wide
    const pagedGroups: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await o.client.get(`${W()}/review?groupLimit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.body.groups).toHaveLength(1);
      expect(r.body.counts).toEqual(full.body.counts);
      expect(r.body.items.every((i: any) => i.item.meetingId === r.body.groups[0].meetingId)).toBe(true);
      pagedGroups.push(r.body.groups[0].meetingId);
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(pagedGroups).toEqual(groupIds);
    // type filter: only meetings with that type, only items of that type
    const onlyQ = await o.client.get(`${W()}/review?type=action`);
    expect(onlyQ.body.items.every((i: any) => i.type === 'action')).toBe(true);
    expect(onlyQ.body.groups.every((g: any) => g.counts.action > 0)).toBe(true);
    // per-meeting paging of items
    const g = full.body.groups.find((x: any) => x.total >= 2);
    const p1 = await o.client.get(`${W()}/review?meetingId=${g.meetingId}&limit=1`);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.groups[0].counts).toEqual(g.counts);
    const p2 = await o.client.get(`${W()}/review?meetingId=${g.meetingId}&limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].item.id).not.toBe(p1.body.items[0].item.id);
    // speakers / participants carry an `id` (web UI key)
    expect(full.body.unmappedSpeakers.every((s: any) => s.id && s.id === s.speakerId)).toBe(true);
    // unknown or invisible meeting -> 404
    expect((await o.client.get(`${W()}/review?meetingId=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('矛盾候補の検出は有界（新しい決定1件につき最新の競合3件まで）', async () => {
    for (const day of [1, 2, 3, 4, 5]) {
      const r = await o.client.post(`${W()}/decisions`, { text: `リリース日は11月${day}日にします`, topic: 'リリース日' });
      expect(r.status).toBe(200);
    }
    const m = await createMeeting(o.client, ws, { title: 'Bounded contradictions' });
    await transcript(env, o.orgId, m.id, [{ speaker: 'Speaker 1', text: 'リリース日は11月20日にします。' }]);
    await extract(env, o.client, ws, m.id);
    const d = (await ledger(o.client, ws, m.id)).decisions[0];
    expect(d.topic).toBe('リリース日');
    const c = await o.client.get(`${W()}/contradictions?status=open&meetingId=${m.id}`);
    const mine = c.body.items.filter((x: any) => x.newDecision.id === d.id);
    expect(mine).toHaveLength(3);
    // the newest conflicting decisions are the ones reported
    expect(mine.map((x: any) => x.existingDecision.text).sort()).toEqual(['リリース日は11月3日にします', 'リリース日は11月4日にします', 'リリース日は11月5日にします']);
  });

  it('ログに会議本文を出さない', () => {
    const all = env.logs.join('\n');
    expect(all).not.toContain('公開日は10月');
    expect(all).not.toContain('見積書');
  });
});
