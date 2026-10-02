// POST /api/w/:ws/ask — cross-meeting RAG.
// Pipeline: hints (narrowing only) -> ACL-filtered retrieval in SQL (visible + AI-enabled + non-confidential meetings,
// before any scoring) -> hybrid scoring (lexical/FTS + cosine) -> top-k contexts with opaque refs -> provider.answer()
// -> validation (cited refs must be a subset of the provided refs) -> citations. Insufficient evidence => 「記録からは分かりません」.
// Transcript / notes / ledger text is DATA: it is never parsed for instructions and cannot change scope, ACL or policy.
import { z } from 'zod';
import type { AskResponseDto, CitationDto } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { safeErrorMessage } from '../../lib/logger';
import { audit } from '../../lib/audit';
import { decideWorkspaceAi, wsSettings, type PolicyDecision } from '../../privacy/policy';
import type { AnswerContext, AnswerOutput } from '../../providers/ai/types';
import { cosine, hashEmbed, LOCAL_HASH_MODEL } from '../../providers/embeddings/localHash';
import { embedTexts, embeddingDecision, embeddingProviderFor } from './embed';
import { keywordsTsq, makeSnippet, norm } from './text';
import { localDate, parseAskHints, safeTz, type AskHints, type AskItemType } from './scope';
import { parseBound } from './search';
import { nextWindow, personMeetingIds, scopeSql, WindowPlanner, type Cursor, type MeetingScope } from './windows';

export const UNKNOWN_ANSWER_JA = '記録からは分かりません';
export const UNKNOWN_ANSWER_EN = 'The records do not contain enough information to answer this.';

const zDateOrIso = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().datetime({ offset: true })]);
export const askBodySchema = z.object({
  question: z.string().trim().min(1).max(1000),
  projectId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  from: zDateOrIso.optional(),
  to: zDateOrIso.optional(),
});
export type AskBody = z.infer<typeof askBodySchema>;

const TOP_K = 8;
const TOP_K_ALL = 12;
const MAX_PER_MEETING = 4;
const MAX_CONTEXT_CHARS = 800;
const COS_MIN_SEMANTIC = 0.5;
/** Time budget for walking meeting windows (newest first) during retrieval; target p95 for /ask (local provider) is 2 s. Mutable only for tests. */
export const askTuning = { budgetMs: 700, firstWindow: 150 };
/** At most this many AI OFF / confidential meetings (newest in the searched range) are checked for excludedMeetings. */
const EXCLUDED_CHECK_LIMIT = 300;

interface Candidate {
  key: string;
  kind: 'transcript' | 'summary' | AskItemType;
  entityId: string;
  citeType: string;
  citeId: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: Date | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
  /** text actually matched against keywords (no labels) */
  raw: string;
  fts: number;
  cos: number;
  semantic: boolean;
  lex: number;
  score: number;
}

export interface AskResult extends AskResponseDto {
  scope: {
    persons: { id: string; name: string }[];
    projects: { id: string; name: string }[];
    from: string | null;
    to: string | null;
    dateLabel: string | null;
    types: AskItemType[];
    status: 'open' | 'done' | null;
    keywords: string[];
    /** true when older meetings were not searched (time budget); searchedFrom = oldest meeting date that was searched */
    truncated: boolean;
    searchedFrom: string | null;
  };
  contextCount: number;
}

const likeEsc = (s: string) => `%${s.replace(/[%_\\]/g, (c) => '\\' + c)}%`;

function fmtMs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const STATUS_JA: Record<string, string> = {
  active: '有効',
  superseded: '後に変更済み',
  revoked: '取消',
  open: '未完了',
  done: '完了',
  cancelled: '取消',
  confirmed: '確定',
  in_progress: '対応中',
  answered: '回答済み',
  dropped: '取り下げ',
};

/**
 * Parameter builder for retrieval queries ($1 = workspace id, $2 = user id; the meeting window/ACL predicate comes from
 * windows.scopeSql) plus person / topic predicates for a given item alias.
 */
class ScopeSql {
  params: unknown[];
  constructor(
    private ctx: WsCtx,
    private h: AskHints,
    private explicit: { projectId?: string; personId?: string; from: Date | null; to: Date | null },
  ) {
    this.params = [ctx.workspaceId, ctx.userId];
  }
  p(v: unknown) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  get from() {
    return this.explicit.from ?? this.h.dateRange?.from ?? null;
  }
  get to() {
    return this.explicit.to ?? this.h.dateRange?.to ?? null;
  }
  personIds(): string[] {
    return [...new Set([...this.h.persons.map((p) => p.id), ...(this.explicit.personId ? [this.explicit.personId] : [])])];
  }
  hasScope(): boolean {
    return !!(this.from || this.to || this.explicit.projectId || this.personIds().length || this.h.projects.length || this.h.orgPersonIds.length);
  }
  /** Person predicate: the meeting had one of the people as participant, or the item itself references them. */
  person(meetingCol: string, itemPersonExpr: string | null): string {
    const ids = this.personIds();
    if (!ids.length) return 'TRUE';
    const a = this.p(ids);
    const viaMeeting = `EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = ${meetingCol} AND pa.person_id = ANY(${a}::uuid[]))`;
    return itemPersonExpr ? `(${viaMeeting} OR ${itemPersonExpr.replaceAll('$P', `${a}::uuid[]`)})` : viaMeeting;
  }
  /** Topic predicates (explicit project = hard; hinted project/client/org = project membership OR mention in the text). */
  topic(meetingProjectCol: string, meetingCol: string, itemProjectCol: string | null, textMatch: (names: string[]) => string): string {
    const out: string[] = [];
    if (this.explicit.projectId) {
      const a = this.p(this.explicit.projectId);
      out.push(itemProjectCol ? `(${meetingProjectCol} = ${a} OR ${itemProjectCol} = ${a})` : `${meetingProjectCol} = ${a}`);
    }
    if (this.h.projects.length || this.h.orgPersonIds.length) {
      const alts: string[] = [];
      if (this.h.projects.length) {
        const a = this.p(this.h.projects.map((p) => p.id));
        alts.push(`${meetingProjectCol} = ANY(${a}::uuid[])`);
        if (itemProjectCol) alts.push(`${itemProjectCol} = ANY(${a}::uuid[])`);
      }
      if (this.h.orgPersonIds.length) {
        alts.push(`EXISTS (SELECT 1 FROM participants po WHERE po.meeting_id = ${meetingCol} AND po.person_id = ANY(${this.p(this.h.orgPersonIds)}::uuid[]))`);
      }
      if (this.h.topicNames.length) alts.push(textMatch(this.h.topicNames));
      out.push(`(${alts.join(' OR ')})`);
    }
    return out.length ? out.join(' AND ') : 'TRUE';
  }
}

function lexScore(text: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const t = norm(text);
  let hit = 0;
  for (const k of keywords) if (t.includes(norm(k))) hit++;
  return hit / keywords.length;
}

/**
 * Runs the ask pipeline. DB work happens in short tenant transactions; external calls (question embedding,
 * provider.answer) happen OUTSIDE any transaction (GuardedHttp needs its own connection; no pool starvation).
 */
export async function runAsk(ctx: WsCtx, b: AskBody): Promise<AskResult> {
  const deps = ctx.deps;
  const tz = safeTz(ctx.user.timezone);
  const locale: 'ja' | 'en' = ctx.user.locale === 'en' ? 'en' : 'ja';
  const unknown = locale === 'en' ? UNKNOWN_ANSWER_EN : UNKNOWN_ANSWER_JA;
  const now = deps.clock.now();
  const qLocal = hashEmbed(b.question);

  // ---- phase A (tx): validation, hint dictionaries, settings
  const A = await ctx.tx(async (db) => {
    if (b.personId && !(await one(db, 'SELECT 1 FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [b.personId, ctx.workspaceId])))
      throw notFound('Person not found');
    if (b.projectId && !(await one(db, 'SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2', [b.projectId, ctx.workspaceId]))) throw notFound('Project not found');

    // ---- hints: only rows of THIS workspace can ever be matched (lists are workspace-filtered)
    const people = await rows<{ id: string; name: string; organization: string | null }>(
      db,
      'SELECT id, name, organization FROM people WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 5000',
      [ctx.workspaceId],
    );
    const projects = await rows<{ id: string; name: string; client_name: string | null }>(db, 'SELECT id, name, client_name FROM projects WHERE workspace_id=$1 LIMIT 2000', [
      ctx.workspaceId,
    ]);
    const hints = parseAskHints(b.question, now, tz, people, projects);
    const explicit = { projectId: b.projectId, personId: b.personId, from: parseBound(b.from, tz, 'from'), to: parseBound(b.to, tz, 'to') };
    // Content keywords only: a hinted project / client name is SCOPE (applied as a filter), not evidence by itself.
    const keywords = [...hints.keywords];
    const kq = keywordsTsq(keywords);
    const settings = wsSettings((await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]))?.settings);
    const embDecision = embeddingDecision(settings, deps.config);
    const embProvider = embeddingProviderFor(deps, embDecision);
    const hasModelChunks =
      embProvider.model !== LOCAL_HASH_MODEL &&
      !!(await one(db, 'SELECT 1 FROM ai_chunks WHERE workspace_id=$1 AND embedding_model=$2 LIMIT 1', [ctx.workspaceId, embProvider.model]));
    return { hints, explicit, keywords, kq, settings, embDecision, embProvider, hasModelChunks };
  });
  const { hints, explicit, keywords, kq, settings, embDecision, embProvider } = A;
  const typeFilter = hints.types;
  const scopeInfo = {
    persons: [...hints.persons.map((p) => ({ id: p.id, name: p.name }))],
    projects: hints.projects.map((p) => ({ id: p.id, name: p.name })),
    from: (explicit.from ?? hints.dateRange?.from)?.toISOString() ?? null,
    to: (explicit.to ?? hints.dateRange?.to)?.toISOString() ?? null,
    dateLabel: hints.dateRange?.label ?? null,
    types: typeFilter,
    status: hints.status,
    keywords,
  };

  // ---- phase B (no tx): query vectors. Local hash always (no external call); the workspace's model only if chunks exist for it
  let qModel: string | null = null;
  let qVec: number[] | null = null;
  if (A.hasModelChunks) {
    // Only the question text is sent (no meeting content), under the workspace's embedding decision.
    const r = await embedTexts(deps, embDecision, [b.question], { orgId: ctx.orgId, meetingIds: [], purpose: 'search.ask.query_embedding' });
    if (r.model === embProvider.model) {
      qModel = r.model;
      qVec = r.vectors[0];
    }
  }

  // ---- phase C (tx): windowed retrieval — newest AI-eligible visible meetings first. ACL + AI eligibility + scope are
  // applied in SQL (window list AND again inside every content query) before any scoring. Each window is scored (phase D)
  // and the walk stops once enough relevant contexts were found, the scope is exhausted, or the time budget is spent.
  const S = new ScopeSql(ctx, hints, explicit);
  const hasScope = S.hasScope();
  const lexKeys = keywords;
  const nowMs = now.getTime();
  const recency = (d: Date | null) => (d ? Math.exp(-Math.max(0, nowMs - new Date(d).getTime()) / 86_400_000 / 180) : 0);
  const k = hints.wantsAll ? TOP_K_ALL : TOP_K;
  const openOnly = hints.status;
  const textLike = (S2: ScopeSql, col: string) => (names: string[]) => `${col} ILIKE ANY(${S2.p(names.map(likeEsc))}::text[])`;
  const kwOrder = (S2: ScopeSql, col: string) => (keywords.length ? `(${col} ILIKE ANY(${S2.p(keywords.map(likeEsc))}::text[])) DESC,` : '');

  // phase D: hybrid scoring & relevance gating of one window's candidates
  const scoreWindow = (chunkRows: any[], items: any[]): Candidate[] => {
    const cands: Candidate[] = [];
    const itemIds = new Set(items.map((i) => `${i.type}:${i.id}`));
    for (const c of chunkRows) {
      if (c.entity_type === 'decision' && itemIds.has(`decision:${c.entity_id}`)) continue; // live ledger row preferred
      const isSummary = c.entity_type === 'summary';
      const kind: Candidate['kind'] = c.entity_type === 'decision' ? 'decision' : isSummary ? 'summary' : 'transcript';
      const header =
        kind === 'transcript'
          ? `文字起こし ${fmtMs(c.start_ms)}-${fmtMs(c.end_ms)}`
          : kind === 'summary'
            ? 'AI要約（AI生成・人による確認前の内容を含む）'
            : `決定事項（確定, 状態: ${STATUS_JA[c.meta?.status] ?? c.meta?.status ?? '不明'}）`;
      const segIds: string[] = Array.isArray(c.meta?.segmentIds) ? c.meta.segmentIds : [];
      cands.push({
        key: `chunk:${c.id}`,
        kind,
        entityId: c.entity_id,
        citeType: kind === 'transcript' ? 'segment' : kind,
        citeId: kind === 'transcript' ? (segIds[0] ?? c.entity_id) : c.entity_id,
        meetingId: c.meeting_id,
        meetingTitle: c.title,
        meetingDate: c.mdate,
        startMs: c.start_ms,
        endMs: c.end_ms,
        text: `${header}\n${c.text}`.slice(0, MAX_CONTEXT_CHARS + 80),
        raw: c.text,
        fts: Number(c.fts) || 0,
        cos: Number(c.cos) || 0,
        semantic: c.embedding_model !== LOCAL_HASH_MODEL,
        lex: 0,
        score: 0,
      });
    }
    for (const i of items) {
      const st = STATUS_JA[i.status] ?? i.status;
      let text: string;
      if (i.type === 'decision')
        text = [`決定事項（確定, 状態: ${st}）: ${i.body}`, i.reason ? `理由: ${i.reason}` : '', i.person_name ? `担当: ${i.person_name}` : ''].filter(Boolean).join('\n');
      else if (i.type === 'commitment')
        text = [
          `約束（状態: ${st}${i.due_date || i.due_text ? `, 期限: ${i.due_date ?? i.due_text}` : ''}）: ${i.body}`,
          i.by_name ? `約束した人: ${i.by_name}` : '',
          i.to_name ? `相手: ${i.to_name}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      else if (i.type === 'question')
        text = [`未解決の質問（状態: ${st}）: ${i.body}`, i.answer_text ? `回答: ${i.answer_text}` : '', i.person_name ? `担当: ${i.person_name}` : ''].filter(Boolean).join('\n');
      else
        text = [`アクション（状態: ${st}${i.due_date || i.due_text ? `, 期限: ${i.due_date ?? i.due_text}` : ''}）: ${i.body}`, i.person_name ? `担当: ${i.person_name}` : '']
          .filter(Boolean)
          .join('\n');
      const raw = [i.body, i.reason, i.answer_text, i.topic].filter(Boolean).join('\n');
      cands.push({
        key: `${i.type}:${i.id}`,
        kind: i.type,
        entityId: i.id,
        citeType: i.type,
        citeId: i.id,
        meetingId: i.meeting_id,
        meetingTitle: i.title,
        meetingDate: i.mdate,
        startMs: i.source_start_ms ?? null,
        endMs: i.source_end_ms ?? null,
        text: text.slice(0, MAX_CONTEXT_CHARS),
        raw,
        fts: 0,
        cos: 0,
        semantic: false,
        lex: 0,
        score: 0,
      });
    }
    const out: Candidate[] = [];
    for (const c of cands) {
      c.lex = lexScore(c.raw, lexKeys);
      const isItem = c.kind !== 'transcript' && c.kind !== 'summary';
      let ok: boolean;
      if (keywords.length) ok = c.lex > 0 || c.fts > 0 || (c.semantic && c.cos >= COS_MIN_SEMANTIC);
      else if (typeFilter.length) ok = isItem && typeFilter.includes(c.kind as AskItemType);
      else if (hasScope) ok = isItem || c.kind === 'summary';
      else ok = false;
      if (!ok) continue;
      if (isItem && c.cos === 0) c.cos = cosine(qLocal, hashEmbed(c.raw)); // only for relevant items (local, cheap)
      const intent = typeFilter.length && typeFilter.includes(c.kind as AskItemType) ? 0.2 : 0;
      c.score = 0.5 * c.lex + 0.25 * Math.max(0, c.cos) + 0.15 * c.fts + intent + 0.05 * recency(c.meetingDate) + (isItem ? 0.02 : 0);
      out.push(c);
    }
    return out;
  };

  const { relevant, excludedMeetings, truncated, searchedFrom } = await ctx.tx(async (db) => {
    await db.query('SET LOCAL jit = off');
    const personIds = S.personIds();
    let personMeetings: string[] | null = null;
    if (personIds.length) personMeetings = await personMeetingIds(db, ctx.workspaceId, personIds);
    const scope: MeetingScope = { workspaceId: ctx.workspaceId, userId: ctx.userId, from: S.from, to: S.to, projectId: explicit.projectId ?? null, meetingIds: personMeetings, ai: 'ai' };
    // window CTE body (alias v-compatible columns), ACL re-applied for the given window ids
    const winSql = (S2: ScopeSql, ids: string[]) =>
      `SELECT m.id, m.title, m.project_id, coalesce(m.scheduled_start, m.created_at) AS mdate FROM meetings m WHERE ${scopeSql({ ...scope, meetingIds: ids }, S2.params, { ws: '$1', user: '$2' })}`;

    const chunkQuery = async (ids: string[], semAll: boolean) => {
      const S2 = new ScopeSql(ctx, hints, explicit);
      const win = winSql(S2, ids);
      const where = `c.workspace_id = $1 AND ${S2.person('c.meeting_id', 'c.person_ids && $P')} AND ${S2.topic('v.project_id', 'c.meeting_id', null, (names) => {
        const tq = keywordsTsq(names);
        return tq ? `c.tsv @@ ${S2.p(tq)}::tsquery` : 'FALSE';
      })}`;
      const kqP = S2.p(kq);
      const m1 = S2.p(LOCAL_HASH_MODEL);
      const v1 = S2.p(qLocal);
      const m2 = S2.p(qModel);
      const v2 = S2.p(qVec);
      const dot = (v: string) => `(SELECT coalesce(sum(a * b), 0) FROM unnest(c.embedding, ${v}::real[]) AS t(a, b))`;
      // with keywords: lexical matches (+ every chunk of the newest window for semantic models); without: summaries / decisions
      const filter = keywords.length ? `(c.tsv @@ ${kqP}::tsquery OR ${S2.p(semAll)}::boolean)` : `c.entity_type IN ('summary','decision')`;
      return rows<any>(
        db,
        `WITH v AS MATERIALIZED (${win})
         SELECT c.id, c.meeting_id, c.entity_type, c.entity_id, c.chunk_index, c.text, c.start_ms, c.end_ms, c.meta, c.embedding_model,
                v.title, v.mdate,
                coalesce(ts_rank_cd(c.tsv, ${kqP}::tsquery, 32), 0)::float8 AS fts,
                (CASE c.embedding_model WHEN ${m1} THEN ${dot(v1)} WHEN ${m2} THEN ${dot(v2)} ELSE 0 END)::float8 AS cos
           FROM v JOIN ai_chunks c ON c.meeting_id = v.id
           LEFT JOIN decisions dd ON c.entity_type = 'decision' AND dd.id = c.entity_id
          WHERE ${where} AND ${filter} AND (c.entity_type <> 'decision' OR dd.review_state = 'confirmed')`,
        S2.params,
      );
    };

    const itemQueries = async (ids: string[]) => {
      const items: any[] = [];
      const itemQuery = async (type: AskItemType, sql: (S2: ScopeSql, win: string) => string) => {
        if (typeFilter.length && !typeFilter.includes(type) && keywords.length === 0) return;
        const S2 = new ScopeSql(ctx, hints, explicit);
        const r = await rows<any>(db, sql(S2, winSql(S2, ids)), S2.params);
        for (const x of r) items.push({ ...x, type });
      };
      await itemQuery(
        'decision',
        (S2, win) => `WITH v AS MATERIALIZED (${win})
        SELECT i.id, i.meeting_id, i.text AS body, i.reason, i.topic, i.status, i.source_start_ms, i.source_end_ms, o.name AS person_name, v.title, v.mdate
          FROM v JOIN decisions i ON i.meeting_id = v.id LEFT JOIN people o ON o.id = i.owner_person_id
         WHERE i.workspace_id = $1 AND i.review_state = 'confirmed'
           AND ${S2.person('i.meeting_id', '(i.owner_person_id = ANY($P) OR i.participant_person_ids && $P)')}
           AND ${S2.topic('v.project_id', 'i.meeting_id', 'i.project_id', textLike(S2, 'i.text'))}
         ORDER BY ${kwOrder(S2, "i.text || ' ' || coalesce(i.reason, '')")} v.mdate DESC LIMIT 300`,
      );
      await itemQuery('commitment', (S2, win) => {
        const st = openOnly === 'open' ? `i.status = 'open'` : openOnly === 'done' ? `i.status = 'done'` : `i.status IN ('open','done','cancelled')`;
        return `WITH v AS MATERIALIZED (${win})
        SELECT i.id, i.meeting_id, i.description AS body, i.status, i.due_date, i.due_text, i.source_start_ms, i.source_end_ms,
               coalesce(pb.name, i.promised_by_text) AS by_name, coalesce(pt.name, i.promised_to_text) AS to_name, v.title, v.mdate
          FROM v JOIN commitments i ON i.meeting_id = v.id
          LEFT JOIN people pb ON pb.id = i.promised_by_person_id LEFT JOIN people pt ON pt.id = i.promised_to_person_id
         WHERE i.workspace_id = $1 AND ${st}
           AND ${S2.person('i.meeting_id', '(i.promised_by_person_id = ANY($P) OR i.promised_to_person_id = ANY($P))')}
           AND ${S2.topic('v.project_id', 'i.meeting_id', 'i.project_id', textLike(S2, 'i.description'))}
         ORDER BY ${kwOrder(S2, 'i.description')} v.mdate DESC LIMIT 300`;
      });
      await itemQuery('question', (S2, win) => {
        const st = openOnly === 'open' ? `i.status = 'open'` : openOnly === 'done' ? `i.status = 'answered'` : `i.status IN ('open','answered','dropped')`;
        return `WITH v AS MATERIALIZED (${win})
        SELECT i.id, i.meeting_id, i.question AS body, i.answer_text, i.status, i.source_start_ms, i.source_end_ms, o.name AS person_name, v.title, v.mdate
          FROM v JOIN open_questions i ON i.meeting_id = v.id LEFT JOIN people o ON o.id = i.owner_person_id
         WHERE i.workspace_id = $1 AND ${st}
           AND ${S2.person('i.meeting_id', 'i.owner_person_id = ANY($P)')}
           AND ${S2.topic('v.project_id', 'i.meeting_id', 'i.project_id', textLike(S2, 'i.question'))}
         ORDER BY ${kwOrder(S2, "i.question || ' ' || coalesce(i.answer_text, '')")} v.mdate DESC LIMIT 300`;
      });
      await itemQuery('action', (S2, win) => {
        const st =
          openOnly === 'open' ? `i.status IN ('confirmed','in_progress')` : openOnly === 'done' ? `i.status = 'done'` : `i.status IN ('confirmed','in_progress','done','cancelled')`;
        return `WITH v AS MATERIALIZED (${win})
        SELECT i.id, i.meeting_id, i.description AS body, i.status, i.due_date, i.due_text, i.source_start_ms, i.source_end_ms,
               coalesce(pa2.name, i.assignee_text) AS person_name, v.title, v.mdate
          FROM v JOIN actions i ON i.meeting_id = v.id LEFT JOIN people pa2 ON pa2.id = i.assignee_person_id
         WHERE i.workspace_id = $1 AND ${st}
           AND ${S2.person('i.meeting_id', 'i.assignee_person_id = ANY($P)')}
           AND ${S2.topic('v.project_id', 'i.meeting_id', 'i.project_id', textLike(S2, 'i.description'))}
         ORDER BY ${kwOrder(S2, 'i.description')} v.mdate DESC LIMIT 300`;
      });
      return items;
    };

    const relevant: Candidate[] = [];
    const planner = new WindowPlanner(askTuning.budgetMs, askTuning.firstWindow, 5000);
    let cursor: Cursor | null = null;
    let exhausted = false;
    let first = true;
    let oldest: Date | null = null;
    for (;;) {
      const size = planner.next();
      if (!size) break;
      const win = await nextWindow(db, scope, cursor, size);
      cursor = win.cursor;
      exhausted = win.exhausted;
      if (win.meetings.length) {
        const ids = win.meetings.map((m) => m.id);
        const t0 = Date.now();
        const chunkRows = await chunkQuery(ids, first && !!qModel);
        const items = await itemQueries(ids);
        planner.record(Date.now() - t0, ids.length);
        relevant.push(...scoreWindow(chunkRows, items));
        oldest = win.meetings[win.meetings.length - 1].mdate;
        first = false;
      }
      if (exhausted || relevant.length >= k) break;
    }
    const truncated = !exhausted;
    const excludedMeetings = await countExcluded(db, ctx, hints, explicit, kq, hasScope, truncated ? oldest : null);
    return { relevant, excludedMeetings, truncated, searchedFrom: truncated && oldest ? new Date(oldest).toISOString() : null };
  });

  relevant.sort((a, b) => b.score - a.score || new Date(b.meetingDate ?? 0).getTime() - new Date(a.meetingDate ?? 0).getTime());
  const perMeeting = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const c of relevant) {
    if (picked.length >= k) break;
    const n = perMeeting.get(c.meetingId) ?? 0;
    if (n >= (hints.wantsAll ? k : MAX_PER_MEETING)) continue;
    perMeeting.set(c.meetingId, n + 1);
    picked.push(c);
  }

  const decision = decideWorkspaceAi(settings, deps.config);
  const base = { scope: { ...scopeInfo, truncated, searchedFrom }, excludedMeetings };

  if (!picked.length) {
    await ctx.tx((db) =>
      audit(db, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        action: 'ai.ask',
        meta: { provider: 'none', contexts: 0, insufficient: true, excludedMeetings },
      }),
    );
    return { answer: unknown, insufficient: true, citations: [], provider: 'none', aiGenerated: false, contextCount: 0, ...base };
  }

  // ---- phase E (no tx): provider call — only the picked contexts (opaque refs, no DB ids) leave this function
  const refs = new Map<string, Candidate>();
  const contexts: AnswerContext[] = picked.map((c, idx) => {
    const ref = `c${idx + 1}`;
    refs.set(ref, c);
    return { ref, text: c.text, meetingTitle: c.meetingTitle, meetingDate: localDate(c.meetingDate, tz) };
  });
  const meetingIds = [...new Set(picked.map((c) => c.meetingId))];
  const out = await callProvider(ctx, decision, { question: b.question, contexts, locale }, meetingIds);

  // ---- validation: cited refs must be a subset of the provided contexts
  const cited = [...new Set((out.citedRefs ?? []).filter((r) => typeof r === 'string' && refs.has(r)))];
  const insufficient = !!out.insufficient || !cited.length || typeof out.answer !== 'string' || !out.answer.trim();
  const citations: CitationDto[] = insufficient
    ? []
    : cited.map((ref) => {
        const c = refs.get(ref)!;
        return {
          id: ref,
          entityType: c.citeType,
          entityId: c.citeId,
          meetingId: c.meetingId,
          meetingTitle: c.meetingTitle,
          meetingDate: c.meetingDate ? new Date(c.meetingDate).toISOString() : null,
          startMs: c.startMs,
          endMs: c.endMs,
          snippet: makeSnippet(
            c.raw,
            [...lexKeys, ...hints.topicNames].map((x) => x.normalize('NFKC').toLowerCase()),
          ).plain,
        };
      });
  const answer = insufficient ? unknown : out.answer.replace(/\[(c\d+)\]/g, (m, r) => (refs.has(r) ? m : '')).slice(0, 4000);
  await ctx.tx((db) =>
    audit(db, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'ai.ask',
      meta: {
        provider: decision.provider,
        isLocal: decision.isLocal,
        contexts: contexts.length,
        meetings: meetingIds.length,
        cited: citations.length,
        insufficient,
        excludedMeetings,
      },
    }),
  );
  return { answer, insufficient, citations, provider: decision.provider, aiGenerated: true, contextCount: contexts.length, ...base };
}

async function callProvider(
  ctx: WsCtx,
  decision: PolicyDecision,
  input: { question: string; contexts: AnswerContext[]; locale: 'ja' | 'en' },
  meetingIds: string[],
): Promise<AnswerOutput> {
  let provider;
  try {
    provider = ctx.deps.providers.ai(decision.provider);
  } catch {
    throw new AppError(503, 'ai_unavailable', `AI provider '${decision.provider}' is not available`);
  }
  try {
    return await provider.answer(input, { http: ctx.deps.http, orgId: ctx.orgId, meetingIds, decision, purpose: 'search.ask' });
  } catch (e) {
    if (e instanceof AppError) throw e;
    ctx.deps.log.error({ provider: decision.provider, err: safeErrorMessage(e) }, 'ask provider failed');
    throw new AppError(502, 'ai_failed', 'AI provider failed to answer');
  }
}

/**
 * Visible (ACL) meetings in scope that matched the question but were NOT used because they are AI OFF / confidential.
 * Bounded: only the newest EXCLUDED_CHECK_LIMIT such meetings within the searched date range are checked.
 */
async function countExcluded(
  db: Db,
  ctx: WsCtx,
  hints: AskHints,
  explicit: { projectId?: string; personId?: string; from: Date | null; to: Date | null },
  kq: string | null,
  hasScope: boolean,
  since: Date | null,
): Promise<number> {
  if (!kq && !hasScope) return 0;
  const S = new ScopeSql(ctx, hints, explicit);
  const from = [S.from, since].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const where = scopeSql({ workspaceId: ctx.workspaceId, userId: ctx.userId, from, to: S.to, projectId: explicit.projectId ?? null, ai: 'excluded' }, S.params, { ws: '$1', user: '$2' });
  const vis = `SELECT m.id, m.project_id FROM meetings m WHERE ${where} ORDER BY coalesce(m.scheduled_start, m.created_at) DESC, m.id DESC LIMIT ${EXCLUDED_CHECK_LIMIT}`;
  const person = S.person('v.id', null);
  const topic = S.topic('v.project_id', 'v.id', null, () => 'FALSE');
  let match = 'TRUE';
  if (kq) {
    const a = S.p(kq);
    match = `(EXISTS (SELECT 1 FROM transcripts t JOIN transcript_segments s ON s.transcript_id = t.id WHERE t.meeting_id = v.id AND t.is_current AND s.tsv @@ ${a}::tsquery)
              OR EXISTS (SELECT 1 FROM search_docs d WHERE d.meeting_id = v.id AND d.tsv @@ ${a}::tsquery))`;
  }
  const r = await one<{ n: number }>(db, `WITH v AS MATERIALIZED (${vis}) SELECT count(*)::int AS n FROM v WHERE ${person} AND ${topic} AND ${match}`, S.params);
  return r?.n ?? 0;
}
