// Ledger exports: Decisions CSV/JSON (with supersede chains), Actions CSV, Commitments CSV, Project meeting book.
import { dateInTz, msToClock } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import { itemVisibleSql, meetingVisibleSql } from '../../rbac/access';
import { toCsv } from './csv';
import { APP_VERSION } from './meetingExport';
import { AI_LABEL, fmtDate, fmtDateTime, renderHtml, renderMarkdown, type Block } from './render';

export interface LedgerFilter {
  projectId?: string;
  includeCandidates?: boolean;
}

const tzOf = (ctx: WsCtx) => ctx.user.timezone || 'Asia/Tokyo';

/** Shared FROM/WHERE for ledger exports: ACL (itemVisibleSql) + workspace filter + optional project. */
function where(alias: string, f: LedgerFilter, params: unknown[]): string {
  const w = [`${alias}.workspace_id = $1`, itemVisibleSql(alias, '$2')];
  if (f.projectId) {
    params.push(f.projectId);
    w.push(`${alias}.project_id = $${params.length}`);
  }
  return w.join(' AND ');
}

const MEETING_COLS = (alias: string) =>
  `vm2.title AS meeting_title, coalesce(vm2.scheduled_start, vm2.started_at, vm2.created_at) AS meeting_at, pr.name AS project_name
   FROM ${alias}`;

async function loadDecisions(db: Db, ctx: WsCtx, f: LedgerFilter) {
  const params: unknown[] = [ctx.workspaceId, ctx.userId];
  const review = f.includeCandidates ? `d.review_state IN ('confirmed','candidate')` : `d.review_state = 'confirmed'`;
  const list = await rows(
    db,
    `SELECT d.*, pe.name AS owner_name, ${MEETING_COLS('decisions d')}
       LEFT JOIN meetings vm2 ON vm2.id = d.meeting_id
       LEFT JOIN projects pr ON pr.id = d.project_id
       LEFT JOIN people pe ON pe.id = d.owner_person_id
      WHERE ${where('d', f, params)} AND ${review}
      ORDER BY coalesce(d.decided_at, d.created_at), d.id`,
    params,
  );
  const personIds = [...new Set(list.flatMap((d) => d.participant_person_ids ?? []))];
  const people = personIds.length ? await rows(db, 'SELECT id, name FROM people WHERE workspace_id=$1 AND id = ANY($2)', [ctx.workspaceId, personIds]) : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  // References to decisions the caller cannot see are not exported.
  const visible = new Set(list.map((d) => d.id));
  for (const d of list) {
    if (d.supersedes_decision_id && !visible.has(d.supersedes_decision_id)) d.supersedes_decision_id = null;
    if (d.superseded_by_decision_id && !visible.has(d.superseded_by_decision_id)) d.superseded_by_decision_id = null;
    d.participant_names = (d.participant_person_ids ?? []).map((id: string) => names.get(id)).filter(Boolean);
  }
  return list;
}

/** Groups decisions into supersede chains (oldest → newest) following supersedes/superseded_by links. */
export function supersedeChains(list: { id: string; supersedes_decision_id: string | null; superseded_by_decision_id: string | null }[]) {
  const byId = new Map(list.map((d) => [d.id, d]));
  const prev = new Map<string, string>();
  const next = new Map<string, string>();
  for (const d of list) {
    if (d.supersedes_decision_id && byId.has(d.supersedes_decision_id)) {
      prev.set(d.id, d.supersedes_decision_id);
      next.set(d.supersedes_decision_id, d.id);
    }
    if (d.superseded_by_decision_id && byId.has(d.superseded_by_decision_id)) {
      next.set(d.id, d.superseded_by_decision_id);
      prev.set(d.superseded_by_decision_id, d.id);
    }
  }
  const chainOf = new Map<string, string[]>();
  for (const d of list) {
    if (chainOf.has(d.id)) continue;
    let root = d.id;
    const seen = new Set<string>([root]);
    while (prev.has(root) && !seen.has(prev.get(root)!)) {
      root = prev.get(root)!;
      seen.add(root);
    }
    const chain = [root];
    const seen2 = new Set(chain);
    while (next.has(chain[chain.length - 1]) && !seen2.has(next.get(chain[chain.length - 1])!)) {
      const n = next.get(chain[chain.length - 1])!;
      chain.push(n);
      seen2.add(n);
    }
    for (const id of chain) chainOf.set(id, chain);
  }
  return chainOf;
}

export async function exportDecisions(db: Db, ctx: WsCtx, f: LedgerFilter, format: 'csv' | 'json') {
  const tz = tzOf(ctx);
  const list = await loadDecisions(db, ctx, f);
  const chains = supersedeChains(list);
  const now = ctx.deps.clock.now();
  if (format === 'json') {
    const uniqueChains = [...new Set([...chains.values()])].filter((c) => c.length > 1);
    return {
      contentType: 'application/json; charset=utf-8',
      ext: 'json',
      body: JSON.stringify(
        {
          format: 'meetledger.decisions-export/v1',
          generatedAt: now.toISOString(),
          app: { name: 'MeetLedger', version: APP_VERSION },
          workspaceId: ctx.workspaceId,
          filter: { projectId: f.projectId ?? null, includeCandidates: !!f.includeCandidates },
          decisions: list.map((d) => {
            const chain = chains.get(d.id) ?? [d.id];
            return {
              id: d.id,
              text: d.text,
              topic: d.topic,
              reason: d.reason,
              decidedAt: iso(d.decided_at),
              reviewState: d.review_state,
              status: d.status,
              owner: d.owner_name,
              participants: d.participant_names,
              meeting: d.meeting_id ? { id: d.meeting_id, title: d.meeting_title, date: iso(d.meeting_at) } : null,
              project: d.project_id ? { id: d.project_id, name: d.project_name } : null,
              extractedBy: d.extracted_by,
              aiGenerated: d.extracted_by === 'ai',
              supersedesDecisionId: d.supersedes_decision_id,
              supersededByDecisionId: d.superseded_by_decision_id,
              supersedeChain: chain,
              chainPosition: chain.indexOf(d.id) + 1,
              source: { startMs: d.source_start_ms, endMs: d.source_end_ms, quote: d.source_quote },
              confirmedAt: iso(d.confirmed_at),
              createdAt: iso(d.created_at),
            };
          }),
          chains: uniqueChains,
        },
        null,
        2,
      ),
    };
  }
  const headers = [
    'id',
    'decided_at',
    'meeting_date',
    'meeting_title',
    'project',
    'topic',
    'text',
    'reason',
    'owner',
    'participants',
    'review_state',
    'status',
    'extracted_by',
    'supersedes_decision_id',
    'superseded_by_decision_id',
    'chain_root_id',
    'chain_position',
    'supersede_chain',
    'source_time',
    'confirmed_at',
    'generated_at',
  ];
  const data = list.map((d) => {
    const chain = chains.get(d.id) ?? [d.id];
    return [
      d.id,
      fmtDateTime(d.decided_at, tz),
      fmtDate(d.meeting_at, tz),
      d.meeting_title,
      d.project_name,
      d.topic,
      d.text,
      d.reason,
      d.owner_name,
      (d.participant_names as string[]).join('; '),
      d.review_state,
      d.status,
      d.extracted_by,
      d.supersedes_decision_id,
      d.superseded_by_decision_id,
      chain[0],
      chain.indexOf(d.id) + 1,
      chain.join(' > '),
      d.source_start_ms != null ? msToClock(d.source_start_ms) : '',
      fmtDateTime(d.confirmed_at, tz),
      now.toISOString(),
    ];
  });
  return { contentType: 'text/csv; charset=utf-8', ext: 'csv', body: toCsv(headers, data) };
}

export async function exportActionsCsv(db: Db, ctx: WsCtx, f: LedgerFilter) {
  const tz = tzOf(ctx);
  const params: unknown[] = [ctx.workspaceId, ctx.userId];
  const status = f.includeCandidates ? `a.status <> 'rejected'` : `a.status NOT IN ('rejected','candidate')`;
  const list = await rows(
    db,
    `SELECT a.*, coalesce(pe.name, u.name, a.assignee_text) AS assignee_name, ld.text AS linked_decision_text, ${MEETING_COLS('actions a')}
       LEFT JOIN meetings vm2 ON vm2.id = a.meeting_id
       LEFT JOIN projects pr ON pr.id = a.project_id
       LEFT JOIN people pe ON pe.id = a.assignee_person_id
       LEFT JOIN users u ON u.id = a.assignee_user_id
       LEFT JOIN decisions ld ON ld.id = a.linked_decision_id AND ${itemVisibleSql('ld', '$2')}
      WHERE ${where('a', f, params)} AND ${status}
      ORDER BY a.due_date NULLS LAST, a.created_at, a.id`,
    params,
  );
  const today = dateInTz(ctx.deps.clock.now(), tz);
  const headers = [
    'id',
    'description',
    'status',
    'overdue',
    'assignee',
    'assignee_inferred',
    'due_date',
    'due_text',
    'due_inferred',
    'meeting_date',
    'meeting_title',
    'project',
    'linked_decision_id',
    'linked_decision_text',
    'extracted_by',
    'source_time',
    'created_at',
    'completed_at',
    'generated_at',
  ];
  const now = ctx.deps.clock.now().toISOString();
  const data = list.map((a) => [
    a.id,
    a.description,
    a.status,
    !!a.due_date && a.due_date < today && ['confirmed', 'in_progress'].includes(a.status),
    a.assignee_name,
    a.assignee_inferred,
    a.due_date,
    a.due_text,
    a.due_inferred,
    fmtDate(a.meeting_at, tz),
    a.meeting_title,
    a.project_name,
    a.linked_decision_text ? a.linked_decision_id : null,
    a.linked_decision_text,
    a.extracted_by,
    a.source_start_ms != null ? msToClock(a.source_start_ms) : '',
    fmtDateTime(a.created_at, tz),
    fmtDateTime(a.completed_at, tz),
    now,
  ]);
  return { contentType: 'text/csv; charset=utf-8', ext: 'csv', body: toCsv(headers, data) };
}

export async function exportCommitmentsCsv(db: Db, ctx: WsCtx, f: LedgerFilter) {
  const tz = tzOf(ctx);
  const params: unknown[] = [ctx.workspaceId, ctx.userId];
  const status = f.includeCandidates ? `c.status <> 'rejected'` : `c.status NOT IN ('rejected','candidate')`;
  const list = await rows(
    db,
    `SELECT c.*, coalesce(pb.name, ub.name, c.promised_by_text) AS by_name, coalesce(pt.name, ut.name, c.promised_to_text) AS to_name,
            (c.promised_by_user_id = $2 OR pb.user_id = $2) AS is_mine, (c.promised_to_user_id = $2 OR pt.user_id = $2) AS is_theirs,
            ${MEETING_COLS('commitments c')}
       LEFT JOIN meetings vm2 ON vm2.id = c.meeting_id
       LEFT JOIN projects pr ON pr.id = c.project_id
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id LEFT JOIN users ub ON ub.id = c.promised_by_user_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id LEFT JOIN users ut ON ut.id = c.promised_to_user_id
      WHERE ${where('c', f, params)} AND ${status}
      ORDER BY c.due_date NULLS LAST, c.created_at, c.id`,
    params,
  );
  const today = dateInTz(ctx.deps.clock.now(), tz);
  const now = ctx.deps.clock.now().toISOString();
  const headers = [
    'id',
    'description',
    'status',
    'overdue',
    'promised_by',
    'promised_to',
    'direction',
    'due_date',
    'due_text',
    'due_inferred',
    'meeting_date',
    'meeting_title',
    'project',
    'extracted_by',
    'source_time',
    'created_at',
    'completed_at',
    'generated_at',
  ];
  const data = list.map((c) => [
    c.id,
    c.description,
    c.status,
    !!c.due_date && c.due_date < today && c.status === 'open',
    c.by_name,
    c.to_name,
    c.is_mine ? 'mine' : c.is_theirs ? 'theirs' : 'other',
    c.due_date,
    c.due_text,
    c.due_inferred,
    fmtDate(c.meeting_at, tz),
    c.meeting_title,
    c.project_name,
    c.extracted_by,
    c.source_start_ms != null ? msToClock(c.source_start_ms) : '',
    fmtDateTime(c.created_at, tz),
    fmtDateTime(c.completed_at, tz),
    now,
  ]);
  return { contentType: 'text/csv; charset=utf-8', ext: 'csv', body: toCsv(headers, data) };
}

// ------------------------------------------------------------------ project meeting book

export async function projectBook(db: Db, ctx: WsCtx, projectId: string, format: 'md' | 'html') {
  const tz = tzOf(ctx);
  const p = await one(db, 'SELECT * FROM projects WHERE id=$1 AND workspace_id=$2', [projectId, ctx.workspaceId]);
  if (!p) throw notFound('Project not found');
  const meetings = await rows(
    db,
    `SELECT m.*, coalesce(m.scheduled_start, m.started_at, m.created_at) AS at FROM meetings m
      WHERE m.workspace_id=$1 AND m.project_id=$3 AND ${meetingVisibleSql('m', '$2')}
      ORDER BY coalesce(m.scheduled_start, m.started_at, m.created_at), m.id`,
    [ctx.workspaceId, ctx.userId, projectId],
  );
  const ids = meetings.map((m) => m.id);
  const partRows = ids.length ? await rows(db, 'SELECT meeting_id, display_name FROM participants WHERE meeting_id = ANY($1) ORDER BY display_name', [ids]) : [];
  const parts = new Map<string, string[]>();
  for (const r of partRows) parts.set(r.meeting_id, [...(parts.get(r.meeting_id) ?? []), r.display_name]);
  const summaries = ids.length ? await rows(db, 'SELECT DISTINCT ON (meeting_id) * FROM summaries WHERE meeting_id = ANY($1) AND is_current ORDER BY meeting_id, version DESC', [ids]) : [];
  const summaryOf = new Map(summaries.map((s) => [s.meeting_id, s]));
  // Ledger items of the project: linked to the project, or to one of its visible meetings.
  const itemFilter = (a: string) => `${a}.workspace_id=$1 AND ${itemVisibleSql(a, '$2')} AND (${a}.project_id=$3 OR ${a}.meeting_id = ANY($4))`;
  const args = [ctx.workspaceId, ctx.userId, projectId, ids];
  const decisions = await rows(
    db,
    `SELECT d.*, m.title AS meeting_title, coalesce(m.scheduled_start, m.created_at) AS meeting_at FROM decisions d LEFT JOIN meetings m ON m.id = d.meeting_id
      WHERE ${itemFilter('d')} AND d.review_state='confirmed' ORDER BY coalesce(d.decided_at, d.created_at), d.id`,
    args,
  );
  const actions = await rows(
    db,
    `SELECT a.*, coalesce(pe.name, u.name, a.assignee_text) AS assignee_name FROM actions a
       LEFT JOIN people pe ON pe.id = a.assignee_person_id LEFT JOIN users u ON u.id = a.assignee_user_id
      WHERE ${itemFilter('a')} AND a.status NOT IN ('candidate','rejected') ORDER BY a.due_date NULLS LAST, a.created_at`,
    args,
  );
  const commitments = await rows(
    db,
    `SELECT c.*, coalesce(pb.name, c.promised_by_text) AS by_name, coalesce(pt.name, c.promised_to_text) AS to_name FROM commitments c
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id LEFT JOIN people pt ON pt.id = c.promised_to_person_id
      WHERE ${itemFilter('c')} AND c.status NOT IN ('candidate','rejected') ORDER BY c.due_date NULLS LAST, c.created_at`,
    args,
  );
  const questions = await rows(db, `SELECT q.* FROM open_questions q WHERE ${itemFilter('q')} AND q.status NOT IN ('candidate','rejected') ORDER BY q.created_at`, args);

  const now = ctx.deps.clock.now();
  const title = `${p.name} — Meeting Book`;
  const chains = supersedeChains(decisions);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const blocks: Block[] = [{ t: 'h', level: 1, text: title }];
  blocks.push({
    t: 'meta',
    rows: [
      ['タイトル', p.name],
      ['種別', p.kind === 'client' ? `クライアント${p.client_name ? `（${p.client_name}）` : ''}` : 'プロジェクト'],
      ['期間', meetings.length ? `${fmtDate(meetings[0].at, tz)} 〜 ${fmtDate(meetings[meetings.length - 1].at, tz)}` : '（会議なし）'],
      ['会議数', String(meetings.length)],
      ['参加者', [...new Set(partRows.map((r) => r.display_name))].join(', ') || '（未登録）'],
      ['生成日時', now.toISOString()],
      ['出力元', `MeetLedger ${APP_VERSION} / project book v1`],
    ],
  });
  blocks.push({ t: 'note', text: `アクセス権のある会議のみ含まれます。「${AI_LABEL}」はAIが作成した内容です。` });
  if (p.description) blocks.push({ t: 'p', text: p.description });

  blocks.push({ t: 'h', level: 2, text: '現在有効な決定事項' });
  const active = decisions.filter((d) => d.status === 'active');
  if (active.length)
    blocks.push({
      t: 'list',
      items: active.map((d) => {
        const chain = chains.get(d.id) ?? [d.id];
        const history = chain.length > 1 ? `変更履歴: ${chain.map((id) => byId.get(id)?.text ?? id).join(' → ')}` : '';
        return { text: d.text, sub: [d.meeting_title ? `${fmtDate(d.meeting_at, tz)} ${d.meeting_title}` : '', history].filter(Boolean).join(' / ') || undefined };
      }),
    });
  else blocks.push({ t: 'p', text: '（なし）', muted: true });
  const superseded = decisions.filter((d) => d.status !== 'active');
  if (superseded.length) {
    blocks.push({ t: 'h', level: 3, text: '変更・取消された決定' });
    blocks.push({ t: 'list', items: superseded.map((d) => ({ text: `${d.text}（${d.status === 'superseded' ? '変更済み' : '取消'}）`, sub: d.meeting_title ? `${fmtDate(d.meeting_at, tz)} ${d.meeting_title}` : undefined })) });
  }

  const today = dateInTz(now, tz);
  blocks.push({ t: 'h', level: 2, text: 'アクション' });
  if (actions.length)
    blocks.push({
      t: 'table',
      head: ['内容', '担当', '期限', '状態'],
      rows: actions.map((a) => [a.description, a.assignee_name ?? '未設定', a.due_date ?? a.due_text ?? '', `${a.status}${a.due_date && a.due_date < today && ['confirmed', 'in_progress'].includes(a.status) ? '（期限超過）' : ''}`]),
    });
  else blocks.push({ t: 'p', text: '（なし）', muted: true });
  blocks.push({ t: 'h', level: 2, text: '約束（Commitments）' });
  if (commitments.length) blocks.push({ t: 'table', head: ['内容', '約束した人', '相手', '期限', '状態'], rows: commitments.map((c) => [c.description, c.by_name ?? '', c.to_name ?? '', c.due_date ?? c.due_text ?? '', c.status]) });
  else blocks.push({ t: 'p', text: '（なし）', muted: true });
  blocks.push({ t: 'h', level: 2, text: '未解決の質問・論点' });
  const openQ = questions.filter((q) => q.status === 'open');
  if (openQ.length) blocks.push({ t: 'list', items: openQ.map((q) => ({ text: q.question })) });
  else blocks.push({ t: 'p', text: '（なし）', muted: true });

  blocks.push({ t: 'h', level: 2, text: '会議ごとの記録' });
  for (const m of meetings) {
    blocks.push({ t: 'h', level: 3, text: `${fmtDate(m.at, tz)} ${m.title}` });
    blocks.push({ t: 'p', text: `参加者: ${(parts.get(m.id) ?? []).join(', ') || '（未登録）'}`, muted: true });
    const s = summaryOf.get(m.id);
    if (s && typeof s.sections?.executive === 'string' && s.sections.executive.trim()) blocks.push({ t: 'p', text: `〔${AI_LABEL}〕 ${s.sections.executive}` });
    const md = decisions.filter((d) => d.meeting_id === m.id);
    if (md.length) blocks.push({ t: 'list', items: md.map((d) => ({ text: `決定: ${d.text}` })) });
    const ma = actions.filter((a) => a.meeting_id === m.id);
    if (ma.length) blocks.push({ t: 'list', items: ma.map((a) => ({ text: `アクション: ${a.description}（${a.assignee_name ?? '未設定'} / ${a.status}）` })) });
  }
  if (!meetings.length) blocks.push({ t: 'p', text: '（会議はありません）', muted: true });

  const footer = `MeetLedger ${APP_VERSION} — generated ${now.toISOString()}`;
  if (format === 'html') return { title, contentType: 'text/html; charset=utf-8', ext: 'html', body: renderHtml(title, blocks, footer) };
  return { title, contentType: 'text/markdown; charset=utf-8', ext: 'md', body: renderMarkdown(blocks) + `\n---\n_${footer}_\n` };
}
