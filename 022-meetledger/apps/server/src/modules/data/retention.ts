// Job `retention.sweep` (org-less system job, scheduled hourly). Iterates organizations in system context and does
// all tenant work inside a tenant transaction per org. Each data class has its own retention:
//   audio/video     media_assets.retention_until (set per meeting by the audio pipeline)
//   transcripts     workspace settings.retention.transcriptDays
//   AI index        workspace settings.retention.aiIndexDays (ai_chunks)
//   artifacts       workspace settings.retention.artifactDays (summaries, follow-up drafts, brief caches, export files)
//   + expired sessions, MCP confirmations and invitations.
import type { Deps } from '../../context';
import { rows, withSystem, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { tenantTx } from '../../rbac/access';
import { wsSettings } from '../../privacy/policy';
import { AUDIO_KINDS, BACKUP_NOTE, deleteObjects, purgeTranscripts, recordDeletionRequest } from './deletion';

/** Export files are copies of a whole workspace: they never live longer than this, whatever artifactDays says. */
export const EXPORT_ARTIFACT_MAX_DAYS = 7;
const DAY = 86_400_000;

export interface SweepCounts {
  orgs: number;
  audioObjects: number;
  transcripts: number;
  transcriptFiles: number;
  aiChunks: number;
  summaries: number;
  followupDrafts: number;
  briefSnapshots: number;
  exportFiles: number;
  sessions: number;
  mcpConfirmations: number;
  invitations: number;
  deletionRequests: number;
}

const emptyCounts = (): SweepCounts => ({
  orgs: 0,
  audioObjects: 0,
  transcripts: 0,
  transcriptFiles: 0,
  aiChunks: 0,
  summaries: 0,
  followupDrafts: 0,
  briefSnapshots: 0,
  exportFiles: 0,
  sessions: 0,
  mcpConfirmations: 0,
  invitations: 0,
  deletionRequests: 0,
});

const retentionSteps = (extra: Record<string, unknown>) => ({ trigger: 'retention', ...extra, backups: BACKUP_NOTE });

async function record(db: Db, orgId: string, workspaceId: string, scope: 'meeting_audio' | 'meeting_transcript' | 'meeting_ai_index', meetingId: string, now: Date, steps: Record<string, unknown>) {
  await recordDeletionRequest(db, { orgId, workspaceId, scope, targetId: meetingId, label: 'retention', userId: null, now, status: 'completed', steps: retentionSteps(steps) });
}

export async function runRetentionSweep(deps: Deps, opts: { orgIds?: string[] } = {}): Promise<SweepCounts> {
  const now = deps.clock.now();
  const c = emptyCounts();
  const orgs = await withSystem(deps.pool, (db) => rows<{ id: string }>(db, 'SELECT id FROM organizations ORDER BY created_at, id'));
  for (const { id: orgId } of orgs) {
    if (opts.orgIds && !opts.orgIds.includes(orgId)) continue;
    c.orgs++;
    await sweepAudio(deps, orgId, now, c);
    const workspaces = await tenantTx(deps, orgId, (db) => rows<{ id: string; settings: unknown }>(db, 'SELECT id, settings FROM workspaces WHERE org_id=$1 AND deleted_at IS NULL', [orgId]));
    for (const ws of workspaces) {
      const r = wsSettings(ws.settings).retention;
      if (r.transcriptDays) await sweepTranscripts(deps, orgId, ws.id, new Date(now.getTime() - r.transcriptDays * DAY), now, c);
      if (r.aiIndexDays) await sweepAiIndex(deps, orgId, ws.id, new Date(now.getTime() - r.aiIndexDays * DAY), now, c);
      if (r.artifactDays) await sweepArtifacts(deps, orgId, ws.id, new Date(now.getTime() - r.artifactDays * DAY), c);
      const exportDays = Math.min(r.artifactDays ?? EXPORT_ARTIFACT_MAX_DAYS, EXPORT_ARTIFACT_MAX_DAYS);
      await sweepExportFiles(deps, orgId, ws.id, new Date(now.getTime() - exportDays * DAY), now, c);
    }
  }
  // Global, non-content housekeeping (system context: these tables are swept across all tenants).
  if (!opts.orgIds) {
    await withSystem(deps.pool, async (db) => {
      c.sessions = (await db.query('DELETE FROM sessions WHERE expires_at < $1', [now])).rowCount ?? 0;
      c.mcpConfirmations = (await db.query('DELETE FROM mcp_confirmations WHERE expires_at < $1', [now])).rowCount ?? 0;
      c.invitations = (await db.query('DELETE FROM invitations WHERE accepted_at IS NULL AND expires_at < $1', [now])).rowCount ?? 0;
    });
  }
  return c;
}

async function sweepAudio(deps: Deps, orgId: string, now: Date, c: SweepCounts) {
  const due = await tenantTx(deps, orgId, (db) =>
    rows<{ id: string; storage_key: string; meeting_id: string; workspace_id: string }>(
      db,
      `SELECT a.id, a.storage_key, a.meeting_id, m.workspace_id FROM media_assets a JOIN meetings m ON m.id = a.meeting_id
        WHERE a.org_id=$1 AND a.deleted_at IS NULL AND a.retention_until IS NOT NULL AND a.retention_until <= $2 AND a.kind = ANY($3)
        ORDER BY a.retention_until LIMIT 1000`,
      [orgId, now, AUDIO_KINDS],
    ),
  );
  if (!due.length) return;
  // Storage first; rows are tombstoned only after their objects are gone.
  await deleteObjects(deps, due.map((a) => a.storage_key));
  c.audioObjects += due.length;
  await tenantTx(deps, orgId, async (db) => {
    await db.query('UPDATE media_assets SET deleted_at=$2, retention_until=NULL WHERE id = ANY($1)', [due.map((a) => a.id), now]);
    const byMeeting = new Map<string, { ws: string; n: number }>();
    for (const a of due) byMeeting.set(a.meeting_id, { ws: a.workspace_id, n: (byMeeting.get(a.meeting_id)?.n ?? 0) + 1 });
    for (const [meetingId, v] of byMeeting) {
      await record(db, orgId, v.ws, 'meeting_audio', meetingId, now, {
        storage: { status: 'deleted', objects: v.n },
        db: { status: 'tombstoned', mediaAssets: v.n },
        search_index: { status: 'not_applicable' },
        ai_index: { status: 'not_applicable' },
        caches: { status: 'not_applicable' },
      });
      c.deletionRequests++;
    }
    await audit(db, { orgId, action: 'retention.audio_deleted', meta: { objects: due.length, meetings: byMeeting.size } });
  });
}

async function sweepTranscripts(deps: Deps, orgId: string, workspaceId: string, cutoff: Date, now: Date, c: SweepCounts) {
  const old = await tenantTx(deps, orgId, (db) =>
    rows<{ id: string; meeting_id: string }>(
      db,
      `SELECT t.id, t.meeting_id FROM transcripts t JOIN meetings m ON m.id = t.meeting_id
        WHERE m.workspace_id=$1 AND t.created_at < $2 ORDER BY t.created_at LIMIT 5000`,
      [workspaceId, cutoff],
    ),
  );
  const files = await tenantTx(deps, orgId, (db) =>
    rows<{ id: string; storage_key: string; meeting_id: string }>(
      db,
      `SELECT a.id, a.storage_key, a.meeting_id FROM media_assets a JOIN meetings m ON m.id = a.meeting_id
        WHERE m.workspace_id=$1 AND a.kind='transcript_file' AND a.deleted_at IS NULL AND a.created_at < $2`,
      [workspaceId, cutoff],
    ),
  );
  if (!old.length && !files.length) return;
  await deleteObjects(deps, files.map((f) => f.storage_key));
  c.transcriptFiles += files.length;
  const byMeeting = new Map<string, string[]>();
  for (const t of old) byMeeting.set(t.meeting_id, [...(byMeeting.get(t.meeting_id) ?? []), t.id]);
  for (const f of files) if (!byMeeting.has(f.meeting_id)) byMeeting.set(f.meeting_id, []);
  await tenantTx(deps, orgId, async (db) => {
    if (files.length) await db.query('UPDATE media_assets SET deleted_at=$2 WHERE id = ANY($1)', [files.map((f) => f.id), now]);
    for (const [meetingId, ids] of byMeeting) {
      const r = ids.length ? await purgeTranscripts(deps, db, orgId, workspaceId, meetingId, ids) : { transcripts: 0, segments: 0, searchRows: 0, aiRows: 0, clearedQuotes: 0 };
      c.transcripts += r.transcripts;
      await record(db, orgId, workspaceId, 'meeting_transcript', meetingId, now, {
        storage: { status: 'deleted', objects: files.filter((f) => f.meeting_id === meetingId).length },
        db: { status: 'deleted', transcripts: r.transcripts, segments: r.segments, clearedSourceQuotes: r.clearedQuotes },
        search_index: { status: 'deleted', rows: r.searchRows },
        ai_index: { status: 'deleted', rows: r.aiRows },
        caches: { status: 'not_applicable' },
      });
      c.deletionRequests++;
    }
    await audit(db, { orgId, workspaceId, action: 'retention.transcripts_deleted', meta: { transcripts: old.length, files: files.length } });
  });
}

async function sweepAiIndex(deps: Deps, orgId: string, workspaceId: string, cutoff: Date, now: Date, c: SweepCounts) {
  await tenantTx(deps, orgId, async (db) => {
    const del = await rows<{ meeting_id: string | null }>(db, 'DELETE FROM ai_chunks WHERE workspace_id=$1 AND created_at < $2 RETURNING meeting_id', [workspaceId, cutoff]);
    if (!del.length) return;
    c.aiChunks += del.length;
    const byMeeting = new Map<string, number>();
    for (const r of del) if (r.meeting_id) byMeeting.set(r.meeting_id, (byMeeting.get(r.meeting_id) ?? 0) + 1);
    for (const [meetingId, n] of byMeeting) {
      await record(db, orgId, workspaceId, 'meeting_ai_index', meetingId, now, {
        storage: { status: 'not_applicable' },
        db: { status: 'kept' },
        search_index: { status: 'kept' },
        ai_index: { status: 'deleted', rows: n },
        caches: { status: 'not_applicable' },
      });
      c.deletionRequests++;
    }
    await audit(db, { orgId, workspaceId, action: 'retention.ai_index_deleted', meta: { chunks: del.length, meetings: byMeeting.size } });
  });
}

async function sweepArtifacts(deps: Deps, orgId: string, workspaceId: string, cutoff: Date, c: SweepCounts) {
  await tenantTx(deps, orgId, async (db) => {
    const inWs = 'meeting_id IN (SELECT id FROM meetings WHERE workspace_id=$1)';
    const summaries = await rows<{ id: string }>(db, `DELETE FROM summaries WHERE ${inWs} AND created_at < $2 RETURNING id`, [workspaceId, cutoff]);
    const drafts = await rows<{ id: string }>(db, `DELETE FROM followup_drafts WHERE ${inWs} AND updated_at < $2 RETURNING id`, [workspaceId, cutoff]);
    const briefs = await db.query(`DELETE FROM brief_snapshots WHERE ${inWs} AND generated_at < $2`, [workspaceId, cutoff]);
    const ids = [...summaries, ...drafts].map((r) => r.id);
    if (ids.length) {
      await db.query('DELETE FROM search_docs WHERE workspace_id=$1 AND entity_id = ANY($2)', [workspaceId, ids]);
      await db.query('DELETE FROM ai_chunks WHERE workspace_id=$1 AND entity_id = ANY($2)', [workspaceId, ids]);
    }
    c.summaries += summaries.length;
    c.followupDrafts += drafts.length;
    c.briefSnapshots += briefs.rowCount ?? 0;
    if (ids.length || briefs.rowCount) await audit(db, { orgId, workspaceId, action: 'retention.artifacts_deleted', meta: { summaries: summaries.length, followups: drafts.length, briefs: briefs.rowCount ?? 0 } });
  });
}

async function sweepExportFiles(deps: Deps, orgId: string, workspaceId: string, cutoff: Date, now: Date, c: SweepCounts) {
  const due = await tenantTx(deps, orgId, (db) =>
    rows<{ id: string; key: string }>(
      db,
      `SELECT id, result->>'storageKey' AS key FROM jobs
        WHERE org_id=$1 AND type='export.full' AND status='succeeded' AND payload->>'workspaceId' = $2
          AND result ? 'storageKey' AND NOT coalesce((result->>'expired')::boolean, false) AND finished_at < $3`,
      [orgId, workspaceId, cutoff],
    ),
  );
  if (!due.length) return;
  await deleteObjects(deps, due.map((d) => d.key).filter(Boolean));
  c.exportFiles += due.length;
  await tenantTx(deps, orgId, (db) =>
    db.query(`UPDATE jobs SET result = result || jsonb_build_object('expired', true, 'expiredAt', $2::timestamptz) WHERE id = ANY($1)`, [due.map((d) => d.id), now]),
  );
}
