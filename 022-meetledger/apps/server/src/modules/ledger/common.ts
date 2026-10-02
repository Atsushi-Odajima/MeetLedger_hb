// Shared helpers of the ledger module (decisions, actions, commitments, open questions).
import { dateInTz, type LedgerEntityType } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { isUuid, itemVisibleSql } from '../../rbac/access';
import { norm } from '../../providers/ai/text';

export type LedgerType = LedgerEntityType;
export const LEDGER_TYPES: LedgerType[] = ['decision', 'action', 'commitment', 'question'];

/** Fixed whitelist: type -> table (never built from user input). */
export const TABLE: Record<LedgerType, string> = {
  decision: 'decisions',
  action: 'actions',
  commitment: 'commitments',
  question: 'open_questions',
};
/** Column holding the item's main text. */
export const TEXT_COL: Record<LedgerType, string> = { decision: 'text', action: 'description', commitment: 'description', question: 'question' };

/**
 * Who is asking. Reusable by other modules (followup, dashboard, MCP, export) that want ledger DTOs:
 * build it with `scopeOf(ctx)` or by hand for jobs (userId = the recipient whose ACL applies).
 */
export interface LedgerScope {
  orgId: string;
  workspaceId: string;
  userId: string;
  /** IANA timezone used for "today" (overdue derivation). */
  timezone: string;
  locale: 'ja' | 'en';
  now: Date;
}

export function scopeOf(ctx: WsCtx): LedgerScope {
  return {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    timezone: ctx.user.timezone || 'Asia/Tokyo',
    locale: ctx.user.locale === 'en' ? 'en' : 'ja',
    now: ctx.deps.clock.now(),
  };
}

export function todayOf(scope: LedgerScope): string {
  try {
    return dateInTz(scope.now, scope.timezone);
  } catch {
    return dateInTz(scope.now, 'Asia/Tokyo');
  }
}

/** Candidate state per type. */
export function isCandidate(type: LedgerType, row: any): boolean {
  return type === 'decision' ? row.review_state === 'candidate' : row.status === 'candidate';
}

/** Normalized topic key used to match decisions about the same subject. */
export function topicKeyOf(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const k = norm(topic).replace(/(について|の件)$/u, '');
  return k ? k.slice(0, 100) : null;
}

export async function ledgerEvent(
  db: Db,
  e: { orgId: string; workspaceId: string; type: LedgerType | 'contradiction'; id: string; event: string; byUserId?: string | null; diff?: Record<string, unknown> },
) {
  await db.query('INSERT INTO ledger_events(org_id, workspace_id, entity_type, entity_id, event, by_user_id, diff) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    e.orgId,
    e.workspaceId,
    e.type,
    e.id,
    e.event,
    e.byUserId ?? null,
    e.diff ?? {},
  ]);
}

/** Meeting info columns joined into every ledger row (for SourceRef). */
export const MEETING_JOIN = (alias: string) =>
  `LEFT JOIN meetings lm ON lm.id = ${alias}.meeting_id`;
export const MEETING_COLS = `lm.title AS meeting_title, coalesce(lm.scheduled_start, lm.started_at, lm.created_at) AS meeting_date`;

/** Loads one ledger item visible to the scope's user (404 otherwise). `forUpdate` locks the row. */
export async function loadItem(db: Db, scope: LedgerScope, type: LedgerType, id: string, forUpdate = false): Promise<any> {
  if (!isUuid(id)) throw notFound('Item not found');
  const row = await one(
    db,
    `SELECT x.*, ${MEETING_COLS} FROM ${TABLE[type]} x ${MEETING_JOIN('x')}
      WHERE x.id = $1 AND x.workspace_id = $2 AND ${itemVisibleSql('x', '$3')}${forUpdate ? ' FOR UPDATE OF x' : ''}`,
    [id, scope.workspaceId, scope.userId],
  );
  if (!row) throw notFound('Item not found');
  return row;
}

/** People records of this workspace linked to the scope's user ("me"). */
export async function myPersonIds(db: Db, scope: Pick<LedgerScope, 'workspaceId' | 'userId'>): Promise<string[]> {
  const r = await rows<{ id: string }>(db, 'SELECT id FROM people WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL', [scope.workspaceId, scope.userId]);
  return r.map((x) => x.id);
}

/** Small parameterized WHERE builder. `?` placeholders become $n. */
export class Where {
  parts: string[] = [];
  constructor(public params: unknown[] = []) {}
  add(sql: string, ...vals: unknown[]) {
    let s = sql;
    for (const v of vals) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.parts.push(s);
    return this;
  }
  /** Adds a param and returns its placeholder. */
  p(v: unknown) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  sql() {
    return this.parts.length ? this.parts.join(' AND ') : 'TRUE';
  }
}

export async function assertPerson(db: Db, workspaceId: string, personId: string | null | undefined) {
  if (!personId) return;
  const p = await one(db, 'SELECT 1 FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [personId, workspaceId]);
  if (!p) throw notFound('Person not found');
}
export async function assertMember(db: Db, workspaceId: string, userId: string | null | undefined) {
  if (!userId) return;
  const u = await one(db, 'SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
  if (!u) throw notFound('User not found');
}
export async function assertProject(db: Db, workspaceId: string, projectId: string | null | undefined) {
  if (!projectId) return;
  const p = await one(db, 'SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2', [projectId, workspaceId]);
  if (!p) throw notFound('Project not found');
}
export async function assertSeries(db: Db, workspaceId: string, seriesId: string | null | undefined) {
  if (!seriesId) return;
  const p = await one(db, 'SELECT 1 FROM series WHERE id=$1 AND workspace_id=$2', [seriesId, workspaceId]);
  if (!p) throw notFound('Series not found');
}

export const INSUFFICIENT_JA = '記録からは分かりません';
export const INSUFFICIENT_EN = 'The record does not say.';
