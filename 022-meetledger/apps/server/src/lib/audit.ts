import type { Db } from '../db/pool';
import { safeMeta } from './logger';

/** Writes a metadata-only audit event (content fields are redacted). */
export async function audit(
  db: Db,
  e: { orgId: string; workspaceId?: string | null; userId?: string | null; action: string; entityType?: string; entityId?: string; meta?: Record<string, unknown>; ip?: string },
) {
  await db.query(
    'INSERT INTO audit_events(org_id, workspace_id, user_id, action, entity_type, entity_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [e.orgId, e.workspaceId ?? null, e.userId ?? null, e.action, e.entityType ?? null, e.entityId ?? null, safeMeta(e.meta) ?? {}, e.ip ?? null],
  );
}
