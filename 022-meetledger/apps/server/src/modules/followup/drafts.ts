// Follow-up drafts. Deterministic template composition from CONFIRMED ledger items of one meeting only.
// - Never invents items/promises: the item list is built from DB rows; AI may only polish greeting/closing (validated).
// - Never sends: approve / mark-sent are explicit human actions (mark-sent records that a human sent it elsewhere).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FOLLOWUP_KINDS, dateInTz, type FollowupDraftDto, type FollowupKind } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { conflict, notFound } from '../../lib/errors';
import { body, iso, parse, wsIdParams } from '../../lib/http';
import { audit } from '../../lib/audit';
import { loadMeeting, meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { decideAi, wsSettings } from '../../privacy/policy';
import { asLocale, resolveTemplate, safeTz, type Locale } from './util';

export type Tone = 'formal' | 'neutral' | 'casual';
/** Drafts that may leave the organization: no decision reasons, no notes, no transcript quotes. */
export const CLIENT_FACING: ReadonlySet<FollowupKind> = new Set<FollowupKind>(['thank_you_email', 'client_recap']);

export interface DraftData {
  kind: FollowupKind;
  locale: Locale;
  tone: Tone;
  meeting: { title: string; date: string | null };
  decisions: { id: string; text: string; reason: string | null }[];
  actions: { id: string; description: string; assignee: string | null; due: string | null }[];
  commitments: { id: string; description: string; by: string | null; to: string | null; due: string | null }[];
  questions: { id: string; question: string; owner: string | null }[];
}

export interface DraftParts {
  subject: string | null;
  greeting: string;
  sections: string;
  closing: string;
  referencedItems: { type: string; id: string }[];
}

function fmtDate(date: string | null, locale: Locale): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return locale === 'ja' ? `${y}年${m}月${d}日` : date;
}

const GREETING: Record<Locale, Record<FollowupKind, Record<Tone, string>>> = {
  ja: {
    thank_you_email: {
      formal: '本日はお時間をいただき、誠にありがとうございました。\n{when}「{title}」で確認した内容を以下にまとめました。',
      neutral: '本日はありがとうございました。\n{when}「{title}」で確認した内容をまとめました。',
      casual: '今日はありがとうございました！\n「{title}」で確認したことをまとめました。',
    },
    client_recap: {
      formal: 'いつもお世話になっております。\n{when}「{title}」の内容を以下のとおり共有いたします。',
      neutral: '{when}「{title}」の内容を共有します。',
      casual: '「{title}」のまとめです。',
    },
    internal_recap: {
      formal: '{when}「{title}」の社内向けまとめです。',
      neutral: '{when}「{title}」の社内向けまとめです。',
      casual: '「{title}」のまとめです（社内向け）。',
    },
    slack_update: { formal: '*{title}* のまとめ {whenShort}', neutral: '*{title}* のまとめ {whenShort}', casual: '*{title}* のまとめ {whenShort}' },
  },
  en: {
    thank_you_email: {
      formal: 'Thank you very much for your time today.\nBelow is a summary of what we confirmed in "{title}"{whenEn}.',
      neutral: 'Thanks for today.\nHere is what we confirmed in "{title}"{whenEn}.',
      casual: 'Thanks for today!\nHere is what we agreed in "{title}".',
    },
    client_recap: {
      formal: 'Please find below a recap of "{title}"{whenEn}.',
      neutral: 'Recap of "{title}"{whenEn}.',
      casual: 'Quick recap of "{title}".',
    },
    internal_recap: { formal: 'Internal recap of "{title}"{whenEn}.', neutral: 'Internal recap of "{title}"{whenEn}.', casual: 'Internal recap of "{title}".' },
    slack_update: { formal: '*{title}* recap {whenShort}', neutral: '*{title}* recap {whenShort}', casual: '*{title}* recap {whenShort}' },
  },
};

const CLOSING: Record<Locale, Record<FollowupKind, Record<Tone, string>>> = {
  ja: {
    thank_you_email: {
      formal: '内容に認識の違いがございましたら、お知らせいただけますと幸いです。\n今後ともよろしくお願いいたします。',
      neutral: '認識違いがあればお知らせください。引き続きよろしくお願いします。',
      casual: '何かあれば気軽に教えてください。',
    },
    client_recap: {
      formal: '記載内容に相違がございましたら、ご指摘いただけますと幸いです。\nよろしくお願いいたします。',
      neutral: '相違があればお知らせください。',
      casual: '何かあれば気軽に教えてください。',
    },
    internal_recap: {
      formal: '※ 確認済みの項目のみを記載しています。',
      neutral: '※ 確認済みの項目のみを記載しています。',
      casual: '※ 確認済みの項目のみです。',
    },
    slack_update: { formal: '', neutral: '', casual: '' },
  },
  en: {
    thank_you_email: {
      formal: 'If anything differs from your understanding, please let us know.\nBest regards,',
      neutral: 'Let us know if anything looks different from your understanding.',
      casual: 'Feel free to reach out with any questions.',
    },
    client_recap: {
      formal: 'Please let us know if anything differs from your understanding.\nBest regards,',
      neutral: 'Let us know if anything differs.',
      casual: 'Feel free to reach out with any questions.',
    },
    internal_recap: { formal: 'Note: only confirmed items are listed.', neutral: 'Note: only confirmed items are listed.', casual: 'Only confirmed items.' },
    slack_update: { formal: '', neutral: '', casual: '' },
  },
};

const SUBJECT: Record<Locale, Record<FollowupKind, string | null>> = {
  ja: {
    thank_you_email: '「{title}」のお礼',
    client_recap: '「{title}」内容のご共有{whenParen}',
    internal_recap: '【社内】{title} まとめ{whenParen}',
    slack_update: null,
  },
  en: {
    thank_you_email: 'Thank you — {title}',
    client_recap: 'Recap: {title}{whenParen}',
    internal_recap: '[Internal] {title} recap{whenParen}',
    slack_update: null,
  },
};

const HEAD: Record<Locale, { decisions: string; actions: string; commitments: string; questions: string; none: string }> = {
  ja: { decisions: '決定事項', actions: '次のアクション', commitments: '約束事項', questions: '確認中の事項', none: '確認済みの決定・Action・約束はまだありません。' },
  en: { decisions: 'Decisions', actions: 'Next actions', commitments: 'Commitments', questions: 'Open questions', none: 'No confirmed decisions, actions or commitments yet.' },
};

function fill(t: string, d: DraftData): string {
  const date = fmtDate(d.meeting.date, d.locale);
  return t
    .replaceAll('{title}', d.meeting.title)
    .replaceAll('{when}', date ? `${date}の` : '')
    .replaceAll('{whenShort}', d.meeting.date ? `(${d.meeting.date})` : '')
    .replaceAll('{whenEn}', d.meeting.date ? ` (${d.meeting.date})` : '')
    .replaceAll('{whenParen}', date ? (d.locale === 'ja' ? `（${date}）` : ` (${date})`) : '')
    .trim();
}

/** Pure, deterministic composition. The only content is the given ledger rows + fixed template phrases. */
export function composeDraft(d: DraftData): DraftParts {
  const ja = d.locale === 'ja';
  const slack = d.kind === 'slack_update';
  const internal = !CLIENT_FACING.has(d.kind);
  const H = HEAD[d.locale];
  const bullet = slack ? '• ' : ja ? '・' : '- ';
  const header = (s: string) => (slack ? `*${s}*` : ja ? `■ ${s}` : `## ${s}`);
  const paren = (parts: (string | null | false)[]) => {
    const p = parts.filter(Boolean) as string[];
    if (!p.length) return '';
    return ja ? `（${p.join('、')}）` : ` (${p.join(', ')})`;
  };
  const due = (x: string | null) => (x ? (ja ? `期限: ${fmtDate(x, 'ja')}` : `due: ${x}`) : null);
  const blocks: string[] = [];
  const refs: { type: string; id: string }[] = [];

  if (d.decisions.length) {
    const lines = d.decisions.map((x) => {
      refs.push({ type: 'decision', id: x.id });
      const reason = internal && x.reason ? paren([ja ? `理由: ${x.reason}` : `reason: ${x.reason}`]) : '';
      return `${bullet}${x.text}${reason}`;
    });
    blocks.push([header(H.decisions), ...lines].join('\n'));
  }
  if (d.actions.length) {
    const lines = d.actions.map((x) => {
      refs.push({ type: 'action', id: x.id });
      return `${bullet}${x.description}${paren([x.assignee ? (ja ? `担当: ${x.assignee}` : `owner: ${x.assignee}`) : null, due(x.due)])}`;
    });
    blocks.push([header(H.actions), ...lines].join('\n'));
  }
  if (d.commitments.length) {
    const lines = d.commitments.map((x) => {
      refs.push({ type: 'commitment', id: x.id });
      const who = x.by && x.to ? `${x.by} → ${x.to}` : (x.by ?? (x.to ? `→ ${x.to}` : null));
      return `${bullet}${x.description}${paren([who, due(x.due)])}`;
    });
    blocks.push([header(H.commitments), ...lines].join('\n'));
  }
  if (d.questions.length) {
    const lines = d.questions.map((x) => {
      refs.push({ type: 'question', id: x.id });
      return `${bullet}${x.question}${paren([x.owner ? (ja ? `担当: ${x.owner}` : `owner: ${x.owner}`) : null])}`;
    });
    blocks.push([header(H.questions), ...lines].join('\n'));
  }
  if (!blocks.length && internal) blocks.push(H.none);

  const subjectT = SUBJECT[d.locale][d.kind];
  return {
    subject: subjectT ? fill(subjectT, d) : null,
    greeting: fill(GREETING[d.locale][d.kind][d.tone], d),
    sections: blocks.join('\n\n'),
    closing: fill(CLOSING[d.locale][d.kind][d.tone], d),
    referencedItems: refs,
  };
}

export function assembleBody(p: { greeting: string; sections: string; closing: string }): string {
  return [p.greeting, p.sections, p.closing].filter((s) => s && s.trim()).join('\n\n');
}

// ------------------------------------------------------------------------------------------------ AI polish validator

const PROMISE_JA = ['お送り', '送付', '送ります', 'お届け', '提出', 'ご連絡', '連絡します', '対応します', '対応いたします', '約束', '必ず', 'までに', '予定', 'いたします', 'させていただ', '手配', '準備します', 'ご用意', '見積', '確約', '保証'];
const PROMISE_EN = [/\bwill\b/gi, /\b(?:we|i|you|they)'ll\b/gi, /\bshall\b/gi, /\bpromis/gi, /\bsend\b/gi, /\bdeliver/gi, /\bprovide/gi, /\bcommit/gi, /\bguarantee/gi, /\bquote\b/gi, /\bby (?:the )?(?:end|next|tomorrow|monday|tuesday|wednesday|thursday|friday)/gi];
const DATE_JA = ['今日', '本日', '明日', '明後日', 'あした', '来週', '今週', '再来週', '来月', '今月', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜', '日曜', '週明け', '月末', '期限', '締切', '午前', '午後', '年内', '年度', '中旬', '上旬', '下旬'];
const DATE_EN = [/\btoday\b/gi, /\btomorrow\b/gi, /\btonight\b/gi, /\bnext (?:week|month|year)\b/gi, /\bthis (?:week|month)\b/gi, /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi, /\bdeadline\b/gi, /\bdue\b/gi, /\beod\b/gi, /\basap\b/gi, /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/gi];
const KANJI_NUM = /[〇一二三四五六七八九十百千万]+(?:日|月|年|週|時|分|件|個|名|円|営業日|か月|ヶ月|カ月)/g;

const count = (s: string, pat: string | RegExp) => (typeof pat === 'string' ? s.split(pat).length - 1 : (s.match(new RegExp(pat.source, pat.flags)) ?? []).length);

export type PolishVerdict = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Accepts an AI-polished greeting/closing only if it adds no numbers/dates (unless present in the original or the ledger),
 * no promise/commitment wording beyond the original, no lists, links or addresses, and stays short.
 */
export function validatePolish(original: string, polished: unknown, ledgerCorpus: string): PolishVerdict {
  if (typeof polished !== 'string') return { ok: false, reason: 'invalid_output' };
  const o = original.normalize('NFKC');
  const p = polished.normalize('NFKC').trim();
  if (!p) return { ok: false, reason: 'empty' };
  if (p.length > o.length * 3 + 40) return { ok: false, reason: 'too_long' };
  const nl = (s: string) => (s.match(/\n/g) ?? []).length;
  if (nl(p) > nl(o) + 1) return { ok: false, reason: 'structure_changed' };
  if (/[・•■]|^\s*(?:[-*]|\d+[.)])\s/m.test(p) && !/[・•■]/.test(o)) return { ok: false, reason: 'list_injection' };
  if (/(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.)/i.test(p) && !/(https?:\/\/|www\.|@)/i.test(o)) return { ok: false, reason: 'link_added' };
  const corpus = `${o}\n${ledgerCorpus.normalize('NFKC')}`;
  const allowedNums = new Set<string>(corpus.match(/\d+/g) ?? []);
  for (const n of p.match(/\d+/g) ?? []) if (!allowedNums.has(n)) return { ok: false, reason: 'number_added' };
  if (count(p, KANJI_NUM) > count(o, KANJI_NUM)) return { ok: false, reason: 'number_added' };
  for (const w of [...DATE_JA, ...DATE_EN]) if (count(p, w) > count(o, w)) return { ok: false, reason: 'date_added' };
  for (const w of [...PROMISE_JA, ...PROMISE_EN]) if (count(p, w) > count(o, w)) return { ok: false, reason: 'promise_added' };
  return { ok: true, text: polished.trim() };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ------------------------------------------------------------------------------------------------ data + persistence

export interface GatheredDraft {
  data: DraftData;
  candidates: number;
  corpus: string;
}

/** Loads the meeting's CONFIRMED items (decisions confirmed+active, actions confirmed/in_progress, commitments open, questions open). */
export async function gatherDraftData(db: Db, ctx: WsCtx, m: any, kind: FollowupKind, locale: Locale): Promise<GatheredDraft> {
  const template = await resolveTemplate(db, ctx.workspaceId, m.template_key, m.meeting_type);
  const tz = safeTz(ctx.user.timezone);
  const when = m.scheduled_start ?? m.started_at ?? m.created_at;
  const decisions = await rows(
    db,
    `SELECT d.id, d.text, d.reason FROM decisions d
      WHERE d.meeting_id=$1 AND d.workspace_id=$2 AND d.review_state='confirmed' AND d.status='active' ORDER BY d.created_at, d.id`,
    [m.id, ctx.workspaceId],
  );
  const actions = await rows(
    db,
    `SELECT a.id, a.description, a.due_date, coalesce(ap.name, au.name, a.assignee_text) AS assignee
       FROM actions a LEFT JOIN people ap ON ap.id = a.assignee_person_id LEFT JOIN users au ON au.id = a.assignee_user_id
      WHERE a.meeting_id=$1 AND a.workspace_id=$2 AND a.status IN ('confirmed','in_progress') ORDER BY a.due_date NULLS LAST, a.created_at, a.id`,
    [m.id, ctx.workspaceId],
  );
  const commitments = await rows(
    db,
    `SELECT c.id, c.description, c.due_date, coalesce(pb.name, pbu.name, c.promised_by_text) AS by_name, coalesce(pt.name, ptu.name, c.promised_to_text) AS to_name
       FROM commitments c
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id LEFT JOIN users pbu ON pbu.id = c.promised_by_user_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id LEFT JOIN users ptu ON ptu.id = c.promised_to_user_id
      WHERE c.meeting_id=$1 AND c.workspace_id=$2 AND c.status='open' ORDER BY c.due_date NULLS LAST, c.created_at, c.id`,
    [m.id, ctx.workspaceId],
  );
  const questions = await rows(
    db,
    `SELECT q.id, q.question, op.name AS owner FROM open_questions q LEFT JOIN people op ON op.id = q.owner_person_id
      WHERE q.meeting_id=$1 AND q.workspace_id=$2 AND q.status='open' ORDER BY q.created_at, q.id`,
    [m.id, ctx.workspaceId],
  );
  const cand = await one<{ n: number }>(
    db,
    `SELECT ((SELECT count(*) FROM decisions WHERE meeting_id=$1 AND review_state='candidate')
           + (SELECT count(*) FROM actions WHERE meeting_id=$1 AND status='candidate')
           + (SELECT count(*) FROM commitments WHERE meeting_id=$1 AND status='candidate')
           + (SELECT count(*) FROM open_questions WHERE meeting_id=$1 AND status='candidate'))::int AS n`,
    [m.id],
  );
  const data: DraftData = {
    kind,
    locale,
    tone: (template.followupStyle?.tone as Tone) ?? 'neutral',
    meeting: { title: m.title, date: when ? dateInTz(new Date(when), tz) : null },
    decisions: decisions.map((r) => ({ id: r.id, text: r.text, reason: r.reason ?? null })),
    actions: actions.map((r) => ({ id: r.id, description: r.description, assignee: r.assignee ?? null, due: r.due_date ?? null })),
    commitments: commitments.map((r) => ({ id: r.id, description: r.description, by: r.by_name ?? null, to: r.to_name ?? null, due: r.due_date ?? null })),
    questions: questions.map((r) => ({ id: r.id, question: r.question, owner: r.owner ?? null })),
  };
  const corpus = [
    m.title,
    data.meeting.date ?? '',
    ...data.decisions.map((x) => x.text),
    ...data.actions.map((x) => `${x.description} ${x.due ?? ''} ${x.due ? fmtDate(x.due, 'ja') : ''}`),
    ...data.commitments.map((x) => `${x.description} ${x.due ?? ''} ${x.due ? fmtDate(x.due, 'ja') : ''}`),
    ...data.questions.map((x) => x.question),
  ].join('\n');
  return { data, candidates: cand?.n ?? 0, corpus };
}

export function draftDto(r: any): FollowupDraftDto & Record<string, unknown> {
  const meta = r.meta ?? {};
  return {
    id: r.id,
    meetingId: r.meeting_id,
    kind: r.kind,
    subject: r.subject,
    body: r.body,
    status: r.status,
    generatedBy: r.generated_by,
    referencedItems: r.referenced_items ?? [],
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at),
    aiGenerated: r.generated_by === 'ai',
    edited: r.edited === true,
    version: r.version,
    locale: r.locale,
    tone: r.tone,
    warnings: meta.warnings ?? [],
    polish: meta.polish ?? null,
    approvedAt: iso(r.approved_at),
    sentAt: iso(r.sent_at),
  };
}

async function loadDraft(db: Db, ctx: WsCtx, id: string) {
  const r = await one<any>(
    db,
    `SELECT f.*, m.created_by AS meeting_owner FROM followup_drafts f JOIN meetings m ON m.id = f.meeting_id
      WHERE f.id = $1 AND m.workspace_id = $2 AND ${meetingVisibleSql('m', '$3')}`,
    [id, ctx.workspaceId, ctx.userId],
  );
  if (!r) throw notFound('Follow-up draft not found');
  return r;
}

export default async function draftRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/meetings/:id/followups', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      const list = await rows(db, `SELECT * FROM followup_drafts WHERE meeting_id=$1 AND status <> 'discarded' ORDER BY created_at DESC`, [id]);
      return { items: list.map(draftDto) };
    });
  });

  app.post('/api/w/:workspaceId/meetings/:id/followups', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ kind: z.enum(FOLLOWUP_KINDS), locale: z.enum(['ja', 'en']).optional(), polish: z.boolean().default(false) }));
    const locale = b.locale ?? asLocale(ctx.user.locale);

    // 1) read confirmed items + compose (short transaction)
    const { m, g, settings } = await ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      const g = await gatherDraftData(db, ctx, m, b.kind, locale);
      const w = await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [workspaceId]);
      return { m, g, settings: wsSettings(w?.settings) };
    });
    const parts = composeDraft(g.data);
    const warnings: string[] = [];
    if (g.candidates > 0) warnings.push(`candidates_excluded:${g.candidates}`);
    if (!parts.referencedItems.length) warnings.push('no_confirmed_items');

    // 2) optional AI polish of greeting/closing only (outside the DB transaction; never touches the item list)
    let greeting = parts.greeting;
    let closing = parts.closing;
    const polish: { requested: boolean; provider: string | null; applied: string[]; rejected: { part: string; reason: string }[]; skipped?: string } = {
      requested: b.polish,
      provider: null,
      applied: [],
      rejected: [],
    };
    if (b.polish) {
      const decision = decideAi(m as any, settings, deps.config);
      if (!decision.allowed) polish.skipped = 'ai_off';
      else {
        polish.provider = decision.provider;
        let provider: ReturnType<Deps['providers']['ai']> | null = null;
        try {
          provider = deps.providers.ai(decision.provider);
        } catch {
          provider = null;
        }
        if (!provider?.polish) polish.skipped = 'not_supported';
        else {
          for (const part of ['greeting', 'closing'] as const) {
            const original = part === 'greeting' ? greeting : closing;
            if (!original) continue;
            try {
              const out = await withTimeout(
                provider.polish(
                  { kind: b.kind, locale, tone: g.data.tone, text: original },
                  { http: deps.http, orgId: ctx.orgId, meetingIds: [m.id], decision, purpose: 'followup.polish' },
                ),
                20_000,
              );
              const v = validatePolish(original, out, g.corpus);
              if (v.ok) {
                if (part === 'greeting') greeting = v.text;
                else closing = v.text;
                polish.applied.push(part);
              } else polish.rejected.push({ part, reason: v.reason });
            } catch {
              polish.rejected.push({ part, reason: 'provider_error' });
            }
          }
        }
      }
    }
    const text = assembleBody({ greeting, sections: parts.sections, closing });
    const generatedBy = polish.applied.length ? 'ai' : 'template';
    const meta = { warnings, polish };

    // 3) persist: regenerate an untouched draft of the same kind in place, otherwise create a new one (never overwrite user edits)
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id, 'write');
      const existing = await one<any>(
        db,
        `SELECT id FROM followup_drafts WHERE meeting_id=$1 AND kind=$2 AND status='draft' AND edited=false ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [id, b.kind],
      );
      const r = existing
        ? await one<any>(
            db,
            `UPDATE followup_drafts SET subject=$2, body=$3, referenced_items=$4, generated_by=$5, locale=$6, tone=$7, meta=$8, version=version+1, updated_at=now()
              WHERE id=$1 RETURNING *`,
            [existing.id, parts.subject, text, JSON.stringify(parts.referencedItems), generatedBy, locale, g.data.tone, meta],
          )
        : await one<any>(
            db,
            `INSERT INTO followup_drafts(org_id, workspace_id, meeting_id, kind, subject, body, referenced_items, generated_by, locale, tone, meta, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [ctx.orgId, workspaceId, id, b.kind, parts.subject, text, JSON.stringify(parts.referencedItems), generatedBy, locale, g.data.tone, meta, ctx.userId],
          );
      await audit(db, {
        orgId: ctx.orgId,
        workspaceId,
        userId: ctx.userId,
        action: 'followup.drafted',
        entityType: 'followup',
        entityId: r.id,
        meta: { kind: b.kind, items: parts.referencedItems.length, generatedBy },
      });
      return draftDto(r);
    });
  });

  app.patch('/api/w/:workspaceId/followups/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ subject: z.string().max(500).nullable().optional(), body: z.string().min(1).max(50_000).optional(), version: z.number().int() }));
    return ctx.tx(async (db) => {
      const f = await loadDraft(db, ctx, id);
      if (!['draft', 'approved'].includes(f.status)) throw conflict(`Follow-up is ${f.status}`, { code: 'not_editable', status: f.status });
      if (f.version !== b.version) throw conflict('Follow-up was modified elsewhere', { current: draftDto(f) });
      // Editing an approved draft returns it to 'draft' (needs approval again).
      const r = await one<any>(
        db,
        `UPDATE followup_drafts SET subject = CASE WHEN $3::boolean THEN $4 ELSE subject END, body = coalesce($5, body),
                edited = true, edited_by = $6, edited_at = now(), status = 'draft', approved_by = NULL, approved_at = NULL,
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 RETURNING *`,
        [id, b.version, b.subject !== undefined, b.subject ?? null, b.body ?? null, ctx.userId],
      );
      if (!r) throw conflict('Follow-up was modified elsewhere');
      return draftDto(r);
    });
  });

  app.post('/api/w/:workspaceId/followups/:id/approve', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ version: z.number().int().optional(), acknowledgeStale: z.boolean().default(false) }));
    return ctx.tx(async (db) => {
      const f = await loadDraft(db, ctx, id);
      if (f.status === 'approved') return draftDto(f);
      if (f.status !== 'draft') throw conflict(`Follow-up is ${f.status}`, { code: 'not_approvable', status: f.status });
      if (b.version !== undefined && b.version !== f.version) throw conflict('Follow-up was modified elsewhere', { current: draftDto(f) });
      // Items that are no longer confirmed since drafting must be acknowledged (or the draft regenerated).
      const stale = await staleItems(db, f.referenced_items ?? []);
      if (stale.length && !b.acknowledgeStale) throw conflict('Some referenced items are no longer confirmed', { code: 'stale_items', staleItems: stale });
      const r = await one<any>(db, `UPDATE followup_drafts SET status='approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id, ctx.userId]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'followup.approved', entityType: 'followup', entityId: id, meta: { kind: f.kind } });
      return draftDto(r);
    });
  });

  app.post('/api/w/:workspaceId/followups/:id/discard', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    return ctx.tx(async (db) => {
      const f = await loadDraft(db, ctx, id);
      if (f.status === 'discarded') return draftDto(f);
      if (f.status === 'sent') throw conflict('Follow-up was already sent', { code: 'already_sent' });
      const r = await one<any>(db, `UPDATE followup_drafts SET status='discarded', discarded_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'followup.discarded', entityType: 'followup', entityId: id });
      return draftDto(r);
    });
  });

  /** Records that a HUMAN sent the approved text (e-mail client, Slack, ...). Nothing is sent by MeetLedger here. */
  app.post('/api/w/:workspaceId/followups/:id/mark-sent', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ channel: z.enum(['email', 'slack', 'chat', 'other']).default('other') }));
    return ctx.tx(async (db) => {
      const f = await loadDraft(db, ctx, id);
      if (f.status === 'sent') return draftDto(f);
      if (f.status !== 'approved') throw conflict('Approve the follow-up before marking it as sent', { code: 'approval_required', status: f.status });
      const r = await one<any>(
        db,
        `UPDATE followup_drafts SET status='sent', sent_by=$2, sent_at=now(), meta = meta || jsonb_build_object('sentChannel', $3::text), updated_at=now() WHERE id=$1 RETURNING *`,
        [id, ctx.userId, b.channel],
      );
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'followup.marked_sent', entityType: 'followup', entityId: id, meta: { kind: f.kind, channel: b.channel } });
      return draftDto(r);
    });
  });
}

/** Referenced items that are no longer in a confirmed/open state. */
export async function staleItems(db: Db, refs: { type: string; id: string }[]): Promise<{ type: string; id: string }[]> {
  const ids = (t: string) => refs.filter((r) => r.type === t).map((r) => r.id);
  const ok = new Set<string>();
  const q = async (sql: string, list: string[]) => {
    if (!list.length) return;
    for (const r of await rows<{ id: string }>(db, sql, [list])) ok.add(r.id);
  };
  await q(`SELECT id FROM decisions WHERE id = ANY($1::uuid[]) AND review_state='confirmed' AND status='active'`, ids('decision'));
  await q(`SELECT id FROM actions WHERE id = ANY($1::uuid[]) AND status IN ('confirmed','in_progress','done')`, ids('action'));
  await q(`SELECT id FROM commitments WHERE id = ANY($1::uuid[]) AND status IN ('open','done')`, ids('commitment'));
  await q(`SELECT id FROM open_questions WHERE id = ANY($1::uuid[]) AND status IN ('open','answered')`, ids('question'));
  return refs.filter((r) => !ok.has(r.id));
}
