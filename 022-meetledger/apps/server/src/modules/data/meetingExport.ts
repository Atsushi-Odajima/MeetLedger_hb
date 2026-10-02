// Single meeting export: Markdown / print HTML / TXT / SRT / VTT / JSON.
// Every export carries title, date, participants, transcript version and generatedAt; AI output is labeled.
import { msToClock } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { iso } from '../../lib/http';
import { loadMeeting } from '../../rbac/access';
import { AI_LABEL, CANDIDATE_LABEL, fmtDate, fmtDateTime, renderHtml, renderMarkdown, type Block } from './render';
import { toSrt, toVtt, type Cue } from './subtitles';

export const APP_VERSION = '1.0.0';
export const MEETING_EXPORT_FORMATS = ['md', 'html', 'txt', 'srt', 'vtt', 'json'] as const;
export type MeetingExportFormat = (typeof MEETING_EXPORT_FORMATS)[number];

export interface MeetingBundle {
  meeting: any;
  project: { id: string; name: string } | null;
  series: { id: string; title: string } | null;
  participants: { displayName: string; email: string | null; role: string; personId: string | null }[];
  transcript: { id: string; version: number; provider: string; isLocal: boolean; language: string | null; createdAt: string | null } | null;
  speakers: Map<string, string>;
  segments: { id: string; seq: number; startMs: number; endMs: number; speakerId: string | null; speaker: string; text: string; confidence: number | null; flags: string[] }[];
  summary: any | null;
  decisions: any[];
  actions: any[];
  commitments: any[];
  questions: any[];
  notes: { author: string; body: string; updatedAt: string | null }[];
  generatedAt: Date;
  timezone: string;
}

/** Loads everything visible for one meeting (404 when the caller cannot read it). */
export async function loadMeetingBundle(db: Db, ctx: WsCtx, meetingId: string): Promise<MeetingBundle> {
  const m = await loadMeeting(db, ctx, meetingId, 'read');
  const project = m.project_id ? await one(db, 'SELECT id, name FROM projects WHERE id=$1 AND workspace_id=$2', [m.project_id, ctx.workspaceId]) : null;
  const series = m.series_id ? await one(db, 'SELECT id, title FROM series WHERE id=$1 AND workspace_id=$2', [m.series_id, ctx.workspaceId]) : null;
  const participants = await rows(
    db,
    `SELECT p.display_name, p.email, p.role, p.person_id FROM participants p WHERE p.meeting_id=$1
      ORDER BY CASE p.role WHEN 'organizer' THEN 0 WHEN 'attendee' THEN 1 ELSE 2 END, p.display_name`,
    [m.id],
  );
  const t = await one(db, 'SELECT * FROM transcripts WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [m.id]);
  const speakerRows = await rows(
    db,
    `SELECT s.id, s.label, s.display_name, pe.name AS person_name FROM meeting_speakers s LEFT JOIN people pe ON pe.id = s.person_id WHERE s.meeting_id=$1`,
    [m.id],
  );
  const speakers = new Map<string, string>(speakerRows.map((s) => [s.id, s.display_name || s.person_name || s.label]));
  const segRows = t
    ? await rows(db, 'SELECT id, seq, start_ms, end_ms, speaker_id, speaker_label, text, confidence, flags FROM transcript_segments WHERE transcript_id=$1 ORDER BY seq', [t.id])
    : [];
  const summary = await one(db, 'SELECT * FROM summaries WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [m.id]);
  const srcOk = (alias: string) => `EXISTS (SELECT 1 FROM transcript_segments ss WHERE ss.id = ANY(${alias}.source_segment_ids)) AS source_ok`;
  const decisions = await rows(
    db,
    `SELECT d.*, pe.name AS owner_name, ${srcOk('d')} FROM decisions d LEFT JOIN people pe ON pe.id = d.owner_person_id
      WHERE d.meeting_id=$1 AND d.workspace_id=$2 AND d.review_state <> 'rejected' ORDER BY d.created_at, d.id`,
    [m.id, ctx.workspaceId],
  );
  const actions = await rows(
    db,
    `SELECT a.*, coalesce(pe.name, u.name, a.assignee_text) AS assignee_name, ${srcOk('a')}
       FROM actions a LEFT JOIN people pe ON pe.id = a.assignee_person_id LEFT JOIN users u ON u.id = a.assignee_user_id
      WHERE a.meeting_id=$1 AND a.workspace_id=$2 AND a.status <> 'rejected' ORDER BY a.created_at, a.id`,
    [m.id, ctx.workspaceId],
  );
  const commitments = await rows(
    db,
    `SELECT c.*, coalesce(pb.name, ub.name, c.promised_by_text) AS by_name, coalesce(pt.name, ut.name, c.promised_to_text) AS to_name, ${srcOk('c')}
       FROM commitments c
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id LEFT JOIN users ub ON ub.id = c.promised_by_user_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id LEFT JOIN users ut ON ut.id = c.promised_to_user_id
      WHERE c.meeting_id=$1 AND c.workspace_id=$2 AND c.status <> 'rejected' ORDER BY c.created_at, c.id`,
    [m.id, ctx.workspaceId],
  );
  const questions = await rows(
    db,
    `SELECT q.*, pe.name AS owner_name, ${srcOk('q')} FROM open_questions q LEFT JOIN people pe ON pe.id = q.owner_person_id
      WHERE q.meeting_id=$1 AND q.workspace_id=$2 AND q.status <> 'rejected' ORDER BY q.created_at, q.id`,
    [m.id, ctx.workspaceId],
  );
  const notes = await rows(
    db,
    `SELECT n.body, n.updated_at, u.name AS author FROM meeting_notes n JOIN users u ON u.id = n.author_user_id
      WHERE n.meeting_id=$1 AND length(n.body) > 0 ORDER BY (n.author_user_id = $2) DESC, n.updated_at`,
    [m.id, ctx.userId],
  );
  return {
    meeting: m,
    project,
    series,
    participants: participants.map((p) => ({ displayName: p.display_name, email: p.email, role: p.role, personId: p.person_id })),
    transcript: t ? { id: t.id, version: t.version, provider: t.provider, isLocal: t.is_local, language: t.language, createdAt: iso(t.created_at) } : null,
    speakers,
    segments: segRows.map((s) => ({
      id: s.id,
      seq: s.seq,
      startMs: s.start_ms,
      endMs: s.end_ms,
      speakerId: s.speaker_id,
      speaker: (s.speaker_id && speakers.get(s.speaker_id)) || s.speaker_label,
      text: s.text,
      confidence: s.confidence,
      flags: s.flags ?? [],
    })),
    summary,
    decisions,
    actions,
    commitments,
    questions,
    notes: notes.map((n) => ({ author: n.author, body: n.body, updatedAt: iso(n.updated_at) })),
    generatedAt: ctx.deps.clock.now(),
    timezone: ctx.user.timezone || 'Asia/Tokyo',
  };
}

const meetingStart = (m: any) => m.scheduled_start ?? m.started_at ?? m.created_at;

export function meetingDateText(b: MeetingBundle): string {
  const m = b.meeting;
  const start = fmtDateTime(meetingStart(m), b.timezone);
  const endRaw = m.scheduled_end ?? m.ended_at;
  const end = endRaw ? fmtDateTime(endRaw, b.timezone) : '';
  const endPart = end ? `〜${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end}` : '';
  return `${start}${endPart} (${b.timezone})`;
}

export function transcriptVersionText(b: MeetingBundle): string {
  if (!b.transcript) return 'なし';
  return `v${b.transcript.version}（${b.transcript.provider} / ${b.transcript.isLocal ? 'ローカル処理' : 'クラウド処理'}）`;
}

const participantNames = (b: MeetingBundle) => b.participants.map((p) => p.displayName).join(', ') || '（未登録）';

function sourceText(item: any): string {
  if (!item.source_segment_ids?.length && item.source_start_ms == null) return '';
  if (!item.source_ok) return '出典: 文字起こし削除済み（missing）';
  return item.source_start_ms != null ? `出典 [${msToClock(item.source_start_ms)}]` : '';
}

const aiTag = (item: any) => (item.extracted_by === 'ai' ? 'AI抽出・確認済み' : undefined);

function summaryBlocks(summary: any): Block[] {
  if (!summary) return [];
  const s = summary.sections ?? {};
  const out: Block[] = [{ t: 'h', level: 2, text: '要約', badge: AI_LABEL }];
  out.push({ t: 'p', text: `AIが生成した要約です（${summary.provider}${summary.model ? ` / ${summary.model}` : ''}, v${summary.version}）。内容は必ず確認してください。`, muted: true });
  if (typeof s.executive === 'string' && s.executive.trim()) out.push({ t: 'p', text: s.executive });
  const topics = Array.isArray(s.topics) ? s.topics : [];
  if (topics.length) {
    out.push({ t: 'h', level: 3, text: 'トピック' });
    out.push({ t: 'list', items: topics.map((x: any) => ({ text: typeof x === 'string' ? x : String(x?.title ?? x?.text ?? '') })).filter((x: any) => x.text) });
  }
  const risks = Array.isArray(s.risks) ? s.risks : [];
  if (risks.length) {
    out.push({ t: 'h', level: 3, text: 'リスク' });
    out.push({ t: 'list', items: risks.map((x: any) => ({ text: typeof x === 'string' ? x : String(x?.text ?? x?.title ?? '') })).filter((x: any) => x.text) });
  }
  if (typeof s.nextMeeting === 'string' && s.nextMeeting.trim()) out.push({ t: 'h', level: 3, text: '次回' }, { t: 'p', text: s.nextMeeting });
  return out;
}

export function meetingBlocks(b: MeetingBundle, opts: { transcript?: boolean } = {}): Block[] {
  const m = b.meeting;
  const out: Block[] = [{ t: 'h', level: 1, text: m.title }];
  const meta: [string, string][] = [
    ['タイトル', m.title],
    ['日時', meetingDateText(b)],
    ['参加者', participantNames(b)],
  ];
  if (b.project) meta.push(['プロジェクト', b.project.name]);
  if (b.series) meta.push(['定例シリーズ', b.series.title]);
  meta.push(['公開範囲', m.visibility === 'private' ? '非公開（作成者のみ）' : m.visibility === 'selected' ? '指定メンバー' : 'Workspace全体']);
  meta.push(['文字起こし版', transcriptVersionText(b)]);
  meta.push(['生成日時', b.generatedAt.toISOString()]);
  meta.push(['出力元', `MeetLedger ${APP_VERSION} / meeting export v1`]);
  out.push({ t: 'meta', rows: meta });
  out.push({
    t: 'note',
    text: `表示ラベル: 「${AI_LABEL}」= AIが作成した内容（未検証の可能性あり）／「${CANDIDATE_LABEL}」= AIが抽出し、まだ人が確認していない項目／「AI抽出・確認済み」= AI抽出後に人が確認した項目。`,
  });
  out.push(...summaryBlocks(b.summary));

  const confirmedDecisions = b.decisions.filter((d) => d.review_state === 'confirmed');
  out.push({ t: 'h', level: 2, text: '決定事項' });
  if (confirmedDecisions.length)
    out.push({
      t: 'list',
      items: confirmedDecisions.map((d) => ({
        text: `${d.text}${d.status === 'superseded' ? '（変更済み・旧決定）' : d.status === 'revoked' ? '（取消）' : ''}`,
        badge: aiTag(d),
        sub: [d.reason ? `理由: ${d.reason}` : '', d.owner_name ? `責任者: ${d.owner_name}` : '', sourceText(d)].filter(Boolean).join(' / ') || undefined,
      })),
    });
  else out.push({ t: 'p', text: '（確定した決定事項はありません）', muted: true });

  const openActions = b.actions.filter((a) => a.status !== 'candidate');
  out.push({ t: 'h', level: 2, text: 'アクション' });
  if (openActions.length)
    out.push({
      t: 'table',
      head: ['内容', '担当', '期限', '状態', '出典'],
      rows: openActions.map((a) => [
        a.description,
        `${a.assignee_name ?? '未設定'}${a.assignee_inferred ? '（推定）' : ''}`,
        `${a.due_date ?? a.due_text ?? ''}${a.due_inferred ? '（推定）' : ''}`,
        a.status,
        sourceText(a),
      ]),
    });
  else out.push({ t: 'p', text: '（アクションはありません）', muted: true });

  const openCommitments = b.commitments.filter((c) => c.status !== 'candidate');
  out.push({ t: 'h', level: 2, text: '約束（Commitments）' });
  if (openCommitments.length)
    out.push({
      t: 'table',
      head: ['内容', '約束した人', '相手', '期限', '状態'],
      rows: openCommitments.map((c) => [c.description, c.by_name ?? '', c.to_name ?? '', c.due_date ?? c.due_text ?? '', c.status]),
    });
  else out.push({ t: 'p', text: '（約束はありません）', muted: true });

  const openQuestions = b.questions.filter((q) => q.status !== 'candidate');
  out.push({ t: 'h', level: 2, text: '未解決の質問・論点' });
  if (openQuestions.length)
    out.push({
      t: 'list',
      items: openQuestions.map((q) => ({ text: `${q.question}（${q.status}）`, sub: [q.owner_name ? `担当: ${q.owner_name}` : '', q.answer_text ? `回答: ${q.answer_text}` : ''].filter(Boolean).join(' / ') || undefined })),
    });
  else out.push({ t: 'p', text: '（質問はありません）', muted: true });

  const candidates = [
    ...b.decisions.filter((d) => d.review_state === 'candidate').map((d) => `決定: ${d.text}`),
    ...b.actions.filter((a) => a.status === 'candidate').map((a) => `アクション: ${a.description}${a.assignee_name ? `（担当候補: ${a.assignee_name}）` : ''}`),
    ...b.commitments.filter((c) => c.status === 'candidate').map((c) => `約束: ${c.description}`),
    ...b.questions.filter((q) => q.status === 'candidate').map((q) => `質問: ${q.question}`),
  ];
  if (candidates.length) {
    out.push({ t: 'h', level: 2, text: '未確認の候補', badge: `${AI_LABEL}・${CANDIDATE_LABEL}` });
    out.push({ t: 'p', text: 'AIが抽出し、まだ確認されていない項目です。確定情報として扱わないでください。', muted: true });
    out.push({ t: 'list', items: candidates.map((text) => ({ text, badge: CANDIDATE_LABEL })) });
  }

  if (b.notes.length) {
    out.push({ t: 'h', level: 2, text: 'メモ' });
    for (const n of b.notes) out.push({ t: 'h', level: 3, text: `${n.author}${n.updatedAt ? `（${fmtDateTime(n.updatedAt, b.timezone)}）` : ''}` }, { t: 'p', text: n.body });
  }

  if (opts.transcript !== false) {
    out.push({ t: 'h', level: 2, text: '文字起こし', badge: b.transcript ? `自動文字起こし ${transcriptVersionText(b)}` : undefined });
    if (b.segments.length) out.push({ t: 'transcript', rows: b.segments.map((s) => ({ time: msToClock(s.startMs), speaker: s.speaker, text: s.text })) });
    else out.push({ t: 'p', text: '（文字起こしはありません）', muted: true });
  }
  return out;
}

const footerText = (b: MeetingBundle) => `MeetLedger ${APP_VERSION} — generated ${b.generatedAt.toISOString()} — ${AI_LABEL}の内容は必ず確認してください。`;

function headerLines(b: MeetingBundle): string[] {
  return [
    `タイトル: ${b.meeting.title}`,
    `日時: ${meetingDateText(b)}`,
    `参加者: ${participantNames(b)}`,
    `文字起こし版: ${transcriptVersionText(b)}`,
    `生成日時: ${b.generatedAt.toISOString()}`,
    `出力元: MeetLedger ${APP_VERSION}`,
  ];
}

export function cues(b: MeetingBundle): Cue[] {
  return b.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text }));
}

export function meetingJson(b: MeetingBundle) {
  const m = b.meeting;
  const src = (x: any) => ({
    segmentIds: x.source_segment_ids ?? [],
    startMs: x.source_start_ms,
    endMs: x.source_end_ms,
    quote: x.source_quote,
    status: !x.source_segment_ids?.length ? null : x.source_ok ? 'ok' : 'missing',
  });
  const base = (x: any) => ({ id: x.id, extractedBy: x.extracted_by, aiGenerated: x.extracted_by === 'ai', aiProvider: x.ai_provider, confidence: x.confidence, source: src(x), createdAt: iso(x.created_at) });
  return {
    format: 'meetledger.meeting-export/v1',
    generatedAt: b.generatedAt.toISOString(),
    app: { name: 'MeetLedger', version: APP_VERSION },
    meeting: {
      id: m.id,
      title: m.title,
      date: iso(meetingStart(m)),
      scheduledStart: iso(m.scheduled_start),
      scheduledEnd: iso(m.scheduled_end),
      startedAt: iso(m.started_at),
      endedAt: iso(m.ended_at),
      meetingType: m.meeting_type,
      visibility: m.visibility,
      status: m.status,
      project: b.project,
      series: b.series,
      aiEnabled: m.ai_enabled,
      isConfidential: m.is_confidential,
      language: m.language,
    },
    participants: b.participants,
    transcript: b.transcript
      ? {
          ...b.transcript,
          segments: b.segments.map((s) => ({ id: s.id, seq: s.seq, startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text, confidence: s.confidence, flags: s.flags })),
        }
      : null,
    summary: b.summary
      ? { aiGenerated: true, provider: b.summary.provider, model: b.summary.model, version: b.summary.version, sections: b.summary.sections, createdAt: iso(b.summary.created_at) }
      : null,
    decisions: b.decisions.map((d) => ({
      ...base(d),
      text: d.text,
      topic: d.topic,
      reason: d.reason,
      owner: d.owner_name,
      reviewState: d.review_state,
      status: d.status,
      decidedAt: iso(d.decided_at),
      supersedesDecisionId: d.supersedes_decision_id,
      supersededByDecisionId: d.superseded_by_decision_id,
    })),
    actions: b.actions.map((a) => ({
      ...base(a),
      description: a.description,
      assignee: a.assignee_name,
      assigneeInferred: a.assignee_inferred,
      dueDate: a.due_date,
      dueText: a.due_text,
      dueInferred: a.due_inferred,
      status: a.status,
      linkedDecisionId: a.linked_decision_id,
    })),
    commitments: b.commitments.map((c) => ({ ...base(c), description: c.description, promisedBy: c.by_name, promisedTo: c.to_name, dueDate: c.due_date, dueText: c.due_text, status: c.status })),
    questions: b.questions.map((q) => ({ ...base(q), question: q.question, owner: q.owner_name, status: q.status, answer: q.answer_text })),
    notes: b.notes,
  };
}

export interface RenderedExport {
  body: string;
  contentType: string;
  ext: string;
}

export function renderMeeting(b: MeetingBundle, format: MeetingExportFormat): RenderedExport {
  switch (format) {
    case 'md':
      return { body: renderMarkdown(meetingBlocks(b)) + `\n---\n_${footerText(b)}_\n`, contentType: 'text/markdown; charset=utf-8', ext: 'md' };
    case 'html':
      return { body: renderHtml(b.meeting.title, meetingBlocks(b), footerText(b)), contentType: 'text/html; charset=utf-8', ext: 'html' };
    case 'txt': {
      const lines = [...headerLines(b), ''.padEnd(40, '-')];
      if (b.segments.length) for (const s of b.segments) lines.push(`[${msToClock(s.startMs)}] ${s.speaker}: ${s.text.replace(/\r?\n/g, ' ')}`);
      else lines.push('（文字起こしはありません）');
      return { body: lines.join('\r\n') + '\r\n', contentType: 'text/plain; charset=utf-8', ext: 'txt' };
    }
    case 'srt':
      return { body: toSrt(cues(b)), contentType: 'application/x-subrip; charset=utf-8', ext: 'srt' };
    case 'vtt':
      return { body: toVtt(cues(b), headerLines(b)), contentType: 'text/vtt; charset=utf-8', ext: 'vtt' };
    case 'json':
      return { body: JSON.stringify(meetingJson(b), null, 2), contentType: 'application/json; charset=utf-8', ext: 'json' };
  }
}

export function exportFileBase(b: MeetingBundle): string {
  return `meeting-${fmtDate(meetingStart(b.meeting), b.timezone) || 'undated'}`;
}
