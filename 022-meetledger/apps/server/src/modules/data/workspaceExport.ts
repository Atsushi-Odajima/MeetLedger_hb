// Full workspace export (job `export.full`) → JSON document `meetledger.workspace-export/v1`.
// - Contains every workspace tenant row the requesting admin can see (meeting ACL applies: other users' private
//   meetings are NOT exported — complete operator backups use the CLI `backup` command instead).
// - Referenced users are exported as {id, name, email} only. Password hashes, session/API/invitation tokens,
//   connector tokens, webhook secrets, OAuth state and other secrets are never exported.
// - Derived data (search index, AI vectors, brief caches, notifications, jobs) is not exported; the importer re-indexes.
//   This keeps the export AI-provider neutral (no embedding vectors locked to a provider).
// - Optional media: decrypted media is embedded as base64 (field `media`).
// The document is stored encrypted in object storage and downloaded via a short-lived, user-bound signed URL.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deps } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { hmac, safeEqual } from '../../lib/crypto';
import { meetingVisibleSql, tenantTx } from '../../rbac/access';
import { permanentError, type JobRow } from '../../jobs/queue';
import { loadCatalog, qi, type Catalog, type TableInfo } from './catalog';
import { APP_VERSION } from './meetingExport';

export const WORKSPACE_EXPORT_FORMAT = 'meetledger.workspace-export/v1';

/** Never exported / imported (identity, secrets, caches, derived indexes, queues). */
export const NEVER_EXPORT = new Set([
  'schema_migrations',
  'organizations',
  'users',
  'org_members',
  'sessions',
  'workspaces',
  'invitations',
  'api_tokens',
  'user_prefs',
  'notifications',
  'email_outbox',
  'search_docs',
  'ai_chunks',
  'brief_snapshots',
  'jobs',
  'connector_accounts',
  'connector_oauth_states',
  'connector_events',
  'webhooks',
  'webhook_deliveries',
  'mcp_confirmations',
]);

/** Exported as records for the customer, but never imported (membership, audit trails, external-write log). */
export const EXPORT_ONLY = new Set(['workspace_members', 'audit_events', 'external_calls', 'external_write_requests', 'deletion_requests']);

/** Identity / tenant roots: references to these are remapped explicitly, never exported as tables. */
export const ROOT_TABLES = new Set(['organizations', 'users', 'workspaces']);

export const SECRET_COLUMN = /(^|_)(token|secret|secrets|password|ciphertext|verifier|credentials?)(_|$)/i;

export interface ScopedTable {
  name: string;
  info: TableInfo;
  /** SQL predicate with alias placeholder resolved; params: $1 workspace id, $2 visible meeting ids (uuid[]). */
  where: (alias: string) => string;
}

/**
 * Determines which tables belong to a workspace export and how to filter them, from the live catalog
 * (tables added by later migrations are picked up automatically).
 */
export function exportScope(cat: Catalog): ScopedTable[] {
  const memo = new Map<string, ((alias: string) => string) | null>();
  const visiting = new Set<string>();
  const scopeOf = (t: string, depth = 0): ((alias: string) => string) | null => {
    if (memo.has(t)) return memo.get(t)!;
    if (NEVER_EXPORT.has(t) || ROOT_TABLES.has(t) || visiting.has(t) || depth > 4) return null;
    const info = cat.get(t);
    if (!info) return null;
    visiting.add(t);
    let res: ((alias: string) => string) | null = null;
    // A NOT NULL reference to an excluded (non-root) table excludes the table as well (e.g. connector caches).
    const blocked = [...info.fks].some(([c, ref]) => !info.columns.get(c)!.nullable && !ROOT_TABLES.has(ref) && (NEVER_EXPORT.has(ref) || !cat.has(ref)));
    const has = (c: string) => info.columns.has(c);
    if (blocked) res = null;
    else if (t === 'meetings') res = (a) => `${a}.id = ANY($2::uuid[])`;
    else if (has('meeting_id') && has('workspace_id')) res = (a) => `(${a}.meeting_id = ANY($2::uuid[]) OR (${a}.meeting_id IS NULL AND ${a}.workspace_id = $1))`;
    else if (has('workspace_id')) res = (a) => `${a}.workspace_id = $1`;
    else if (has('meeting_id')) res = (a) => `${a}.meeting_id = ANY($2::uuid[])`;
    else {
      for (const [col, ref] of [...info.fks].sort()) {
        if (info.columns.get(col)!.nullable || ROOT_TABLES.has(ref) || ref === t) continue;
        const parent = scopeOf(ref, depth + 1);
        if (!parent || !cat.get(ref)!.hasId) continue;
        const pa = `p${depth}`;
        res = (a) => `${a}.${qi(col)} IN (SELECT ${pa}.id FROM ${qi(ref)} ${pa} WHERE ${parent(pa)})`;
        break;
      }
    }
    visiting.delete(t);
    memo.set(t, res);
    return res;
  };
  const out: ScopedTable[] = [];
  for (const name of [...cat.keys()].sort()) {
    const w = scopeOf(name);
    if (w) out.push({ name, info: cat.get(name)!, where: w });
  }
  return out;
}

/** Meetings of the workspace the user can see (meeting ACL; private meetings of others excluded). */
export async function visibleMeetingIds(db: Db, workspaceId: string, userId: string): Promise<{ visible: string[]; hidden: number }> {
  const vis = await rows<{ id: string }>(db, `SELECT m.id FROM meetings m WHERE m.workspace_id=$1 AND ${meetingVisibleSql('m', '$2')}`, [workspaceId, userId]);
  const all = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM meetings WHERE workspace_id=$1 AND deleted_at IS NULL', [workspaceId]);
  return { visible: vis.map((r) => r.id), hidden: all!.n - vis.length };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class JsonFileWriter {
  private out;
  private hash = createHash('sha256');
  size = 0;
  constructor(path: string) {
    this.out = createWriteStream(path, { encoding: 'utf8' });
  }
  async write(s: string) {
    const buf = Buffer.from(s, 'utf8');
    this.hash.update(buf);
    this.size += buf.length;
    if (!this.out.write(buf)) await new Promise<void>((r) => this.out.once('drain', () => r()));
  }
  async close() {
    await new Promise<void>((res, rej) => this.out.end((e?: Error | null) => (e ? rej(e) : res())));
    return this.hash.digest('hex');
  }
}

export interface ExportJobPayload {
  workspaceId: string;
  userId: string;
  includeMedia?: boolean;
}

async function assertStillAdmin(db: Db, orgId: string, workspaceId: string, userId: string) {
  const r = await one<{ ws_role: string | null; org_role: string | null }>(
    db,
    `SELECT (SELECT role FROM workspace_members WHERE workspace_id=$2 AND user_id=$3) AS ws_role,
            (SELECT role FROM org_members WHERE org_id=$1 AND user_id=$3) AS org_role`,
    [orgId, workspaceId, userId],
  );
  const ok = ['owner', 'admin'].includes(r?.org_role ?? '') || (r?.ws_role !== null && ['owner', 'admin'].includes(r?.ws_role ?? ''));
  if (!ok || !r?.ws_role) throw permanentError('requester is no longer an admin of the workspace');
}

/** Writes the export document to `filePath` (inside one tenant transaction = consistent snapshot of the rows). */
export async function writeWorkspaceExport(deps: Deps, db: Db, p: { orgId: string; workspaceId: string; userId: string; includeMedia: boolean; filePath: string }) {
  const cat = await loadCatalog(db);
  const scope = exportScope(cat);
  const ws = await one<any>(db, 'SELECT id, org_id, name, settings, is_sample, created_at FROM workspaces WHERE id=$1 AND org_id=$2', [p.workspaceId, p.orgId]);
  if (!ws) throw permanentError('workspace not found');
  const { visible, hidden } = await visibleMeetingIds(db, p.workspaceId, p.userId);
  const params = [p.workspaceId, visible];
  const migrations = (await rows<{ name: string }>(db, 'SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
  const requester = await one<{ id: string; name: string; email: string }>(db, 'SELECT id, name, email FROM users WHERE id=$1', [p.userId]);

  // Pass 1: ids of every exported row (used to drop references to rows outside the export).
  const idsOf = new Map<string, Set<string>>();
  for (const t of scope) {
    if (!t.info.hasId) continue;
    const r = await rows<{ id: string }>(db, `SELECT a.id FROM ${qi(t.name)} a WHERE ${t.where('a')}`, params);
    idsOf.set(t.name, new Set(r.map((x) => x.id)));
  }
  const allIds = new Set<string>();
  for (const s of idsOf.values()) for (const id of s) allIds.add(id);

  const w = new JsonFileWriter(p.filePath);
  const now = deps.clock.now();
  await w.write(
    `{"format":${JSON.stringify(WORKSPACE_EXPORT_FORMAT)},"version":1,"app":{"name":"MeetLedger","version":${JSON.stringify(APP_VERSION)}},` +
      `"generatedAt":${JSON.stringify(now.toISOString())},"generatedBy":${JSON.stringify(requester)},"schemaMigrations":${JSON.stringify(migrations)},` +
      `"source":${JSON.stringify({ orgId: p.orgId, workspaceId: ws.id, workspaceName: ws.name, isSample: ws.is_sample })},` +
      `"workspace":${JSON.stringify({ name: ws.name, settings: ws.settings })},` +
      `"scope":${JSON.stringify({ acl: 'meetings visible to the requesting user', excludedMeetings: hidden, includeMedia: p.includeMedia })},"tables":{`,
  );
  const counts: Record<string, number> = {};
  const omitted: Record<string, number> = {};
  const userRefs = new Set<string>();
  const mediaRows: any[] = [];
  let firstTable = true;
  for (const t of scope) {
    const secret = t.info.columnOrder.filter((c) => SECRET_COLUMN.test(c));
    const fkCols = [...t.info.fks].filter(([c]) => !secret.includes(c));
    const uuidCols = t.info.columnOrder.filter((c) => !secret.includes(c) && (t.info.columns.get(c)!.udt === 'uuid' || t.info.columns.get(c)!.udt === '_uuid'));
    await w.write(`${firstTable ? '' : ','}${JSON.stringify(t.name)}:[`);
    firstTable = false;
    let n = 0;
    let lastId: string | null = null;
    const order = t.info.hasId ? 'ORDER BY a.id' : '';
    for (;;) {
      const page: { j: any }[] = t.info.hasId
        ? await rows<{ j: any }>(db, `SELECT to_jsonb(a) AS j FROM ${qi(t.name)} a WHERE ${t.where('a')} AND ($3::uuid IS NULL OR a.id > $3) ${order} LIMIT 1000`, [...params, lastId])
        : await rows<{ j: any }>(db, `SELECT to_jsonb(a) AS j FROM ${qi(t.name)} a WHERE ${t.where('a')}`, params);
      for (const { j: row } of page) {
        for (const c of secret) delete row[c];
        let drop = false;
        for (const [col, ref] of fkCols) {
          const v = row[col];
          if (v == null) continue;
          if (ref === 'users') userRefs.add(v);
          else if (!ROOT_TABLES.has(ref) && !idsOf.get(ref)?.has(v)) {
            if (t.info.columns.get(col)!.nullable) row[col] = null;
            else drop = true;
          }
        }
        if (drop) {
          omitted[t.name] = (omitted[t.name] ?? 0) + 1;
          continue;
        }
        for (const c of uuidCols) {
          const v = row[c];
          if (Array.isArray(v)) for (const x of v) !allIds.has(x) && UUID_RE.test(String(x)) && userRefs.add(x);
          else if (typeof v === 'string' && !allIds.has(v) && !t.info.fks.has(c)) userRefs.add(v);
        }
        if (t.name === 'media_assets' && !row.deleted_at) mediaRows.push(row);
        await w.write(`${n ? ',' : ''}${JSON.stringify(row)}`);
        n++;
      }
      if (!t.info.hasId || page.length < 1000) break;
      lastId = page[page.length - 1].j?.id ?? null;
      if (!lastId) break;
    }
    await w.write(']');
    counts[t.name] = n;
  }
  await w.write('}');
  // Referenced users: id / name / email only.
  const users = userRefs.size ? await rows(db, 'SELECT id, name, email FROM users WHERE id = ANY($1::uuid[]) ORDER BY email', [[...userRefs].filter((x) => UUID_RE.test(x))]) : [];
  await w.write(`,"users":${JSON.stringify(users)},"counts":${JSON.stringify(counts)},"omitted":${JSON.stringify(omitted)},"media":[`);
  let mediaFiles = 0;
  if (p.includeMedia) {
    for (const m of mediaRows) {
      let stream;
      try {
        stream = await deps.storage.getStream(m.storage_key);
      } catch {
        continue; // object missing (already deleted by retention) — the row stays a tombstone on import
      }
      await w.write(`${mediaFiles ? ',' : ''}{"assetId":${JSON.stringify(m.id)},"mime":${JSON.stringify(m.mime)},"data":"`);
      const h = createHash('sha256');
      let rem = Buffer.alloc(0);
      let size = 0;
      for await (const chunk of stream) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        h.update(b);
        size += b.length;
        const buf = rem.length ? Buffer.concat([rem, b]) : b;
        const cut = buf.length - (buf.length % 3);
        await w.write(buf.subarray(0, cut).toString('base64'));
        rem = Buffer.from(buf.subarray(cut));
      }
      await w.write(`${rem.toString('base64')}","size":${size},"sha256":"${h.digest('hex')}"}`);
      mediaFiles++;
    }
  }
  await w.write(']}');
  const sha256 = await w.close();
  return { counts, omitted, users: users.length, mediaFiles, size: w.size, sha256, excludedMeetings: hidden };
}

/** Job handler for `export.full`. */
export async function runExportJob(deps: Deps, job: JobRow) {
  const p = job.payload as ExportJobPayload;
  if (!job.org_id || !UUID_RE.test(p?.workspaceId ?? '') || !UUID_RE.test(p?.userId ?? '')) throw permanentError('invalid export job payload');
  await mkdir(deps.config.TMP_DIR, { recursive: true });
  const tmp = join(deps.config.TMP_DIR, `export-${job.id}.json`);
  try {
    const r = await tenantTx(deps, job.org_id, async (db) => {
      await assertStillAdmin(db, job.org_id!, p.workspaceId, p.userId);
      return writeWorkspaceExport(deps, db, { orgId: job.org_id!, workspaceId: p.workspaceId, userId: p.userId, includeMedia: !!p.includeMedia, filePath: tmp });
    });
    const storageKey = `org/${job.org_id}/exports/${job.id}.json`;
    await deps.storage.putFile(storageKey, tmp);
    await tenantTx(deps, job.org_id, (db) =>
      audit(db, { orgId: job.org_id!, workspaceId: p.workspaceId, userId: p.userId, action: 'workspace.exported', meta: { jobId: job.id, size: r.size, mediaFiles: r.mediaFiles } }),
    );
    return { storageKey, size: r.size, sha256: r.sha256, counts: r.counts, omitted: r.omitted, mediaFiles: r.mediaFiles, excludedMeetings: r.excludedMeetings, includeMedia: !!p.includeMedia };
  } finally {
    await rm(tmp, { force: true });
  }
}

// ------------------------------------------------------------------ signed download URL (HMAC, user-bound, short-lived)

const sigInput = (workspaceId: string, jobId: string, userId: string, exp: number) => `export-full:${workspaceId}:${jobId}:${userId}:${exp}`;

export function signExportUrl(deps: Deps, workspaceId: string, jobId: string, userId: string) {
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + deps.config.SIGNED_URL_TTL_SEC;
  const sig = hmac(deps.config.SESSION_SECRET, sigInput(workspaceId, jobId, userId, exp));
  return { url: `/api/w/${workspaceId}/export/full/${jobId}/download?u=${userId}&exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyExportSignature(deps: Deps, workspaceId: string, jobId: string, userId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < deps.clock.now().getTime()) return false;
  return safeEqual(hmac(deps.config.SESSION_SECRET, sigInput(workspaceId, jobId, userId, exp)), sig);
}
