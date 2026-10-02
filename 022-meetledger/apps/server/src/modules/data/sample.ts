// Sample Workspace: a SEPARATE organization (is_sample=true) + workspace (is_sample=true) per user, filled with
// fictional data only (names "Sample ...", emails @example.com). Tenant isolation (RLS + workspace filters) keeps it
// apart from production workspaces: it never appears in production meetings, search or RAG.
import { dateInTz, toTsvectorLiteral } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, withSystem, withTenant, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { createOrgWithWorkspace } from '../core/auth';

export const SAMPLE_ORG_NAME = 'Sample Organization（架空データ）';
export const SAMPLE_WORKSPACE_NAME = 'Sample Workspace';
const DAY = 86_400_000;

export interface SampleResult {
  orgId: string;
  workspaceId: string;
  created: boolean;
}

/** Idempotent per user: returns the existing sample org/workspace or creates and seeds one. */
export async function ensureSampleWorkspace(deps: Deps, userId: string): Promise<SampleResult> {
  const r = await withSystem(deps.pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('meetledger:sample:' || $1::text))", [userId]);
    const user = await one<{ id: string }>(db, 'SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL', [userId]);
    if (!user) throw notFound('User not found');
    const existing = await one<{ org_id: string; ws_id: string }>(
      db,
      `SELECT o.id AS org_id, w.id AS ws_id FROM organizations o
         JOIN org_members om ON om.org_id = o.id AND om.user_id = $1
         JOIN workspaces w ON w.org_id = o.id AND w.is_sample AND w.deleted_at IS NULL
        WHERE o.is_sample ORDER BY o.created_at LIMIT 1`,
      [userId],
    );
    if (existing) return { orgId: existing.org_id, workspaceId: existing.ws_id, created: false };
    const ids = await createOrgWithWorkspace(db, userId, SAMPLE_ORG_NAME, SAMPLE_WORKSPACE_NAME, true);
    return { ...ids, created: true };
  });
  if (!r.created) return r;
  try {
    await withTenant(deps.pool, r.orgId, (db) => seedSample(deps, db, r.orgId, r.workspaceId, userId));
  } catch (e) {
    // Never leave a half-seeded sample organization behind.
    await withSystem(deps.pool, (db) => db.query('DELETE FROM organizations WHERE id=$1 AND is_sample', [r.orgId])).catch(() => undefined);
    throw e;
  }
  return r;
}

interface SegIn {
  who: string;
  text: string;
}

async function seedSample(deps: Deps, db: Db, orgId: string, wsId: string, userId: string) {
  const now = deps.clock.now();
  const at = (days: number, utcHour: number) => {
    const d = new Date(now.getTime() + days * DAY);
    d.setUTCHours(utcHour, 0, 0, 0);
    return d;
  };
  const today = dateInTz(now, 'Asia/Tokyo');
  const dateOffset = (days: number) => dateInTz(new Date(now.getTime() + days * DAY), 'Asia/Tokyo');
  const ins = async (sql: string, params: unknown[]) => (await one<{ id: string }>(db, `${sql} RETURNING id`, params))!.id;

  // ---- people (fictional) + "you"
  const ceo = await ins(`INSERT INTO people(org_id, workspace_id, name, organization, role_title, email, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    orgId,
    wsId,
    'Sample CEO',
    'Alpha株式会社（架空）',
    'CEO',
    'sample.ceo@example.com',
    ['sample', 'client'],
    userId,
  ]);
  const pm = await ins(`INSERT INTO people(org_id, workspace_id, name, organization, role_title, email, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    orgId,
    wsId,
    'Sample PM',
    'Sample SaaS社（架空）',
    'プロダクトマネージャー',
    'sample.pm@example.com',
    ['sample'],
    userId,
  ]);
  const me = await ins(`INSERT INTO people(org_id, workspace_id, name, organization, role_title, tags, user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [
    orgId,
    wsId,
    'あなた（サンプル）',
    'Sample SaaS社（架空）',
    'セールス',
    ['sample'],
    userId,
  ]);
  await db.query('INSERT INTO person_notes(org_id, workspace_id, person_id, body, author_user_id) VALUES ($1,$2,$3,$4,$5)', [
    orgId,
    wsId,
    ceo,
    '架空の人物です。サンプルデータとして価格交渉の流れを確認できます。',
    userId,
  ]);

  // ---- projects & series
  const launch = await ins(`INSERT INTO projects(org_id, workspace_id, name, kind, description, created_by) VALUES ($1,$2,$3,'project',$4,$5)`, [
    orgId,
    wsId,
    'Sample SaaS Launch',
    '架空のSaaS製品のローンチプロジェクト（サンプル）',
    userId,
  ]);
  const alpha = await ins(`INSERT INTO projects(org_id, workspace_id, name, kind, client_name, description, created_by) VALUES ($1,$2,$3,'client',$4,$5,$6)`, [
    orgId,
    wsId,
    'Client Alpha',
    'Alpha株式会社（架空）',
    '架空のクライアント（サンプル）',
    userId,
  ]);
  const weekly = await ins(
    `INSERT INTO series(org_id, workspace_id, title, cadence, project_id, meeting_type, default_visibility, created_by) VALUES ($1,$2,$3,'weekly',$4,'internal','workspace',$5)`,
    [orgId, wsId, 'Weekly Product', launch, userId],
  );

  const meeting = async (m: { title: string; start: Date; minutes: number; type: string; projectId: string | null; seriesId: string | null; visibility: string; status: string; recorded: boolean }) => {
    const end = new Date(m.start.getTime() + m.minutes * 60_000);
    const past = m.status !== 'scheduled';
    return ins(
      `INSERT INTO meetings(org_id, workspace_id, title, scheduled_start, scheduled_end, started_at, ended_at, source, meeting_type, project_id, series_id, visibility,
                            consent_state, transcription_mode, ai_enabled, status, language, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'sample',$8,$9,$10,$11,$12,'local',true,$13,'ja',$14)`,
      [orgId, wsId, m.title, m.start, end, past ? m.start : null, past ? end : null, m.type, m.projectId, m.seriesId, m.visibility, m.recorded ? 'confirmed' : 'not_recording', m.status, userId],
    );
  };
  const participants = async (meetingId: string, list: { personId: string; name: string; email: string | null; role: string; userId?: string | null }[]) => {
    for (const p of list)
      await db.query('INSERT INTO participants(org_id, meeting_id, person_id, user_id, display_name, email, role) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        orgId,
        meetingId,
        p.personId,
        p.userId ?? null,
        p.name,
        p.email,
        p.role,
      ]);
  };
  const P = {
    me: { personId: me, name: 'あなた（サンプル）', email: null, userId },
    pm: { personId: pm, name: 'Sample PM', email: 'sample.pm@example.com' },
    ceo: { personId: ceo, name: 'Sample CEO', email: 'sample.ceo@example.com' },
  };
  const consent = (meetingId: string) =>
    db.query(`INSERT INTO consent_records(org_id, meeting_id, kind, state, method, details, recorded_by) VALUES ($1,$2,'recording','confirmed','verbal',$3,$4)`, [
      orgId,
      meetingId,
      { note: '架空のサンプル会議です' },
      userId,
    ]);
  const transcript = async (meetingId: string, speakers: Record<string, string>, segs: SegIn[]) => {
    const tId = await ins(`INSERT INTO transcripts(org_id, meeting_id, version, provider, is_local, language, input_hash) VALUES ($1,$2,1,'fixture',true,'ja',$3)`, [
      orgId,
      meetingId,
      `sample:${meetingId}`,
    ]);
    const spk = new Map<string, string>();
    for (const [label, personId] of Object.entries(speakers))
      spk.set(label, await ins(`INSERT INTO meeting_speakers(org_id, meeting_id, label, person_id, source, updated_by) VALUES ($1,$2,$3,$4,'manual',$5)`, [orgId, meetingId, label, personId, userId]));
    const ids: string[] = [];
    let t = 0;
    for (const [i, s] of segs.entries()) {
      const dur = 3000 + s.text.length * 120;
      ids.push(
        await ins(
          `INSERT INTO transcript_segments(org_id, transcript_id, meeting_id, seq, start_ms, end_ms, speaker_id, speaker_label, text, confidence, tsv)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0.95,$10::tsvector)`,
          [orgId, tId, meetingId, i, t, t + dur, spk.get(s.who), s.who, s.text, toTsvectorLiteral(s.text)],
        ),
      );
      t += dur + 500;
    }
    const seg = await db.query('SELECT id, start_ms, end_ms, text FROM transcript_segments WHERE transcript_id=$1 ORDER BY seq', [tId]);
    return { tId, segs: seg.rows as { id: string; start_ms: number; end_ms: number; text: string }[], ids };
  };
  const src = (t: { tId: string; segs: { id: string; start_ms: number; end_ms: number; text: string }[] }, i: number) => ({
    ids: [t.segs[i].id],
    start: t.segs[i].start_ms,
    end: t.segs[i].end_ms,
    quote: t.segs[i].text,
    transcript: t.tId,
    revisions: { [t.segs[i].id]: 1 },
  });

  // ---- 1) Weekly Product — previous occurrence (unfinished action, original price decision)
  const prevStart = at(-7, 1);
  const prev = await meeting({ title: 'Weekly Product', start: prevStart, minutes: 30, type: 'internal', projectId: launch, seriesId: weekly, visibility: 'workspace', status: 'ready', recorded: true });
  await participants(prev, [
    { ...P.me, role: 'organizer' },
    { ...P.pm, role: 'attendee' },
  ]);
  await consent(prev);
  const tPrev = await transcript(prev, { 'あなた（サンプル）': me, 'Sample PM': pm }, [
    { who: 'Sample PM', text: '先週のリリース準備の進捗を共有します。サインアップ完了率はまだ目標に届いていません。' },
    { who: 'あなた（サンプル）', text: 'オンボーディング画面の文言が分かりにくいという声が多いですね。' },
    { who: 'Sample PM', text: 'では、オンボーディング画面の文言を来週までに私が修正します。' },
    { who: 'あなた（サンプル）', text: '価格は、Proプランを月額5,980円で提供する方針で進めましょう。' },
    { who: 'Sample PM', text: '了解です。料金ページのデザイン案も用意しておきます。' },
  ]);
  const s3 = src(tPrev, 3);
  const oldDecision = await ins(
    `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, topic_key, decided_at, owner_person_id, participant_person_ids,
                           review_state, status, source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions,
                           confidence, extracted_by, ai_provider, created_by, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'価格','pro-plan-price',$7,$8,$9,'confirmed','superseded',$10,$11,$12,$13,$14,$15,0.82,'ai','local-rules',$16,$16,$7)`,
    [orgId, wsId, prev, launch, weekly, 'Proプランを月額5,980円で提供する', prevStart, me, [me, pm], s3.ids, s3.start, s3.end, s3.quote, s3.transcript, s3.revisions, userId],
  );
  const s2 = src(tPrev, 2);
  const openAction = await ins(
    `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, series_id, description, assignee_person_id, assignee_text, due_date, due_text, status,
                         source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions, confidence, extracted_by, ai_provider,
                         created_by, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Sample PM',$8,'来週まで','confirmed',$9,$10,$11,$12,$13,$14,0.88,'ai','local-rules',$15,$15,$16)`,
    [orgId, wsId, prev, launch, weekly, 'オンボーディング画面の文言を修正する', pm, dateOffset(1), s2.ids, s2.start, s2.end, s2.quote, s2.transcript, s2.revisions, userId, prevStart],
  );
  await db.query(
    `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, series_id, description, assignee_person_id, assignee_user_id, assignee_text, status, extracted_by,
                         created_by, confirmed_by, confirmed_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,'料金ページのデザイン案を用意する',$6,NULL,'Sample PM','done','user',$7,$7,$8,$9)`,
    [orgId, wsId, prev, launch, weekly, pm, userId, prevStart, at(-3, 2)],
  );

  // ---- 2) Weekly Product — next occurrence (scheduled; its brief shows the unfinished action)
  const next = await meeting({ title: 'Weekly Product', start: at(2, 1), minutes: 30, type: 'internal', projectId: launch, seriesId: weekly, visibility: 'workspace', status: 'scheduled', recorded: false });
  await participants(next, [
    { ...P.me, role: 'organizer' },
    { ...P.pm, role: 'attendee' },
  ]);
  await db.query(`INSERT INTO agenda_items(org_id, meeting_id, text, source_type, source_id, status, position) VALUES ($1,$2,$3,'action',$4,'accepted',0)`, [
    orgId,
    next,
    '前回の未完了: オンボーディング画面の文言を修正する（Sample PM）',
    openAction,
  ]);

  // ---- 3) Client Review — price change decision, my commitment, open question, review-inbox candidates
  const reviewStart = at(-2, 5);
  const review = await meeting({ title: 'Client Review', start: reviewStart, minutes: 45, type: 'client', projectId: alpha, seriesId: null, visibility: 'workspace', status: 'needs_review', recorded: true });
  await participants(review, [
    { ...P.me, role: 'organizer' },
    { ...P.ceo, role: 'attendee' },
    { ...P.pm, role: 'optional' },
  ]);
  await consent(review);
  const tRev = await transcript(review, { 'Sample CEO': ceo, 'あなた（サンプル）': me }, [
    { who: 'Sample CEO', text: '先月ご提案いただいた内容を社内で確認しました。機能面は問題ありません。' },
    { who: 'Sample CEO', text: 'ただ、Proプランの価格が当社の予算を少し上回っています。' },
    { who: 'あなた（サンプル）', text: '承知しました。Proプランの価格を月額4,980円に変更する案でいかがでしょうか。' },
    { who: 'Sample CEO', text: 'その条件であれば進められます。価格変更で合意としましょう。' },
    { who: 'あなた（サンプル）', text: 'ありがとうございます。改定後の料金資料を今週中にお送りします。' },
    { who: 'Sample CEO', text: '新料金ページの公開日はいつになりますか？' },
    { who: 'あなた（サンプル）', text: '公開日は社内で確認して、次回ご連絡します。' },
    { who: 'Sample CEO', text: '競合サービスとの比較表もあると社内説明が楽になります。' },
    { who: 'あなた（サンプル）', text: '年払いの場合の割引も検討してみます。' },
  ]);
  const r2 = src(tRev, 2);
  const priceDecision = await ins(
    `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, text, topic, topic_key, decided_at, owner_person_id, reason, participant_person_ids,
                           review_state, status, supersedes_decision_id, source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id,
                           source_revisions, confidence, extracted_by, ai_provider, created_by, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,'価格変更','pro-plan-price',$6,$7,$8,$9,'confirmed','active',$10,$11,$12,$13,$14,$15,$16,0.9,'ai','local-rules',$17,$17,$6)`,
    [
      orgId,
      wsId,
      review,
      alpha,
      'Proプランの価格を月額4,980円に変更する（価格変更）',
      reviewStart,
      ceo,
      'クライアントの予算に合わせるため',
      [ceo, me],
      oldDecision,
      r2.ids,
      r2.start,
      r2.end,
      r2.quote,
      r2.transcript,
      r2.revisions,
      userId,
    ],
  );
  await db.query('UPDATE decisions SET superseded_by_decision_id=$2 WHERE id=$1', [oldDecision, priceDecision]);
  const r4 = src(tRev, 4);
  await db.query(
    `INSERT INTO commitments(org_id, workspace_id, meeting_id, project_id, description, promised_by_person_id, promised_by_user_id, promised_by_text,
                             promised_to_person_id, promised_to_text, due_date, due_text, status, source_segment_ids, source_start_ms, source_end_ms, source_quote,
                             source_transcript_id, source_revisions, confidence, extracted_by, ai_provider, created_by, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'あなた（サンプル）',$8,'Sample CEO',$9,'今週中','open',$10,$11,$12,$13,$14,$15,0.86,'ai','local-rules',$7,$7,$16)`,
    [orgId, wsId, review, alpha, '改定後の料金資料を送付する（資料送付）', me, userId, ceo, dateOffset(3), r4.ids, r4.start, r4.end, r4.quote, r4.transcript, r4.revisions, reviewStart],
  );
  const r5 = src(tRev, 5);
  await db.query(
    `INSERT INTO open_questions(org_id, workspace_id, meeting_id, project_id, question, owner_person_id, status, source_segment_ids, source_start_ms, source_end_ms,
                                source_quote, source_transcript_id, source_revisions, confidence, extracted_by, ai_provider, created_by, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,0.8,'ai','local-rules',$13,$13,$14)`,
    [orgId, wsId, review, alpha, '新料金ページの公開日はいつにするか？（公開日）', me, r5.ids, r5.start, r5.end, r5.quote, r5.transcript, r5.revisions, userId, reviewStart],
  );
  // Review Inbox candidates (AI output is never trusted until a human confirms it).
  const r7 = src(tRev, 7);
  await db.query(
    `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, description, assignee_person_id, assignee_text, assignee_inferred, due_text, due_inferred, status,
                         source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions, confidence, extracted_by, ai_provider, created_by)
     VALUES ($1,$2,$3,$4,'競合サービスとの比較表を作成する',$5,'あなた（サンプル）',true,'次回まで',true,'candidate',$6,$7,$8,$9,$10,$11,0.62,'ai','local-rules',$12)`,
    [orgId, wsId, review, alpha, me, r7.ids, r7.start, r7.end, r7.quote, r7.transcript, r7.revisions, userId],
  );
  const r8 = src(tRev, 8);
  await db.query(
    `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, text, topic, review_state, status, source_segment_ids, source_start_ms, source_end_ms,
                           source_quote, source_transcript_id, source_revisions, confidence, extracted_by, ai_provider, created_by)
     VALUES ($1,$2,$3,$4,'年払いプランに割引を設ける','年払い割引','candidate','active',$5,$6,$7,$8,$9,$10,0.41,'ai','local-rules',$11)`,
    [orgId, wsId, review, alpha, r8.ids, r8.start, r8.end, r8.quote, r8.transcript, r8.revisions, userId],
  );
  await db.query(
    `INSERT INTO summaries(org_id, meeting_id, transcript_id, version, provider, model, sections) VALUES ($1,$2,$3,1,'local-rules',NULL,$4)`,
    [
      orgId,
      review,
      tRev.tId,
      {
        executive: '（サンプル）Alpha社とProプランの価格を月額4,980円に変更することで合意。改定後の料金資料を今週中に送付する。新料金ページの公開日は未定。',
        topics: [
          { title: 'Proプランの価格変更', source: { meetingId: review, segmentIds: r2.ids, startMs: r2.start, endMs: r2.end, quote: null } },
          { title: '料金資料の送付', source: { meetingId: review, segmentIds: r4.ids, startMs: r4.start, endMs: r4.end, quote: null } },
        ],
        risks: [{ text: '公開日が未定のため、告知スケジュールが遅れる可能性', source: null }],
        nextMeeting: '公開日の確定と比較表の共有',
      },
    ],
  );

  // ---- 4) 1on1 — private (only the creator can see it)
  const oneOnOne = await meeting({ title: '1on1', start: at(-1, 8), minutes: 30, type: 'one_on_one', projectId: null, seriesId: null, visibility: 'private', status: 'ready', recorded: true });
  await participants(oneOnOne, [
    { ...P.me, role: 'organizer' },
    { ...P.pm, role: 'attendee' },
  ]);
  await consent(oneOnOne);
  await transcript(oneOnOne, { 'あなた（サンプル）': me, 'Sample PM': pm }, [
    { who: 'あなた（サンプル）', text: '最近の業務量はどうですか？' },
    { who: 'Sample PM', text: 'リリース前で少し忙しいですが、問題ありません。' },
    { who: 'あなた（サンプル）', text: '来月から週次定例を30分から20分に短くしましょう。' },
  ]);
  await db.query('INSERT INTO meeting_notes(org_id, meeting_id, author_user_id, body) VALUES ($1,$2,$3,$4)', [
    orgId,
    oneOnOne,
    userId,
    '（サンプル）1on1は非公開Meetingです。作成者だけが閲覧できます。',
  ]);

  // ---- index (search module) — only within this sample workspace
  for (const id of [prev, next, review, oneOnOne]) await deps.jobs.enqueue(db, { orgId, type: 'index.meeting', key: `index:${id}:${Date.now()}`, payload: { meetingId: id } });
  for (const id of [ceo, pm, me]) await deps.jobs.enqueue(db, { orgId, type: 'index.person', key: `index-person:${id}:${Date.now()}`, payload: { personId: id } });
  await audit(db, { orgId, workspaceId: wsId, userId, action: 'sample.created', meta: { meetings: 4, today } });
}
