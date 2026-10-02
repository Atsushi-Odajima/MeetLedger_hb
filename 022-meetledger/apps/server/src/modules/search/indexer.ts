// Index builder for cross-meeting search (FTS: search_docs + transcript_segments.tsv) and the AI vector store (ai_chunks).
// - search_docs: meeting meta, current summary, ledger items (not rejected), meeting notes, people.
// - ai_chunks: ONLY for meetings with ai_enabled && !is_confidential && !deleted (transcript windows, summary, confirmed decisions).
// - AI OFF / confidential meeting => its ai_chunks are deleted (FTS docs are kept). Deleted meeting => everything purged.
// Every row carries org_id / workspace_id / meeting_id (ACL metadata); visibility is always joined live at query time.
import { createHash } from 'node:crypto';
import type { Deps } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { tenantTx } from '../../rbac/access';
import { wsSettings } from '../../privacy/policy';
import { indexTsv } from './text';
import { aiEligible, embedTexts, embeddingDecision, embeddingProviderFor, localHashProvider } from './embed';

export const WINDOW_MS = 45_000;
export const WINDOW_CHARS = 800;
const MAX_DOC_BODY = 100_000;

// ------------------------------------------------------------------ public helpers (used by other modules)

let keySeq = 0;

/** Enqueue (debounced) re-indexing of a meeting. Call after changing meeting content, privacy flags or deleting it. */
export async function enqueueMeetingIndex(deps: Pick<Deps, 'jobs'>, db: Db, orgId: string, meetingId: string) {
  return deps.jobs.enqueue(db, { orgId, type: 'index.meeting', key: `index:${meetingId}:${Date.now()}:${++keySeq}`, payload: { meetingId } });
}

export async function enqueuePersonIndex(deps: Pick<Deps, 'jobs'>, db: Db, orgId: string, personId: string) {
  return deps.jobs.enqueue(db, { orgId, type: 'index.person', key: `index-person:${personId}:${Date.now()}:${++keySeq}`, payload: { personId } });
}

/** Removes only the AI index (vectors) of a meeting. FTS search keeps working. */
export async function purgeMeetingAiIndex(db: Db, meetingId: string): Promise<number> {
  const r = await db.query('DELETE FROM ai_chunks WHERE meeting_id=$1', [meetingId]);
  return r.rowCount ?? 0;
}

/**
 * Removes a meeting from every search structure: ai_chunks (vectors), search_docs and the segment FTS vectors.
 * Must be called (inside the tenant transaction) when a meeting is deleted; the index job also calls it when it
 * finds a meeting with deleted_at set. Hard-deleting the meeting row cascades ai_chunks/search_docs as well.
 */
export async function purgeMeetingIndex(db: Db, meetingId: string): Promise<{ aiChunks: number; searchDocs: number; segments: number }> {
  const aiChunks = await purgeMeetingAiIndex(db, meetingId);
  const d = await db.query('DELETE FROM search_docs WHERE meeting_id=$1', [meetingId]);
  const s = await db.query('UPDATE transcript_segments SET tsv=NULL WHERE meeting_id=$1 AND tsv IS NOT NULL', [meetingId]);
  return { aiChunks, searchDocs: d.rowCount ?? 0, segments: s.rowCount ?? 0 };
}

// ------------------------------------------------------------------ chunking

export interface SegLite {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  personId: string | null;
}

export interface ChunkSpec {
  entityType: 'transcript' | 'summary' | 'decision';
  entityId: string;
  chunkIndex: number;
  text: string;
  startMs: number | null;
  endMs: number | null;
  personIds: string[];
  meta: Record<string, unknown>;
}

const uniq = <T>(a: T[]) => [...new Set(a)];
const segLine = (s: SegLite) => `${s.speaker}: ${s.text}`;

/** Splits text into pieces of at most `max` characters (code point safe), preferring sentence ends. */
export function splitText(text: string, max = WINDOW_CHARS): string[] {
  const chars = Array.from(text);
  if (chars.length <= max) return text.trim() ? [text] : [];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let end = Math.min(chars.length, i + max);
    if (end < chars.length) {
      for (let k = end; k > i + max * 0.6; k--) {
        if (/[。．.!?！？\n]/.test(chars[k - 1])) {
          end = k;
          break;
        }
      }
    }
    const piece = chars.slice(i, end).join('').trim();
    if (piece) out.push(piece);
    i = end;
  }
  return out;
}

/** Groups consecutive segments into ~45 s / <= 800 character windows (with start/end ms). */
export function chunkTranscript(segs: SegLite[], maxMs = WINDOW_MS, maxChars = WINDOW_CHARS): Omit<ChunkSpec, 'entityType' | 'entityId' | 'chunkIndex'>[] {
  const out: Omit<ChunkSpec, 'entityType' | 'entityId' | 'chunkIndex'>[] = [];
  let cur: SegLite[] = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({
      text: cur.map(segLine).join('\n'),
      startMs: cur[0].startMs,
      endMs: Math.max(...cur.map((s) => s.endMs)),
      personIds: uniq(cur.map((s) => s.personId).filter((x): x is string => !!x)),
      meta: { segmentIds: cur.map((s) => s.id) },
    });
    cur = [];
    curLen = 0;
  };
  for (const s of segs) {
    const line = segLine(s);
    const len = Array.from(line).length;
    if (len > maxChars) {
      flush();
      const pieces = splitText(line, maxChars);
      pieces.forEach((p, k) => {
        const span = Math.max(0, s.endMs - s.startMs);
        out.push({
          text: p,
          startMs: Math.round(s.startMs + (span * k) / pieces.length),
          endMs: Math.round(s.startMs + (span * (k + 1)) / pieces.length),
          personIds: s.personId ? [s.personId] : [],
          meta: { segmentIds: [s.id] },
        });
      });
      continue;
    }
    if (cur.length && (s.endMs - cur[0].startMs > maxMs || curLen + len + 1 > maxChars)) flush();
    cur.push(s);
    curLen += len + 1;
  }
  flush();
  return out;
}

const SKIP_SUMMARY_KEYS = new Set(['evidence', 'segmentIds', 'segment_ids', 'id', 'ids', 'model', 'provider', 'version', 'confidence']);

/** Flattens summary sections JSON (owned by the ledger module) into plain text, skipping evidence/ids. */
export function flattenSections(sections: unknown, max = 20_000): string {
  const out: string[] = [];
  let len = 0;
  const walk = (v: unknown, key?: string) => {
    if (len > max || (key && SKIP_SUMMARY_KEYS.has(key))) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) {
        out.push(t);
        len += t.length + 1;
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(sections);
  return out.join('\n').slice(0, max);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

// ------------------------------------------------------------------ search_docs

interface DocRow {
  entityType: string;
  entityId: string;
  meetingId: string | null;
  title: string | null;
  body: string;
  occurredAt: unknown;
  personIds: string[];
  meta: Record<string, unknown>;
}

async function upsertDoc(db: Db, orgId: string, workspaceId: string, d: DocRow) {
  const body = d.body.slice(0, MAX_DOC_BODY);
  await db.query(
    `INSERT INTO search_docs(org_id, workspace_id, meeting_id, entity_type, entity_id, title, body, tsv, occurred_at, person_ids, meta, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::tsvector,$9,$10::uuid[],$11,now())
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       meeting_id=EXCLUDED.meeting_id, workspace_id=EXCLUDED.workspace_id, title=EXCLUDED.title, body=EXCLUDED.body, tsv=EXCLUDED.tsv,
       occurred_at=EXCLUDED.occurred_at, person_ids=EXCLUDED.person_ids, meta=EXCLUDED.meta, updated_at=now()`,
    [orgId, workspaceId, d.meetingId, d.entityType, d.entityId, d.title, body, indexTsv(`${d.title ?? ''}\n${body}`), d.occurredAt ?? null, uniq(d.personIds), d.meta],
  );
}

const STATUS_LABEL: Record<string, string> = {
  candidate: '候補',
  confirmed: '確定',
  active: '有効',
  superseded: '変更済み',
  revoked: '取消',
  in_progress: '対応中',
  done: '完了',
  cancelled: '取消',
  open: '未完了',
  answered: '回答済み',
  dropped: '取り下げ',
};

// ------------------------------------------------------------------ index.meeting

export interface IndexMeetingResult {
  status: 'indexed' | 'purged' | 'missing' | 'superseded';
  docs?: number;
  segments?: number;
  aiIndexed?: boolean;
  chunks?: number;
  embedded?: number;
  embeddingModel?: string | null;
  embeddingFallback?: string;
}

async function newerJobExists(db: Db, jobId: string, payloadKey: string, id: string, statuses: string[]): Promise<boolean> {
  const r = await one<{ newer: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1 FROM jobs j JOIN jobs me ON me.id = $1
        WHERE j.type = me.type AND j.id <> me.id AND j.payload->>$2 = $3 AND j.status = ANY($4)
          AND (j.created_at, j.id) > (me.created_at, me.id)) AS newer`,
    [jobId, payloadKey, id, statuses],
  );
  return !!r?.newer;
}

const lockKey = (kind: string, id: string) => `ml-index:${kind}:${id}`;

/**
 * (Re)builds every index structure of one meeting. Idempotent: upserts by entity, deletes stale rows,
 * reuses embeddings of unchanged chunks (content hash) so re-runs do not re-send data to an embedding API.
 */
export async function indexMeeting(deps: Deps, orgId: string, meetingId: string, opts: { jobId?: string } = {}): Promise<IndexMeetingResult> {
  // ---- phase 1 (tenant tx): FTS docs, segment tsv, chunk planning
  const p1 = await tenantTx(deps, orgId, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey('meeting', meetingId)]);
    if (opts.jobId && (await newerJobExists(db, opts.jobId, 'meetingId', meetingId, ['queued', 'running']))) return { status: 'superseded' as const };
    const m = await one<any>(
      db,
      `SELECT m.*, coalesce(m.scheduled_start, m.created_at) AS mdate, p.name AS project_name, p.client_name, s.title AS series_title, w.settings AS ws_settings
         FROM meetings m JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN series s ON s.id = m.series_id
        WHERE m.id = $1`,
      [meetingId],
    );
    if (!m) {
      await purgeMeetingIndex(db, meetingId);
      return { status: 'missing' as const };
    }
    if (m.deleted_at) {
      await purgeMeetingIndex(db, meetingId);
      return { status: 'purged' as const };
    }
    const docs: DocRow[] = [];
    const base = { meetingId, occurredAt: m.mdate };
    const participants = await rows<{ display_name: string; person_id: string | null; pname: string | null }>(
      db,
      'SELECT pa.display_name, pa.person_id, pe.name AS pname FROM participants pa LEFT JOIN people pe ON pe.id = pa.person_id WHERE pa.meeting_id=$1 ORDER BY pa.created_at',
      [meetingId],
    );
    const participantIds = uniq(participants.map((p) => p.person_id).filter((x): x is string => !!x));
    docs.push({
      ...base,
      entityType: 'meeting',
      entityId: meetingId,
      title: m.title,
      body: [
        m.title,
        participants.length ? `参加者: ${uniq(participants.map((p) => p.pname ?? p.display_name)).join('、')}` : '',
        m.project_name ? `プロジェクト: ${m.project_name}${m.client_name ? ` / ${m.client_name}` : ''}` : '',
        m.series_title ? `シリーズ: ${m.series_title}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      personIds: participantIds,
      meta: { meetingType: m.meeting_type, status: m.status },
    });

    const summary = await one<{ id: string; sections: unknown }>(db, 'SELECT id, sections FROM summaries WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [meetingId]);
    const summaryText = summary ? flattenSections(summary.sections) : '';
    if (summary && summaryText) docs.push({ ...base, entityType: 'summary', entityId: summary.id, title: 'AI要約', body: summaryText, personIds: [], meta: { aiGenerated: true } });

    const decisions = await rows<any>(
      db,
      `SELECT d.id, d.text, d.topic, d.reason, d.review_state, d.status, d.owner_person_id, d.participant_person_ids, d.source_start_ms, d.source_end_ms, o.name AS owner_name
         FROM decisions d LEFT JOIN people o ON o.id = d.owner_person_id
        WHERE d.meeting_id=$1 AND d.review_state <> 'rejected' ORDER BY d.created_at`,
      [meetingId],
    );
    for (const d of decisions) {
      docs.push({
        ...base,
        entityType: 'decision',
        entityId: d.id,
        title: d.topic ?? null,
        body: [d.text, d.reason ? `理由: ${d.reason}` : '', d.owner_name ? `担当: ${d.owner_name}` : ''].filter(Boolean).join('\n'),
        personIds: [d.owner_person_id, ...(d.participant_person_ids ?? [])].filter(Boolean),
        meta: { reviewState: d.review_state, status: d.status, startMs: d.source_start_ms, endMs: d.source_end_ms },
      });
    }
    const actions = await rows<any>(
      db,
      `SELECT a.id, a.description, a.assignee_text, a.assignee_person_id, a.due_date, a.due_text, a.status, a.source_start_ms, a.source_end_ms, pe.name AS assignee_name
         FROM actions a LEFT JOIN people pe ON pe.id = a.assignee_person_id
        WHERE a.meeting_id=$1 AND a.status <> 'rejected' ORDER BY a.created_at`,
      [meetingId],
    );
    for (const a of actions) {
      const who = a.assignee_name ?? a.assignee_text;
      docs.push({
        ...base,
        entityType: 'action',
        entityId: a.id,
        title: null,
        body: [a.description, who ? `担当: ${who}` : '', a.due_date || a.due_text ? `期限: ${a.due_date ?? a.due_text}` : ''].filter(Boolean).join('\n'),
        personIds: [a.assignee_person_id].filter(Boolean),
        meta: { status: a.status, dueDate: a.due_date, startMs: a.source_start_ms, endMs: a.source_end_ms },
      });
    }
    const commitments = await rows<any>(
      db,
      `SELECT c.id, c.description, c.promised_by_text, c.promised_to_text, c.promised_by_person_id, c.promised_to_person_id, c.due_date, c.due_text, c.status,
              c.source_start_ms, c.source_end_ms, pb.name AS by_name, pt.name AS to_name
         FROM commitments c LEFT JOIN people pb ON pb.id = c.promised_by_person_id LEFT JOIN people pt ON pt.id = c.promised_to_person_id
        WHERE c.meeting_id=$1 AND c.status <> 'rejected' ORDER BY c.created_at`,
      [meetingId],
    );
    for (const c of commitments) {
      const by = c.by_name ?? c.promised_by_text;
      const to = c.to_name ?? c.promised_to_text;
      docs.push({
        ...base,
        entityType: 'commitment',
        entityId: c.id,
        title: null,
        body: [c.description, by ? `約束した人: ${by}` : '', to ? `相手: ${to}` : '', c.due_date || c.due_text ? `期限: ${c.due_date ?? c.due_text}` : ''].filter(Boolean).join('\n'),
        personIds: [c.promised_by_person_id, c.promised_to_person_id].filter(Boolean),
        meta: { status: c.status, dueDate: c.due_date, startMs: c.source_start_ms, endMs: c.source_end_ms },
      });
    }
    const questions = await rows<any>(
      db,
      `SELECT q.id, q.question, q.answer_text, q.owner_person_id, q.status, q.source_start_ms, q.source_end_ms, pe.name AS owner_name
         FROM open_questions q LEFT JOIN people pe ON pe.id = q.owner_person_id
        WHERE q.meeting_id=$1 AND q.status <> 'rejected' ORDER BY q.created_at`,
      [meetingId],
    );
    for (const q of questions) {
      docs.push({
        ...base,
        entityType: 'question',
        entityId: q.id,
        title: null,
        body: [q.question, q.answer_text ? `回答: ${q.answer_text}` : '', q.owner_name ? `担当: ${q.owner_name}` : ''].filter(Boolean).join('\n'),
        personIds: [q.owner_person_id].filter(Boolean),
        meta: { status: q.status, startMs: q.source_start_ms, endMs: q.source_end_ms },
      });
    }
    const notes = await rows<any>(db, "SELECT id, body, author_user_id FROM meeting_notes WHERE meeting_id=$1 AND body <> '' ORDER BY updated_at", [meetingId]);
    for (const n of notes) docs.push({ ...base, entityType: 'note', entityId: n.id, title: 'メモ', body: n.body, personIds: [], meta: { authorUserId: n.author_user_id } });

    for (const d of docs) await upsertDoc(db, orgId, m.workspace_id, d);
    // People created implicitly as participants are not index.person-enqueued by core: create their docs if missing.
    if (participantIds.length) {
      const missing = await rows<{ pid: string }>(
        db,
        "SELECT pid FROM unnest($1::uuid[]) AS pid WHERE NOT EXISTS (SELECT 1 FROM search_docs d WHERE d.entity_type = 'person' AND d.entity_id = pid)",
        [participantIds],
      );
      for (const r of missing) await upsertPersonDoc(db, orgId, r.pid);
    }
    await db.query('DELETE FROM search_docs WHERE meeting_id=$1 AND NOT ((entity_type || \':\' || entity_id::text) = ANY($2::text[]))', [
      meetingId,
      docs.map((d) => `${d.entityType}:${d.entityId}`),
    ]);

    // segment FTS vectors of the current transcript (always rebuilt with the script-boundary aware tokenizer)
    const segs = await rows<any>(
      db,
      `SELECT s.id, s.seq, s.start_ms, s.end_ms, s.text, s.speaker_label, sp.display_name, sp.person_id, pe.name AS person_name, t.id AS transcript_id
         FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id AND t.is_current
         LEFT JOIN meeting_speakers sp ON sp.id = s.speaker_id LEFT JOIN people pe ON pe.id = sp.person_id
        WHERE s.meeting_id=$1 ORDER BY s.seq`,
      [meetingId],
    );
    let segmentsUpdated = 0;
    if (segs.length) {
      const r = await db.query(
        `UPDATE transcript_segments s SET tsv = v.tsv::tsvector
           FROM unnest($1::uuid[], $2::text[]) AS v(id, tsv)
          WHERE s.id = v.id AND s.meeting_id = $3 AND s.tsv IS DISTINCT FROM v.tsv::tsvector`,
        [segs.map((s) => s.id), segs.map((s) => indexTsv(s.text)), meetingId],
      );
      segmentsUpdated = r.rowCount ?? 0;
    }

    const settings = wsSettings(m.ws_settings);
    if (!aiEligible(m)) {
      await purgeMeetingAiIndex(db, meetingId);
      return { status: 'indexed' as const, docs: docs.length, segments: segmentsUpdated, aiIndexed: false, chunks: 0, embedded: 0, embeddingModel: null };
    }

    // ---- AI chunk plan (AI-enabled, non-confidential meetings only)
    const specs: ChunkSpec[] = [];
    const transcriptId: string | null = segs[0]?.transcript_id ?? null;
    if (transcriptId) {
      const lite: SegLite[] = segs.map((s) => ({
        id: s.id,
        startMs: s.start_ms,
        endMs: s.end_ms,
        speaker: s.display_name ?? s.person_name ?? s.speaker_label,
        text: s.text,
        personId: s.person_id ?? null,
      }));
      chunkTranscript(lite).forEach((c, i) => specs.push({ ...c, entityType: 'transcript', entityId: transcriptId, chunkIndex: i }));
    }
    if (summary && summaryText) {
      splitText(summaryText).forEach((t, i) =>
        specs.push({ entityType: 'summary', entityId: summary.id, chunkIndex: i, text: t, startMs: null, endMs: null, personIds: [], meta: { aiGenerated: true } }),
      );
    }
    for (const d of decisions) {
      if (d.review_state !== 'confirmed') continue;
      const text = [d.text, d.reason ? `理由: ${d.reason}` : ''].filter(Boolean).join('\n');
      splitText(text).forEach((t, i) =>
        specs.push({
          entityType: 'decision',
          entityId: d.id,
          chunkIndex: i,
          text: t,
          startMs: d.source_start_ms ?? null,
          endMs: d.source_end_ms ?? null,
          personIds: [d.owner_person_id, ...(d.participant_person_ids ?? [])].filter(Boolean),
          meta: { status: d.status, statusLabel: STATUS_LABEL[d.status] ?? d.status },
        }),
      );
    }
    const existing = await rows<{ id: string; entity_type: string; entity_id: string; chunk_index: number; embedding_model: string; content_hash: string | null }>(
      db,
      'SELECT id, entity_type, entity_id, chunk_index, embedding_model, content_hash FROM ai_chunks WHERE meeting_id=$1',
      [meetingId],
    );
    return { status: 'plan' as const, m, settings, docs: docs.length, segments: segmentsUpdated, specs, existing };
  });
  if (p1.status !== 'plan') return p1;

  // ---- phase 2 (no transaction open): embeddings (may be a network call for cloud providers)
  const { m, settings, specs, existing } = p1;
  const decision = embeddingDecision(settings, deps.config);
  const target = embeddingProviderFor(deps, decision);
  const keyOf = (s: { entityType?: string; entity_type?: string; entityId?: string; entity_id?: string; chunkIndex?: number; chunk_index?: number }) =>
    `${s.entityType ?? s.entity_type}:${s.entityId ?? s.entity_id}:${s.chunkIndex ?? s.chunk_index}`;
  const existingMap = new Map(existing.map((e) => [`${keyOf(e)}|${e.embedding_model}`, e]));
  const hashes = specs.map((s) => sha(s.text));
  const needFor = (model: string) => specs.map((_, i) => i).filter((i) => existingMap.get(`${keyOf(specs[i])}|${model}`)?.content_hash !== hashes[i]);
  let model = target.model;
  let need = needFor(model);
  let vectors: number[][] = [];
  let fallback: string | undefined;
  if (need.length) {
    const r = await embedTexts(
      deps,
      decision,
      need.map((i) => specs[i].text),
      { orgId, meetingIds: [meetingId], purpose: 'search.index.embedding' },
    );
    if (r.model !== model) {
      // fallback happened: the whole meeting uses the local model (one model per meeting keeps scores comparable)
      fallback = r.fallbackReason ?? 'provider unavailable';
      model = r.model;
      const again = needFor(model);
      const same = again.length === need.length && again.every((x, j) => x === need[j]);
      vectors = same ? r.vectors : await localHashProvider.embed(again.map((i) => specs[i].text));
      need = again;
    } else vectors = r.vectors;
  }

  // ---- phase 3 (tenant tx): write vectors, after re-checking privacy flags & staleness
  return tenantTx(deps, orgId, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey('meeting', meetingId)]);
    const now = await one<any>(db, 'SELECT id, ai_enabled, is_confidential, deleted_at FROM meetings WHERE id=$1', [meetingId]);
    if (!now || now.deleted_at) {
      await purgeMeetingIndex(db, meetingId);
      return { status: 'purged' as const };
    }
    if (!aiEligible(now)) {
      await purgeMeetingAiIndex(db, meetingId);
      return { status: 'indexed' as const, docs: p1.docs, segments: p1.segments, aiIndexed: false, chunks: 0, embedded: 0, embeddingModel: null };
    }
    if (opts.jobId && (await newerJobExists(db, opts.jobId, 'meetingId', meetingId, ['queued', 'running', 'succeeded']))) return { status: 'superseded' as const };
    const kept: string[] = [];
    const needSet = new Map(need.map((specIdx, k) => [specIdx, k]));
    for (const [i, s] of specs.entries()) {
      const k = needSet.get(i);
      if (k !== undefined) {
        const r = await one<{ id: string }>(
          db,
          `INSERT INTO ai_chunks(org_id, workspace_id, meeting_id, entity_type, entity_id, chunk_index, text, start_ms, end_ms, embedding, embedding_model, tsv, person_ids, meta, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::real[],$11,$12::tsvector,$13::uuid[],$14,$15)
           ON CONFLICT (entity_type, entity_id, chunk_index, embedding_model) DO UPDATE SET
             org_id=EXCLUDED.org_id, workspace_id=EXCLUDED.workspace_id, meeting_id=EXCLUDED.meeting_id, text=EXCLUDED.text, start_ms=EXCLUDED.start_ms,
             end_ms=EXCLUDED.end_ms, embedding=EXCLUDED.embedding, tsv=EXCLUDED.tsv, person_ids=EXCLUDED.person_ids, meta=EXCLUDED.meta,
             content_hash=EXCLUDED.content_hash, created_at=now()
           RETURNING id`,
          [orgId, m.workspace_id, meetingId, s.entityType, s.entityId, s.chunkIndex, s.text, s.startMs, s.endMs, vectors[k], model, indexTsv(s.text), uniq(s.personIds), s.meta, hashes[i]],
        );
        kept.push(r!.id);
      } else {
        const e = existingMap.get(`${keyOf(s)}|${model}`)!;
        await db.query('UPDATE ai_chunks SET text=$2, start_ms=$3, end_ms=$4, tsv=$5::tsvector, person_ids=$6::uuid[], meta=$7, workspace_id=$8 WHERE id=$1', [
          e.id,
          s.text,
          s.startMs,
          s.endMs,
          indexTsv(s.text),
          uniq(s.personIds),
          s.meta,
          m.workspace_id,
        ]);
        kept.push(e.id);
      }
    }
    await db.query('DELETE FROM ai_chunks WHERE meeting_id=$1 AND NOT (id = ANY($2::uuid[]))', [meetingId, kept]);
    return {
      status: 'indexed' as const,
      docs: p1.docs,
      segments: p1.segments,
      aiIndexed: true,
      chunks: specs.length,
      embedded: need.length,
      embeddingModel: specs.length ? model : null,
      ...(fallback ? { embeddingFallback: fallback } : {}),
    };
  });
}

// ------------------------------------------------------------------ index.person

/** Upserts (or removes, if deleted) the person's search doc. Person docs are workspace-level (no meeting ACL). */
export async function upsertPersonDoc(db: Db, orgId: string, personId: string): Promise<'indexed' | 'purged'> {
  const p = await one<any>(db, 'SELECT * FROM people WHERE id=$1', [personId]);
  if (!p || p.deleted_at) {
    await db.query("DELETE FROM search_docs WHERE entity_type='person' AND entity_id=$1", [personId]);
    await db.query("DELETE FROM ai_chunks WHERE entity_type='person' AND entity_id=$1", [personId]);
    return 'purged';
  }
  const notes = await rows<{ body: string }>(db, 'SELECT body FROM person_notes WHERE person_id=$1 ORDER BY created_at', [personId]);
  await upsertDoc(db, orgId, p.workspace_id, {
    entityType: 'person',
    entityId: p.id,
    meetingId: null,
    title: p.name,
    body: [
      p.name,
      p.organization ? `所属: ${p.organization}` : '',
      p.role_title ? `役職: ${p.role_title}` : '',
      p.email ?? '',
      (p.tags ?? []).length ? `タグ: ${(p.tags as string[]).join('、')}` : '',
      p.notes ?? '',
      ...notes.map((n) => n.body),
    ]
      .filter(Boolean)
      .join('\n'),
    occurredAt: p.updated_at,
    personIds: [p.id],
    meta: { organization: p.organization ?? null },
  });
  return 'indexed';
}

export async function indexPerson(deps: Deps, orgId: string, personId: string, opts: { jobId?: string } = {}) {
  return tenantTx(deps, orgId, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey('person', personId)]);
    if (opts.jobId && (await newerJobExists(db, opts.jobId, 'personId', personId, ['queued', 'running']))) return { status: 'superseded' };
    return { status: await upsertPersonDoc(db, orgId, personId) };
  });
}
