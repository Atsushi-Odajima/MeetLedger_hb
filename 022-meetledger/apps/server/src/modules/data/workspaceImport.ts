// POST /import/full: restores a `meetledger.workspace-export/v1` document into an EMPTY workspace.
// - Every id gets a new UUID; FK columns, uuid[] columns and ids inside jsonb (e.g. source_revisions keys,
//   summary citations, referenced_items) are remapped consistently, so relations survive
//   (decision supersede links, action→decision, commitments→meetings, segments→speakers ...).
// - org_id / workspace_id are forced to the target tenant; references to rows that are not part of the
//   document are dropped (NULL) or the row is skipped when the reference is mandatory (no cross-tenant links).
// - Users are matched by email to existing members of the target workspace; unmatched authors map to the importer.
//   Identity links (person ↔ user, assignee/promiser user) of unmatched users become NULL instead, so an import never
//   claims that the importer is somebody else; inviting that user later re-links people by email.
// - Cloud-processing permissions in the imported settings are NOT applied (local-first: an admin must opt in again).
// - Search / AI index is rebuilt by re-enqueueing index.meeting / index.person.
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { badRequest, conflict } from '../../lib/errors';
import { mediaKey } from '../../storage/types';
import { wsSettings } from '../../privacy/policy';
import { insertObjects, insertionPlan, loadCatalog, type Catalog, type TableInfo } from './catalog';
import { EXPORT_ONLY, NEVER_EXPORT, ROOT_TABLES, SECRET_COLUMN, WORKSPACE_EXPORT_FORMAT } from './workspaceExport';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns that state "this record IS that user" — never re-pointed at the importer. */
const IDENTITY_LINK_COLUMNS = new Set(['people.user_id', 'participants.user_id', 'actions.assignee_user_id', 'commitments.promised_by_user_id', 'commitments.promised_to_user_id']);

const MEDIA_KINDS = ['original_audio', 'original_video', 'normalized_audio', 'transcript_file', 'attachment'];

/** Tables whose content must be empty in the target workspace. */
const CONTENT_TABLES = ['meetings', 'people', 'projects', 'series', 'templates', 'decisions', 'actions', 'commitments', 'open_questions'];

const docSchema = z.object({
  format: z.literal(WORKSPACE_EXPORT_FORMAT),
  version: z.literal(1),
  generatedAt: z.string().optional(),
  schemaMigrations: z.array(z.string().max(200)).max(1000).default([]),
  source: z.object({ orgId: z.string().regex(UUID_RE), workspaceId: z.string().regex(UUID_RE) }).passthrough(),
  workspace: z.object({ name: z.string().max(200).optional(), settings: z.unknown().optional() }).passthrough().optional(),
  users: z.array(z.object({ id: z.string().regex(UUID_RE), email: z.string().max(320).nullable().optional(), name: z.string().max(300).nullable().optional() })).max(100_000).default([]),
  tables: z.record(z.string().max(100), z.array(z.record(z.string(), z.unknown()))),
  media: z
    .array(z.object({ assetId: z.string().regex(UUID_RE), mime: z.string().max(200).optional(), data: z.string(), size: z.number().optional(), sha256: z.string().max(64).optional() }))
    .default([]),
});
export type WorkspaceExportDoc = z.infer<typeof docSchema>;

const settingsSchema = z
  .object({
    defaults: z
      .object({
        visibility: z.enum(['private', 'workspace', 'selected']),
        audioRetention: z.enum(['never', 'until_processed', '7d', '30d', 'custom']),
        audioRetentionDays: z.number().int().min(1).max(3650).nullable(),
        transcriptionMode: z.enum(['local', 'cloud', 'none']),
        aiEnabled: z.boolean(),
      })
      .partial(),
    transcription: z.object({ language: z.enum(['ja', 'en', 'auto']) }).partial(),
    retention: z
      .object({
        transcriptDays: z.number().int().min(1).max(36500).nullable(),
        aiIndexDays: z.number().int().min(1).max(36500).nullable(),
        artifactDays: z.number().int().min(1).max(36500).nullable(),
      })
      .partial(),
  })
  .partial();

export interface ImportResult {
  workspaceId: string;
  counts: Record<string, number>;
  skipped: Record<string, number>;
  ignoredTables: string[];
  users: { matched: number; mappedToImporter: number };
  media: { restored: number; missing: number };
  reindexQueued: number;
  warnings: string[];
}

export function parseExportDoc(raw: unknown): WorkspaceExportDoc {
  const r = docSchema.safeParse(raw);
  if (!r.success) {
    const formatIssue = r.error.issues.find((i) => i.path[0] === 'format' || i.path[0] === 'version');
    throw badRequest(formatIssue ? 'Unsupported export format/version (expected meetledger.workspace-export/v1)' : 'Invalid export document', r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

function remapJson(v: unknown, map: (s: string) => string | undefined): unknown {
  if (typeof v === 'string') return UUID_RE.test(v) ? (map(v) ?? v) : v;
  if (Array.isArray(v)) return v.map((x) => remapJson(x, map));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[UUID_RE.test(k) ? (map(k) ?? k) : k] = remapJson(x, map);
    return out;
  }
  return v;
}

export async function importWorkspace(db: Db, ctx: WsCtx, doc: WorkspaceExportDoc): Promise<ImportResult> {
  const warnings: string[] = [];
  // ---- version / schema validation
  const applied = new Set((await rows<{ name: string }>(db, 'SELECT name FROM schema_migrations')).map((r) => r.name));
  const unknown = doc.schemaMigrations.filter((m) => !applied.has(m));
  if (unknown.length) throw badRequest('This export was created by a newer MeetLedger version; upgrade this server first', { unknownMigrations: unknown.slice(0, 20) });

  // ---- target must be empty (lock the workspace row against concurrent imports)
  await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ctx.workspaceId]);
  for (const t of CONTENT_TABLES) {
    const r = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${t} WHERE workspace_id=$1`, [ctx.workspaceId]);
    if (r!.n > 0) throw conflict('Import requires an empty workspace', { code: 'workspace_not_empty', table: t });
  }

  const cat: Catalog = await loadCatalog(db);
  const importable = Object.keys(doc.tables).filter((t) => cat.has(t) && !NEVER_EXPORT.has(t) && !EXPORT_ONLY.has(t) && !ROOT_TABLES.has(t));
  const ignoredTables = Object.keys(doc.tables).filter((t) => !importable.includes(t));

  // ---- id map (old -> new) for every row with an id, plus the tenant roots
  const idMap = new Map<string, string>([
    [doc.source.workspaceId, ctx.workspaceId],
    [doc.source.orgId, ctx.orgId],
  ]);
  for (const t of importable) {
    if (!cat.get(t)!.hasId) continue;
    for (const r of doc.tables[t]) {
      const id = r.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) throw badRequest(`Invalid id in table ${t}`);
      if (idMap.has(id)) throw badRequest(`Duplicate id in table ${t}`);
      idMap.set(id, randomUUID());
    }
  }

  // ---- users: match by email to members of the target workspace, otherwise the importer
  const members = await rows<{ id: string; email: string }>(db, 'SELECT u.id, lower(u.email) AS email FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id=$1', [ctx.workspaceId]);
  const byEmail = new Map(members.map((m) => [m.email, m.id]));
  const userMap = new Map<string, string>();
  let matched = 0;
  let toImporter = 0;
  for (const u of doc.users) {
    const hit = u.email ? byEmail.get(u.email.toLowerCase()) : undefined;
    if (hit) {
      userMap.set(u.id, hit);
      matched++;
    } else toImporter++;
  }
  const mapUser = (old: string, identity: boolean): string | null => userMap.get(old) ?? (identity ? null : ctx.userId);
  const mapAny = (s: string) => idMap.get(s) ?? userMap.get(s);

  const plan = insertionPlan(cat, importable);
  const counts: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const newMeetingIds: string[] = [];
  const newPersonIds: string[] = [];
  const mediaById = new Map(doc.media.map((m) => [m.assetId, m]));
  const writtenKeys: string[] = [];
  let mediaRestored = 0;
  let mediaMissing = 0;
  const now = ctx.deps.clock.now();

  try {
    for (const t of plan.order) {
      const info: TableInfo = cat.get(t)!;
      const deferred = plan.deferred.get(t) ?? [];
      let out: Record<string, unknown>[] = [];
      for (const src of doc.tables[t]) {
        const row: Record<string, unknown> = {};
        let skip = false;
        for (const col of info.columnOrder) {
          if (!(col in src) || SECRET_COLUMN.test(col)) continue;
          const c = info.columns.get(col)!;
          if (c.generated) continue;
          let v = src[col] as unknown;
          if (col === 'org_id') v = ctx.orgId;
          else if (col === 'workspace_id') v = ctx.workspaceId; // every imported row belongs to the target workspace
          else if (c.udt === 'uuid' && v != null) {
            if (typeof v !== 'string' || !UUID_RE.test(v)) {
              skip = true;
              break;
            }
            const ref = info.fks.get(col);
            if (col === 'id') v = idMap.get(v)!;
            else if (ref === 'users') v = mapUser(v, IDENTITY_LINK_COLUMNS.has(`${t}.${col}`));
            else if (ref) v = idMap.get(v) ?? null;
            else v = idMap.get(v) ?? userMap.get(v) ?? (c.nullable ? null : v);
            if (v === null && !c.nullable) {
              skip = true;
              break;
            }
          } else if (c.udt === '_uuid' && Array.isArray(v)) {
            v = v.map((x) => (typeof x === 'string' ? mapAny(x) : undefined)).filter((x): x is string => !!x);
          } else if ((c.udt === 'jsonb' || c.udt === 'json') && v != null) {
            v = remapJson(v, mapAny);
          }
          row[col] = v;
        }
        if (skip) {
          skipped[t] = (skipped[t] ?? 0) + 1;
          continue;
        }
        if (t === 'media_assets') {
          if (!MEDIA_KINDS.includes(String(row.kind))) {
            skipped[t] = (skipped[t] ?? 0) + 1;
            continue;
          }
          const media = mediaById.get(String(src.id));
          const newId = String(row.id);
          row.storage_key = mediaKey(ctx.orgId, String(row.meeting_id), String(row.kind), newId);
          if (media && !src.deleted_at) {
            const buf = Buffer.from(media.data, 'base64');
            if (media.sha256 && createHash('sha256').update(buf).digest('hex') !== media.sha256) throw badRequest('Media checksum mismatch in export document');
            await ctx.deps.storage.putBuffer(String(row.storage_key), buf);
            writtenKeys.push(String(row.storage_key));
            mediaRestored++;
          } else if (!row.deleted_at) {
            row.deleted_at = now.toISOString();
            row.retention_until = null;
            mediaMissing++;
          }
        }
        out.push(row);
      }
      if (t === 'meeting_notes') out = mergeNotes(out);
      counts[t] = await insertObjects(db, info, out, deferred, { onConflictDoNothing: true });
      if (counts[t] < out.length) skipped[t] = (skipped[t] ?? 0) + (out.length - counts[t]);
      if (t === 'meetings') newMeetingIds.push(...out.map((r) => String(r.id)));
      if (t === 'people') newPersonIds.push(...out.map((r) => String(r.id)));
    }

    // ---- settings (cloud permissions are never imported)
    if (doc.workspace?.settings) {
      const s = settingsSchema.safeParse(doc.workspace.settings);
      if (s.success) {
        const cur = wsSettings((await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]))?.settings);
        const next = {
          defaults: { ...cur.defaults, ...(s.data.defaults ?? {}) },
          transcription: { ...cur.transcription, ...(s.data.transcription ?? {}) },
          ai: cur.ai,
          retention: { ...cur.retention, ...(s.data.retention ?? {}) },
        };
        if (next.defaults.transcriptionMode === 'cloud' && !next.transcription.cloudAllowed) next.defaults.transcriptionMode = 'local';
        if (next.defaults.audioRetention === 'custom' && !next.defaults.audioRetentionDays) next.defaults.audioRetention = 'until_processed';
        await db.query('UPDATE workspaces SET settings=$2 WHERE id=$1', [ctx.workspaceId, next]);
        warnings.push('クラウド処理の許可設定（文字起こし/AI）はインポートされません。必要な場合は設定画面で再度有効化してください。');
      } else warnings.push('workspace settings in the export were invalid and were not applied');
    }

    // ---- re-index
    for (const id of newMeetingIds) await ctx.deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.meeting', key: `index:${id}:${Date.now()}`, payload: { meetingId: id } });
    for (const id of newPersonIds) await ctx.deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.person', key: `index-person:${id}:${Date.now()}`, payload: { personId: id } });
    await audit(db, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'workspace.imported',
      meta: { tables: Object.keys(counts).length, meetings: newMeetingIds.length, media: mediaRestored },
    });
  } catch (e: any) {
    for (const k of writtenKeys) await ctx.deps.storage.delete(k).catch(() => undefined);
    if (e?.status) throw e;
    // Constraint violations etc.: report the failing class of error, never echo row content.
    throw badRequest('Import failed: the document is inconsistent with this server schema', { code: e?.code ?? null });
  }
  return {
    workspaceId: ctx.workspaceId,
    counts,
    skipped,
    ignoredTables,
    users: { matched, mappedToImporter: toImporter },
    media: { restored: mediaRestored, missing: mediaMissing },
    reindexQueued: newMeetingIds.length + newPersonIds.length,
    warnings,
  };
}

/** Two source authors mapped to the same target user would collide on (meeting_id, author_user_id): merge their notes. */
function mergeNotes(list: Record<string, unknown>[]): Record<string, unknown>[] {
  const by = new Map<string, Record<string, unknown>>();
  for (const n of list) {
    const k = `${n.meeting_id}:${n.author_user_id}`;
    const prev = by.get(k);
    if (!prev) by.set(k, { ...n });
    else prev.body = `${prev.body ?? ''}\n\n---\n\n${n.body ?? ''}`;
  }
  return [...by.values()];
}
