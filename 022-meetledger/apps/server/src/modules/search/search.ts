// GET /api/w/:ws/search — cross-meeting full-text search over transcript segments (current transcripts only)
// and search_docs (meeting meta, summaries, ledger items, notes, people).
// ACL: every content query joins `meetings` with meetingVisibleSql + workspace + date/project/person scope in the SAME
// SQL statement, before ranking; person docs are restricted to the workspace.
// Scale: GIN on tsv is not usable under FORCE RLS (`@@` is not leakproof), so search walks visible meetings newest-first
// in windows (windows.ts) within a time budget and reports `truncated` when older meetings were not searched.
import { z } from 'zod';
import { SEARCH_ENTITY_TYPES, type CitationDto, type SearchEntityType } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';
import { highlightTerms, makeSnippet, queryTsq } from './text';
import { safeTz, zonedStart } from './scope';
import { ginUsable, nextWindow, personMeetingIds, scopeSql, WindowPlanner, type Cursor, type MeetingScope } from './windows';

/**
 * Window tuning. budgetMs: time budget for walking meeting windows (rare terms); common terms are satisfied by the
 * first window. Mutable only for tests.
 */
export const searchTuning = { budgetMs: 340, firstWindow: 200 };
/** Exact (complete) path when GIN is usable and a branch has at most this many raw matches. */
const EXACT_CAP = 2000;
export const TRUNCATED_HINT_JA = '新しい会議から順に検索しました。より古い会議を検索するには期間（from/to）・Project・人物で絞り込んでください。';

const zDateOrIso = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().datetime({ offset: true })]);

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  types: z.string().max(200).optional(),
  from: zDateOrIso.optional(),
  to: zDateOrIso.optional(),
  projectId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface SearchHitDto {
  id: string;
  entityType: SearchEntityType;
  entityId: string;
  meetingId: string | null;
  title: string | null;
  /** Snippet of the ORIGINAL text with matches wrapped in [[ ]] markers (plain text, never HTML). */
  snippet: string;
  score: number;
  occurredAt: string | null;
  status: string | null;
  speaker: string | null;
  aiGenerated: boolean;
  citation: CitationDto;
}

const TYPE_WEIGHT_SQL = `CASE h.entity_type WHEN 'meeting' THEN 1.3 WHEN 'person' THEN 1.3 WHEN 'decision' THEN 1.2 WHEN 'commitment' THEN 1.15
  WHEN 'action' THEN 1.1 WHEN 'question' THEN 1.1 WHEN 'summary' THEN 1.05 ELSE 1.0 END`;

/** Accepts YYYY-MM-DD (local day in the user's time zone; `to` is inclusive) or an ISO timestamp. */
export function parseBound(v: string | undefined, tz: string, kind: 'from' | 'to'): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return zonedStart(+m[1], +m[2], +m[3] + (kind === 'to' ? 1 : 0), tz);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`invalid ${kind}`);
  return d;
}

export function parseTypes(raw: string | undefined): SearchEntityType[] {
  if (!raw) return [...SEARCH_ENTITY_TYPES];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of list) if (!(SEARCH_ENTITY_TYPES as readonly string[]).includes(t)) throw badRequest(`unknown type: ${t}`);
  return [...new Set(list)] as SearchEntityType[];
}

export async function runSearch(db: Db, ctx: WsCtx, q: SearchQuery) {
  // Many short index-driven queries: JIT compilation (triggered by pessimistic cost estimates) costs more than it saves.
  await db.query('SET LOCAL jit = off');
  const tz = safeTz(ctx.user.timezone);
  const from = parseBound(q.from, tz, 'from');
  const to = parseBound(q.to, tz, 'to');
  const tsq = q.q ? queryTsq(q.q) : null;
  const browse = !tsq;
  const empty = { items: [] as SearchHitDto[], truncated: false, searchedFrom: null as string | null, hint: null as string | null };
  if (browse && !q.personId && !q.projectId) return { ...empty, query: { q: q.q ?? '', mode: 'empty' as const } };
  let types = parseTypes(q.types);
  if (browse && !q.types) types = types.filter((t) => t !== 'segment' && t !== 'note');
  if (q.personId && !(await one(db, 'SELECT 1 FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [q.personId, ctx.workspaceId]))) throw notFound('Person not found');
  if (q.projectId && !(await one(db, 'SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2', [q.projectId, ctx.workspaceId]))) throw notFound('Project not found');
  const queryInfo = { q: q.q ?? '', mode: browse ? ('browse' as const) : ('fts' as const), types, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };

  const scope: MeetingScope = {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    from,
    to,
    projectId: q.projectId ?? null,
    meetingIds: q.personId ? await personMeetingIds(db, ctx.workspaceId, q.personId) : null,
  };
  const meetingFilters = !!(from || to || q.projectId);
  const now = ctx.deps.clock.now().toISOString();
  const segTypes = types.includes('segment') && !browse;
  const docTypes = types.filter((t) => t !== 'segment' && t !== 'person');
  const wantPersons = types.includes('person') && !meetingFilters;
  const collected: any[] = [];

  // person documents (workspace-level, no meeting) — small partial index
  if (wantPersons) collected.push(...(await personDocs(db, ctx.workspaceId, tsq, q.personId ?? null, now, q.limit)));

  let truncated = false;
  let searchedFrom: string | null = null;
  const contentArgs = { workspaceId: ctx.workspaceId, tsq, segTypes, docTypes, personId: q.personId ?? null, now, limit: q.limit };

  // exact path: GIN usable (DBA marked ts_match_vq LEAKPROOF) and the term is rare -> complete results
  let exact = false;
  if (tsq && (await ginUsable(db))) {
    const pr = await one<{ seg: number; doc: number }>(
      db,
      `SELECT (SELECT count(*) FROM (SELECT 1 FROM transcript_segments s WHERE s.tsv @@ $1::tsquery LIMIT ${EXACT_CAP + 1}) a)::int AS seg,
              (SELECT count(*) FROM (SELECT 1 FROM search_docs d WHERE d.workspace_id = $2 AND d.tsv @@ $1::tsquery LIMIT ${EXACT_CAP + 1}) b)::int AS doc`,
      [tsq, ctx.workspaceId],
    );
    if (pr && pr.seg <= EXACT_CAP && pr.doc <= EXACT_CAP) {
      collected.push(...(await contentQuery(db, scope, null, contentArgs)));
      exact = true;
    }
  }
  if (!exact && (segTypes || docTypes.length)) {
    const planner = new WindowPlanner(searchTuning.budgetMs, searchTuning.firstWindow);
    let cursor: Cursor | null = null;
    let exhausted = false;
    for (;;) {
      const size = planner.next();
      if (!size) break;
      const win = await nextWindow(db, scope, cursor, size);
      cursor = win.cursor;
      exhausted = win.exhausted;
      if (win.meetings.length) {
        const t0 = Date.now();
        collected.push(...(await contentQuery(db, scope, win.meetings.map((m) => m.id), contentArgs)));
        planner.record(Date.now() - t0, win.meetings.length);
        searchedFrom = new Date(win.meetings[win.meetings.length - 1].mdate).toISOString();
      }
      if (exhausted) break;
      if (collected.filter((r) => r.meeting_id).length >= q.limit) break; // newest windows already fill the page
    }
    truncated = !exhausted;
    if (!truncated) searchedFrom = null;
  }

  collected.sort((a, b) => b.score - a.score || new Date(b.occurred_at ?? 0).getTime() - new Date(a.occurred_at ?? 0).getTime());
  const terms = q.q ? highlightTerms(q.q) : [];
  const items: SearchHitDto[] = collected.slice(0, q.limit).map((r) => toHit(r, terms));
  return { items, truncated, searchedFrom, hint: truncated ? TRUNCATED_HINT_JA : null, query: queryInfo };
}

interface ContentArgs {
  workspaceId: string;
  tsq: string | null;
  segTypes: boolean;
  docTypes: string[];
  personId: string | null;
  now: string;
  limit: number;
}

/**
 * Ranked hits for the meetings of one window (meetingIds) or of the whole scope (null, exact path).
 * The window/scope meetings are re-selected here with the ACL predicate (scopeSql) — never trusted from the caller.
 */
async function contentQuery(db: Db, scope: MeetingScope, meetingIds: string[] | null, a: ContentArgs): Promise<any[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = scopeSql(meetingIds ? { ...scope, meetingIds: meetingIds } : scope, params);
  const tq = a.tsq ? `${p(a.tsq)}::tsquery` : null;
  const match = (col: string) => (tq ? `${col} @@ ${tq}` : 'TRUE');
  const rank = (col: string) => (tq ? `ts_rank_cd(${col}, ${tq}, 32)` : '0::real');
  const branches: string[] = [];
  if (a.segTypes) {
    const personSeg = a.personId
      ? `AND (EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = s.meeting_id AND pa.person_id = ${p(a.personId)})
              OR EXISTS (SELECT 1 FROM meeting_speakers sp WHERE sp.id = s.speaker_id AND sp.person_id = $${params.length}))`
      : '';
    branches.push(`
      SELECT 'segment'::text AS entity_type, s.id AS entity_id, s.meeting_id, NULL::text AS title, s.text AS body,
             s.start_ms, s.end_ms, win.mdate AS occurred_at, ${rank('s.tsv')} AS rank, '{}'::jsonb AS meta,
             s.speaker_id, s.speaker_label, win.title AS meeting_title, win.mdate AS meeting_date
        FROM win
        JOIN transcripts t ON t.meeting_id = win.id AND t.is_current
        JOIN transcript_segments s ON s.transcript_id = t.id
       WHERE ${match('s.tsv')} ${personSeg}`);
  }
  if (a.docTypes.length) {
    const personDoc = a.personId
      ? `AND (${p(a.personId)} = ANY(d.person_ids) OR EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = d.meeting_id AND pa.person_id = $${params.length}))`
      : '';
    branches.push(`
      SELECT d.entity_type, d.entity_id, d.meeting_id, d.title, d.body,
             (d.meta->>'startMs')::int AS start_ms, (d.meta->>'endMs')::int AS end_ms, coalesce(win.mdate, d.occurred_at) AS occurred_at,
             ${rank('d.tsv')} AS rank, d.meta, NULL::uuid AS speaker_id, NULL::text AS speaker_label, win.title AS meeting_title, win.mdate AS meeting_date
        FROM win JOIN search_docs d ON d.meeting_id = win.id
       WHERE d.workspace_id = ${p(a.workspaceId)} AND d.entity_type = ANY(${p(a.docTypes)}::text[]) AND ${match('d.tsv')} ${personDoc}`);
  }
  if (!branches.length) return [];
  const nowP = p(a.now);
  const limitP = p(a.limit);
  return rows<any>(
    db,
    `WITH win AS MATERIALIZED (SELECT m.id, m.title, coalesce(m.scheduled_start, m.created_at) AS mdate FROM meetings m WHERE ${where}),
     hits AS MATERIALIZED (${branches.join(' UNION ALL ')}),
     top AS MATERIALIZED (
       SELECT h.*,
              (h.rank * ${TYPE_WEIGHT_SQL} * (1 + 0.5 * coalesce(exp(-greatest(0, extract(epoch FROM (${nowP}::timestamptz - h.occurred_at)) / 86400.0) / 180.0), 0)))::float8 AS score
         FROM hits h
        ORDER BY score DESC, h.occurred_at DESC NULLS LAST, h.entity_id
        LIMIT ${limitP})
     -- speaker names only for the final page (index lookups, independent of match-count estimates)
     SELECT top.*, CASE WHEN top.speaker_id IS NULL THEN top.speaker_label
                        ELSE coalesce((SELECT coalesce(sp.display_name, pe.name) FROM meeting_speakers sp LEFT JOIN people pe ON pe.id = sp.person_id WHERE sp.id = top.speaker_id), top.speaker_label) END AS speaker
       FROM top ORDER BY top.score DESC, top.occurred_at DESC NULLS LAST, top.entity_id`,
    params,
  );
}

async function personDocs(db: Db, workspaceId: string, tsq: string | null, personId: string | null, now: string, limit: number): Promise<any[]> {
  const params: unknown[] = [workspaceId, now, limit];
  let where = '';
  let rank = '0::real';
  if (tsq) {
    params.push(tsq);
    where += ` AND d.tsv @@ $${params.length}::tsquery`;
    rank = `ts_rank_cd(d.tsv, $${params.length}::tsquery, 32)`;
  }
  if (personId) {
    params.push(personId);
    where += ` AND d.entity_id = $${params.length}`;
  }
  return rows<any>(
    db,
    `SELECT d.entity_type, d.entity_id, NULL::uuid AS meeting_id, d.title, d.body, NULL::int AS start_ms, NULL::int AS end_ms, d.occurred_at, d.meta,
            NULL::text AS speaker, NULL::text AS meeting_title, NULL::timestamptz AS meeting_date,
            (${rank} * 1.3 * (1 + 0.5 * coalesce(exp(-greatest(0, extract(epoch FROM ($2::timestamptz - d.occurred_at)) / 86400.0) / 180.0), 0)))::float8 AS score
       FROM search_docs d
      WHERE d.workspace_id = $1 AND d.meeting_id IS NULL AND d.entity_type = 'person' ${where}
      ORDER BY score DESC LIMIT $3`,
    params,
  );
}

function toHit(r: any, terms: string[]): SearchHitDto {
  const sn = makeSnippet(r.body, terms);
  const id = `${r.entity_type}:${r.entity_id}`;
  return {
    id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    meetingId: r.meeting_id,
    title: r.title ?? r.meeting_title ?? null,
    snippet: sn.snippet,
    score: Number(r.score ?? 0),
    occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    status: (r.meta?.status as string) ?? null,
    speaker: r.speaker ?? null,
    aiGenerated: r.entity_type === 'summary' || r.meta?.aiGenerated === true,
    citation: {
      id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      meetingId: r.meeting_id,
      meetingTitle: r.meeting_title ?? null,
      meetingDate: r.meeting_date ? new Date(r.meeting_date).toISOString() : null,
      startMs: r.start_ms ?? null,
      endMs: r.end_ms ?? null,
      snippet: sn.plain,
    },
  };
}
