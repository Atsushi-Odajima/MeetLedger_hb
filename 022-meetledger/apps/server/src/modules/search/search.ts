// GET /api/w/:ws/search — cross-meeting full-text search over transcript segments (current transcripts only)
// and search_docs (meeting meta, summaries, ledger items, notes, people).
// ACL: the visible-meeting set (meetingVisibleSql + workspace filter + date/project filters) is computed in the SAME SQL
// statement and every hit is joined against it BEFORE ranking; person docs are restricted to the workspace.
import { z } from 'zod';
import { SEARCH_ENTITY_TYPES, type CitationDto, type SearchEntityType } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';
import { meetingVisibleSql } from '../../rbac/access';
import { highlightTerms, makeSnippet, queryTsq } from './text';
import { safeTz, zonedStart } from './scope';

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
  const tz = safeTz(ctx.user.timezone);
  const from = parseBound(q.from, tz, 'from');
  const to = parseBound(q.to, tz, 'to');
  const tsq = q.q ? queryTsq(q.q) : null;
  const browse = !tsq;
  if (browse && !q.personId && !q.projectId) return { items: [] as SearchHitDto[], query: { q: q.q ?? '', mode: 'empty' as const } };
  let types = parseTypes(q.types);
  if (browse && !q.types) types = types.filter((t) => t !== 'segment' && t !== 'note');
  if (q.personId && !(await one(db, 'SELECT 1 FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [q.personId, ctx.workspaceId]))) throw notFound('Person not found');
  if (q.projectId && !(await one(db, 'SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2', [q.projectId, ctx.workspaceId]))) throw notFound('Project not found');

  const params: unknown[] = [ctx.workspaceId, ctx.userId, ctx.deps.clock.now().toISOString()];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const tq = tsq ? `${p(tsq)}::tsquery` : null;
  const visWhere = [`m.workspace_id = $1`, meetingVisibleSql('m', '$2')];
  if (from) visWhere.push(`coalesce(m.scheduled_start, m.created_at) >= ${p(from.toISOString())}`);
  if (to) visWhere.push(`coalesce(m.scheduled_start, m.created_at) < ${p(to.toISOString())}`);
  if (q.projectId) visWhere.push(`m.project_id = ${p(q.projectId)}`);
  const meetingFilters = !!(from || to || q.projectId);
  const match = (col: string) => (tq ? `${col} @@ ${tq}` : 'TRUE');
  const rank = (col: string) => (tq ? `ts_rank_cd(${col}, ${tq}, 32)` : '0::real');

  const branches: string[] = [];
  if (types.includes('segment')) {
    const personSeg = q.personId
      ? `AND (EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = s.meeting_id AND pa.person_id = ${p(q.personId)})
              OR EXISTS (SELECT 1 FROM meeting_speakers sp WHERE sp.id = s.speaker_id AND sp.person_id = $${params.length}))`
      : '';
    branches.push(`
      SELECT 'segment'::text AS entity_type, s.id AS entity_id, s.meeting_id, NULL::text AS title, s.text AS body,
             s.start_ms, s.end_ms, v.mdate AS occurred_at, ${rank('s.tsv')} AS rank, '{}'::jsonb AS meta,
             coalesce(sp2.display_name, pe2.name, s.speaker_label) AS speaker
        FROM transcript_segments s
        JOIN transcripts t ON t.id = s.transcript_id AND t.is_current
        JOIN vis v ON v.id = s.meeting_id
        LEFT JOIN meeting_speakers sp2 ON sp2.id = s.speaker_id
        LEFT JOIN people pe2 ON pe2.id = sp2.person_id
       WHERE ${match('s.tsv')} ${browse ? 'AND FALSE' : ''} ${personSeg}`);
  }
  const docTypes = types.filter((t) => t !== 'segment');
  if (docTypes.length) {
    const personDoc = q.personId
      ? `AND ((d.entity_type = 'person' AND d.entity_id = ${p(q.personId)}) OR $${params.length} = ANY(d.person_ids)
              OR (d.meeting_id IS NOT NULL AND EXISTS (SELECT 1 FROM participants pa WHERE pa.meeting_id = d.meeting_id AND pa.person_id = $${params.length})))`
      : '';
    branches.push(`
      SELECT d.entity_type, d.entity_id, d.meeting_id, d.title, d.body,
             (d.meta->>'startMs')::int AS start_ms, (d.meta->>'endMs')::int AS end_ms, coalesce(v.mdate, d.occurred_at) AS occurred_at,
             ${rank('d.tsv')} AS rank, d.meta, NULL::text AS speaker
        FROM search_docs d
        LEFT JOIN vis v ON v.id = d.meeting_id
       WHERE d.workspace_id = $1 AND d.entity_type = ANY(${p(docTypes)}::text[]) AND ${match('d.tsv')}
         AND ((d.meeting_id IS NOT NULL AND v.id IS NOT NULL) OR (d.meeting_id IS NULL AND d.entity_type = 'person' AND ${meetingFilters ? 'FALSE' : 'TRUE'}))
         ${personDoc}`);
  }
  if (!branches.length) return { items: [], query: { q: q.q ?? '', mode: browse ? 'browse' : 'fts' } };
  const limit = p(q.limit);
  const list = await rows<any>(
    db,
    `WITH vis AS (
       SELECT m.id, m.title, coalesce(m.scheduled_start, m.created_at) AS mdate FROM meetings m WHERE ${visWhere.join(' AND ')}
     ), hits AS (${branches.join(' UNION ALL ')})
     SELECT h.*, v.title AS meeting_title, v.mdate AS meeting_date,
            (h.rank * ${TYPE_WEIGHT_SQL} * (1 + 0.5 * coalesce(exp(-greatest(0, extract(epoch FROM ($3::timestamptz - h.occurred_at)) / 86400.0) / 180.0), 0)))::float8 AS score
       FROM hits h LEFT JOIN vis v ON v.id = h.meeting_id
      ORDER BY score DESC, h.occurred_at DESC NULLS LAST, h.entity_id
      LIMIT ${limit}`,
    params,
  );
  const terms = q.q ? highlightTerms(q.q) : [];
  const items: SearchHitDto[] = list.map((r) => {
    const sn = makeSnippet(r.body, terms);
    const meetingDate = r.meeting_date ? new Date(r.meeting_date).toISOString() : null;
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
        meetingDate,
        startMs: r.start_ms ?? null,
        endMs: r.end_ms ?? null,
        snippet: sn.plain,
      },
    };
  });
  return { items, query: { q: q.q ?? '', mode: browse ? ('browse' as const) : ('fts' as const), types, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null } };
}
