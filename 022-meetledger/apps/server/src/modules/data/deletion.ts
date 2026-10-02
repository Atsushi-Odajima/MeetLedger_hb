// Meeting deletion (full and partial). Order: authorize + record request → storage objects → DB rows / indexes / caches.
// Every deletion leaves a deletion_requests row whose `steps` describe what happened to DB, storage, search index,
// AI index, caches and backups (backups are NOT rewritten; data disappears from them by backup rotation).
import { roleAtLeast } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { forbidden } from '../../lib/errors';
import { loadMeeting } from '../../rbac/access';

export const BACKUP_NOTE = 'retained until backup rotation (see docs)';
export const AUDIO_KINDS = ['original_audio', 'original_video', 'normalized_audio'];

export type DeletionScope = 'meeting' | 'meeting_audio' | 'meeting_transcript' | 'meeting_ai_index';

export interface DeletionResult {
  deletionRequestId: string;
  scope: DeletionScope;
  status: 'completed' | 'failed';
  steps: Record<string, unknown>;
}

/** Writer + (creator or admin). Private meetings of others stay invisible (404) even for admins. */
async function authorize(db: Db, ctx: WsCtx, meetingId: string) {
  const m = await loadMeeting(db, ctx, meetingId, 'write');
  if (m.created_by !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw forbidden('Only the meeting creator or an admin can delete meeting data');
  return m;
}

async function createRequest(db: Db, d: { orgId: string; workspaceId: string; scope: DeletionScope; targetId: string; label: string; userId: string | null; now: Date; status?: string; steps?: unknown }) {
  const r = await one<{ id: string }>(
    db,
    `INSERT INTO deletion_requests(org_id, workspace_id, scope, target_id, target_label, requested_by, status, steps, created_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $7 = 'completed' THEN $9::timestamptz ELSE NULL END) RETURNING id`,
    [d.orgId, d.workspaceId, d.scope, d.targetId, d.label, d.userId, d.status ?? 'pending', d.steps ?? {}, d.now],
  );
  return r!.id;
}

async function finishRequest(db: Db, id: string, status: 'completed' | 'failed', steps: Record<string, unknown>, now: Date) {
  await db.query('UPDATE deletion_requests SET status=$2, steps=$3, completed_at=$4 WHERE id=$1', [id, status, steps, now]);
}

/** Label without content: titles can be sensitive, so only the date is kept in the deletion log. */
export function meetingLabel(m: any) {
  const d = m.scheduled_start ?? m.started_at ?? m.created_at;
  return `meeting ${d ? new Date(d).toISOString().slice(0, 10) : ''}`.trim();
}

/** Deletes storage objects; missing objects count as deleted (idempotent). */
export async function deleteObjects(deps: Deps, keys: string[]): Promise<number> {
  let n = 0;
  for (const k of [...new Set(keys)]) {
    await deps.storage.delete(k);
    n++;
  }
  return n;
}

async function meetingObjectKeys(deps: Deps, orgId: string, meetingId: string, dbKeys: string[]): Promise<string[]> {
  let listed: string[] = [];
  try {
    listed = await deps.storage.list(`org/${orgId}/meeting/${meetingId}/`);
  } catch {
    listed = [];
  }
  return [...new Set([...dbKeys, ...listed])];
}

/** Entity ids that belong to a meeting (used to purge index rows, notifications, caches, ledger events). */
async function meetingEntityIds(db: Db, meetingId: string): Promise<{ all: string[]; ledger: string[] }> {
  const r = await rows<{ id: string; kind: string }>(
    db,
    `SELECT id, 'segment' AS kind FROM transcript_segments WHERE meeting_id=$1
     UNION ALL SELECT id, 'summary' FROM summaries WHERE meeting_id=$1
     UNION ALL SELECT id, 'note' FROM meeting_notes WHERE meeting_id=$1
     UNION ALL SELECT id, 'ledger' FROM decisions WHERE meeting_id=$1
     UNION ALL SELECT id, 'ledger' FROM actions WHERE meeting_id=$1
     UNION ALL SELECT id, 'ledger' FROM commitments WHERE meeting_id=$1
     UNION ALL SELECT id, 'ledger' FROM open_questions WHERE meeting_id=$1
     UNION ALL SELECT id, 'followup' FROM followup_drafts WHERE meeting_id=$1
     UNION ALL SELECT id, 'transcript' FROM transcripts WHERE meeting_id=$1`,
    [meetingId],
  );
  return { all: [meetingId, ...r.map((x) => x.id)], ledger: r.filter((x) => x.kind === 'ledger').map((x) => x.id) };
}

async function count(db: Db, sql: string, params: unknown[]) {
  return (await one<{ n: number }>(db, sql, params))!.n;
}

/** Cancels queued jobs for the meeting (pipeline / extraction / indexing caches). */
async function cancelQueuedJobs(db: Db, meetingId: string, types?: string[]): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET status='cancelled', updated_at=now(), finished_at=now(), last_error='meeting data deleted'
      WHERE status='queued' AND payload->>'meetingId' = $1 ${types ? 'AND type = ANY($2)' : ''}`,
    types ? [meetingId, types] : [meetingId],
  );
  return r.rowCount ?? 0;
}

async function enqueueIndex(deps: Deps, db: Db, orgId: string, meetingId: string) {
  await deps.jobs.enqueue(db, { orgId, type: 'index.meeting', key: `index:${meetingId}:${Date.now()}`, payload: { meetingId } });
}

// ------------------------------------------------------------------ full meeting delete

export async function deleteMeetingFully(ctx: WsCtx, meetingId: string): Promise<DeletionResult> {
  const deps = ctx.deps;
  const prep = await ctx.tx(async (db) => {
    const m = await authorize(db, ctx, meetingId);
    const keys = (await rows<{ storage_key: string }>(db, 'SELECT storage_key FROM media_assets WHERE meeting_id=$1', [meetingId])).map((r) => r.storage_key);
    const reqId = await createRequest(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, scope: 'meeting', targetId: meetingId, label: meetingLabel(m), userId: ctx.userId, now: deps.clock.now() });
    return { m, keys, reqId };
  });
  const steps: Record<string, unknown> = { backups: BACKUP_NOTE };
  try {
    // 1) storage objects (encrypted media, transcript files, derived files under the meeting prefix)
    const keys = await meetingObjectKeys(deps, ctx.orgId, meetingId, prep.keys);
    steps.storage = { status: 'deleted', objects: await deleteObjects(deps, keys) };
    // 2) DB rows, indexes and caches in one transaction
    await ctx.tx(async (db) => {
      const ent = await meetingEntityIds(db, meetingId);
      const people = (await rows<{ person_id: string }>(db, 'SELECT DISTINCT person_id FROM participants WHERE meeting_id=$1 AND person_id IS NOT NULL', [meetingId])).map((r) => r.person_id);
      const dbCounts = {
        transcripts: await count(db, 'SELECT count(*)::int n FROM transcripts WHERE meeting_id=$1', [meetingId]),
        segments: await count(db, 'SELECT count(*)::int n FROM transcript_segments WHERE meeting_id=$1', [meetingId]),
        mediaAssets: await count(db, 'SELECT count(*)::int n FROM media_assets WHERE meeting_id=$1', [meetingId]),
        ledgerItems: ent.ledger.length,
        summaries: await count(db, 'SELECT count(*)::int n FROM summaries WHERE meeting_id=$1', [meetingId]),
        followups: await count(db, 'SELECT count(*)::int n FROM followup_drafts WHERE meeting_id=$1', [meetingId]),
        notes: await count(db, 'SELECT count(*)::int n FROM meeting_notes WHERE meeting_id=$1', [meetingId]),
      };
      const search = await db.query('DELETE FROM search_docs WHERE workspace_id=$1 AND (meeting_id=$2 OR entity_id = ANY($3))', [ctx.workspaceId, meetingId, ent.all]);
      const ai = await db.query('DELETE FROM ai_chunks WHERE workspace_id=$1 AND (meeting_id=$2 OR entity_id = ANY($3))', [ctx.workspaceId, meetingId, ent.all]);
      const notif = await db.query(
        `DELETE FROM notifications WHERE org_id=$1 AND (entity_id = ANY($2) OR coalesce(link,'') LIKE '%' || $3 || '%')`,
        [ctx.orgId, ent.all, meetingId],
      );
      // Brief snapshots are caches; drop the meeting's own and any other snapshot that mentions its content ids.
      const briefs = await db.query(
        `DELETE FROM brief_snapshots b WHERE b.meeting_id=$1
            OR (b.meeting_id IN (SELECT id FROM meetings WHERE workspace_id=$2)
                AND EXISTS (SELECT 1 FROM unnest($3::uuid[]) e(id) WHERE strpos(b.content::text, e.id::text) > 0))`,
        [meetingId, ctx.workspaceId, ent.all],
      );
      const events = await db.query('DELETE FROM ledger_events WHERE workspace_id=$1 AND entity_id = ANY($2)', [ctx.workspaceId, ent.all]);
      const jobs = await cancelQueuedJobs(db, meetingId);
      await db.query('DELETE FROM meetings WHERE id=$1 AND workspace_id=$2', [meetingId, ctx.workspaceId]);
      steps.db = { status: 'deleted', ...dbCounts, ledgerEvents: events.rowCount ?? 0 };
      steps.search_index = { status: 'deleted', rows: search.rowCount ?? 0 };
      steps.ai_index = { status: 'deleted', rows: ai.rowCount ?? 0 };
      steps.caches = { status: 'deleted', briefSnapshots: briefs.rowCount ?? 0, notifications: notif.rowCount ?? 0, cancelledJobs: jobs };
      // Person pages / person index may quote this meeting: rebuild them.
      for (const pid of people) await deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.person', key: `index-person:${pid}:${Date.now()}`, payload: { personId: pid } });
      await finishRequest(db, prep.reqId, 'completed', steps, deps.clock.now());
      await audit(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId, action: 'meeting.deleted', entityType: 'meeting', entityId: meetingId, meta: { deletionRequestId: prep.reqId } });
    });
    return { deletionRequestId: prep.reqId, scope: 'meeting', status: 'completed', steps };
  } catch (e) {
    await ctx.tx((db) => finishRequest(db, prep.reqId, 'failed', { ...steps, error: 'deletion failed; retry the request' }, deps.clock.now())).catch(() => undefined);
    throw e;
  }
}

// ------------------------------------------------------------------ partial deletes

/** Deletes original/normalized audio & video (storage objects; rows stay as tombstones with deleted_at). */
export async function deleteMeetingAudio(ctx: WsCtx, meetingId: string): Promise<DeletionResult> {
  const deps = ctx.deps;
  const prep = await ctx.tx(async (db) => {
    const m = await authorize(db, ctx, meetingId);
    const assets = await rows<{ id: string; storage_key: string }>(db, 'SELECT id, storage_key FROM media_assets WHERE meeting_id=$1 AND kind = ANY($2) AND deleted_at IS NULL', [
      meetingId,
      AUDIO_KINDS,
    ]);
    const reqId = await createRequest(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, scope: 'meeting_audio', targetId: meetingId, label: meetingLabel(m), userId: ctx.userId, now: deps.clock.now() });
    return { assets, reqId };
  });
  const steps: Record<string, unknown> = { backups: BACKUP_NOTE };
  try {
    steps.storage = { status: 'deleted', objects: await deleteObjects(deps, prep.assets.map((a) => a.storage_key)) };
    await ctx.tx(async (db) => {
      await db.query('UPDATE media_assets SET deleted_at=$2, retention_until=NULL WHERE id = ANY($1)', [prep.assets.map((a) => a.id), deps.clock.now()]);
      const jobs = await cancelQueuedJobs(db, meetingId, ['audio.process']);
      steps.db = { status: 'tombstoned', mediaAssets: prep.assets.length, note: 'media_assets rows keep metadata only (deleted_at set)' };
      steps.search_index = { status: 'not_applicable' };
      steps.ai_index = { status: 'not_applicable' };
      steps.caches = { status: 'deleted', cancelledJobs: jobs };
      await finishRequest(db, prep.reqId, 'completed', steps, deps.clock.now());
      await audit(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId, action: 'meeting.audio_deleted', entityType: 'meeting', entityId: meetingId, meta: { assets: prep.assets.length } });
    });
    return { deletionRequestId: prep.reqId, scope: 'meeting_audio', status: 'completed', steps };
  } catch (e) {
    await ctx.tx((db) => finishRequest(db, prep.reqId, 'failed', { ...steps, error: 'deletion failed; retry the request' }, deps.clock.now())).catch(() => undefined);
    throw e;
  }
}

/**
 * Removes transcripts (all versions, segments, revisions, imported transcript files) and their index rows.
 * Ledger items keep their own text; their source quotes are cleared and sources show as "missing".
 * Shared by the API and the retention sweep (transcriptIds = subset to delete; null = all).
 */
export async function purgeTranscripts(deps: Deps, db: Db, orgId: string, workspaceId: string, meetingId: string, transcriptIds: string[] | null) {
  const ts = transcriptIds ?? (await rows<{ id: string }>(db, 'SELECT id FROM transcripts WHERE meeting_id=$1', [meetingId])).map((r) => r.id);
  const segIds = ts.length ? (await rows<{ id: string }>(db, 'SELECT id FROM transcript_segments WHERE transcript_id = ANY($1)', [ts])).map((r) => r.id) : [];
  const ids = [...ts, ...segIds];
  // Index rows keyed by transcript / segment ids; when every version goes, also any transcript-typed row of the meeting.
  const all = transcriptIds === null;
  const idxSql = (t: string) =>
    `DELETE FROM ${t} WHERE workspace_id=$1 AND (entity_id = ANY($2::uuid[]) OR ($3::boolean AND meeting_id=$4 AND entity_type IN ('transcript','segment')))`;
  const search = await db.query(idxSql('search_docs'), [workspaceId, ids, all, meetingId]);
  const ai = await db.query(idxSql('ai_chunks'), [workspaceId, ids, all, meetingId]);
  let quotes = 0;
  for (const table of ['decisions', 'actions', 'commitments', 'open_questions']) {
    const r = await db.query(
      `UPDATE ${table} SET source_quote = NULL WHERE workspace_id=$1 AND source_quote IS NOT NULL AND (source_transcript_id = ANY($2) OR source_segment_ids && $3::uuid[])`,
      [workspaceId, ts, segIds],
    );
    quotes += r.rowCount ?? 0;
  }
  const del = ts.length ? await db.query('DELETE FROM transcripts WHERE meeting_id=$1 AND id = ANY($2)', [meetingId, ts]) : { rowCount: 0 };
  // Keep exactly one current transcript if older versions were removed but a newer one survives.
  await db.query(
    `UPDATE transcripts SET is_current = true WHERE id = (SELECT id FROM transcripts WHERE meeting_id=$1 ORDER BY version DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM transcripts WHERE meeting_id=$1 AND is_current)`,
    [meetingId],
  );
  await enqueueIndex(deps, db, orgId, meetingId);
  return { transcripts: del.rowCount ?? 0, segments: segIds.length, searchRows: search.rowCount ?? 0, aiRows: ai.rowCount ?? 0, clearedQuotes: quotes };
}

export async function deleteMeetingTranscript(ctx: WsCtx, meetingId: string): Promise<DeletionResult> {
  const deps = ctx.deps;
  const prep = await ctx.tx(async (db) => {
    const m = await authorize(db, ctx, meetingId);
    const files = await rows<{ id: string; storage_key: string }>(db, `SELECT id, storage_key FROM media_assets WHERE meeting_id=$1 AND kind='transcript_file' AND deleted_at IS NULL`, [meetingId]);
    const reqId = await createRequest(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, scope: 'meeting_transcript', targetId: meetingId, label: meetingLabel(m), userId: ctx.userId, now: deps.clock.now() });
    return { files, reqId };
  });
  const steps: Record<string, unknown> = { backups: BACKUP_NOTE };
  try {
    steps.storage = { status: 'deleted', objects: await deleteObjects(deps, prep.files.map((f) => f.storage_key)) };
    await ctx.tx(async (db) => {
      const r = await purgeTranscripts(deps, db, ctx.orgId, ctx.workspaceId, meetingId, null);
      await db.query('UPDATE media_assets SET deleted_at=$2 WHERE id = ANY($1)', [prep.files.map((f) => f.id), deps.clock.now()]);
      const briefs = await db.query('DELETE FROM brief_snapshots WHERE meeting_id=$1', [meetingId]);
      const jobs = await cancelQueuedJobs(db, meetingId, ['ai.extract']);
      steps.db = { status: 'deleted', transcripts: r.transcripts, segments: r.segments, clearedSourceQuotes: r.clearedQuotes, note: 'ledger items keep their own text; sources become missing' };
      steps.search_index = { status: 'deleted', rows: r.searchRows };
      steps.ai_index = { status: 'deleted', rows: r.aiRows };
      steps.caches = { status: 'deleted', briefSnapshots: briefs.rowCount ?? 0, cancelledJobs: jobs };
      await finishRequest(db, prep.reqId, 'completed', steps, deps.clock.now());
      await audit(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId, action: 'meeting.transcript_deleted', entityType: 'meeting', entityId: meetingId, meta: { transcripts: r.transcripts } });
    });
    return { deletionRequestId: prep.reqId, scope: 'meeting_transcript', status: 'completed', steps };
  } catch (e) {
    await ctx.tx((db) => finishRequest(db, prep.reqId, 'failed', { ...steps, error: 'deletion failed; retry the request' }, deps.clock.now())).catch(() => undefined);
    throw e;
  }
}

/** Deletes the meeting's semantic (AI) index. Optionally turns AI OFF so it is not rebuilt. */
export async function deleteMeetingAiIndex(ctx: WsCtx, meetingId: string, opts: { disableAi?: boolean } = {}): Promise<DeletionResult> {
  const deps = ctx.deps;
  return ctx.tx(async (db) => {
    const m = await authorize(db, ctx, meetingId);
    const ent = await meetingEntityIds(db, meetingId);
    const ai = await db.query('DELETE FROM ai_chunks WHERE workspace_id=$1 AND (meeting_id=$2 OR entity_id = ANY($3))', [ctx.workspaceId, meetingId, ent.all]);
    if (opts.disableAi) {
      await db.query('UPDATE meetings SET ai_enabled=false, version=version+1, updated_at=now() WHERE id=$1', [meetingId]);
      // Re-index so the search module drops / never rebuilds semantic vectors for this (now AI OFF) meeting.
      await enqueueIndex(deps, db, ctx.orgId, meetingId);
    }
    const steps = {
      db: { status: opts.disableAi ? 'ai_disabled' : 'kept' },
      storage: { status: 'not_applicable' },
      search_index: { status: 'kept', note: 'full-text search index is kept while the content exists' },
      ai_index: { status: 'deleted', rows: ai.rowCount ?? 0, rebuild: opts.disableAi ? 'never (AI OFF)' : 'rebuilt when meeting content changes' },
      caches: { status: 'not_applicable' },
      backups: BACKUP_NOTE,
    };
    const reqId = await createRequest(db, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      scope: 'meeting_ai_index',
      targetId: meetingId,
      label: meetingLabel(m),
      userId: ctx.userId,
      now: deps.clock.now(),
      status: 'completed',
      steps,
    });
    await audit(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId, action: 'meeting.ai_index_deleted', entityType: 'meeting', entityId: meetingId, meta: { rows: ai.rowCount ?? 0 } });
    return { deletionRequestId: reqId, scope: 'meeting_ai_index' as const, status: 'completed' as const, steps };
  });
}

export { createRequest as recordDeletionRequest };
