// Ledger write operations. Every change writes a ledger_events row. Callers must have checked the write role (member+).
// Exported for reuse (MCP write tools after their confirmation step, follow-up flows).
import { z } from 'zod';
import { one, rows, type Db } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { zDate, zIso, zUuid } from '../../lib/http';
import { isUuid, meetingVisibleSql } from '../../rbac/access';
import { isValidYmd } from '../../providers/ai/dueDate';
import {
  TABLE,
  assertMember,
  assertPerson,
  assertProject,
  assertSeries,
  isCandidate,
  ledgerEvent,
  loadItem,
  topicKeyOf,
  type LedgerScope,
  type LedgerType,
} from './common';
import { detectContradictions } from './extract';

// ---------------------------------------------------------------- edit schemas (strict: unknown keys such as "status" are rejected)
const text = (max: number) => z.string().trim().min(1).max(max);
const ntext = (max: number) => z.string().trim().max(max).nullable();

export const EDIT_SCHEMAS = {
  decision: z
    .object({
      text: text(2000),
      topic: ntext(200),
      reason: ntext(2000),
      ownerPersonId: zUuid.nullable(),
      projectId: zUuid.nullable(),
      seriesId: zUuid.nullable(),
      participantPersonIds: z.array(zUuid).max(100),
    })
    .partial()
    .strict(),
  action: z
    .object({
      description: text(2000),
      assigneePersonId: zUuid.nullable(),
      assigneeUserId: zUuid.nullable(),
      assigneeText: ntext(200),
      dueDate: zDate.nullable(),
      dueText: ntext(100),
      projectId: zUuid.nullable(),
      linkedDecisionId: zUuid.nullable(),
    })
    .partial()
    .strict(),
  commitment: z
    .object({
      description: text(2000),
      promisedByPersonId: zUuid.nullable(),
      promisedByUserId: zUuid.nullable(),
      promisedByText: ntext(200),
      promisedToPersonId: zUuid.nullable(),
      promisedToUserId: zUuid.nullable(),
      promisedToText: ntext(200),
      dueDate: zDate.nullable(),
      dueText: ntext(100),
      projectId: zUuid.nullable(),
    })
    .partial()
    .strict(),
  question: z
    .object({
      question: text(2000),
      ownerPersonId: zUuid.nullable(),
      dueDate: zDate.nullable(),
      projectId: zUuid.nullable(),
      answerText: ntext(4000),
    })
    .partial()
    .strict(),
} as const;
export type Edits = Record<string, unknown>;

/** Whitelisted field -> column mapping (dynamic SQL columns only come from here). */
const COLS: Record<LedgerType, Record<string, string>> = {
  decision: { text: 'text', topic: 'topic', reason: 'reason', ownerPersonId: 'owner_person_id', projectId: 'project_id', seriesId: 'series_id', participantPersonIds: 'participant_person_ids' },
  action: {
    description: 'description',
    assigneePersonId: 'assignee_person_id',
    assigneeUserId: 'assignee_user_id',
    assigneeText: 'assignee_text',
    dueDate: 'due_date',
    dueText: 'due_text',
    projectId: 'project_id',
    linkedDecisionId: 'linked_decision_id',
  },
  commitment: {
    description: 'description',
    promisedByPersonId: 'promised_by_person_id',
    promisedByUserId: 'promised_by_user_id',
    promisedByText: 'promised_by_text',
    promisedToPersonId: 'promised_to_person_id',
    promisedToUserId: 'promised_to_user_id',
    promisedToText: 'promised_to_text',
    dueDate: 'due_date',
    dueText: 'due_text',
    projectId: 'project_id',
  },
  question: { question: 'question', ownerPersonId: 'owner_person_id', dueDate: 'due_date', projectId: 'project_id', answerText: 'answer_text' },
};

const ASSIGNEE_KEYS = ['assigneePersonId', 'assigneeUserId', 'assigneeText'];
const PROMISER_KEYS = ['promisedByPersonId', 'promisedByUserId', 'promisedByText'];
const PROMISEE_KEYS = ['promisedToPersonId', 'promisedToUserId', 'promisedToText'];
const has = (e: Edits, keys: string[]) => keys.some((k) => k in e);

async function personInfo(db: Db, workspaceId: string, personId: string) {
  return one<{ id: string; name: string; user_id: string | null }>(db, 'SELECT id, name, user_id FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [
    personId,
    workspaceId,
  ]);
}
async function personOfUser(db: Db, workspaceId: string, userId: string) {
  return one<{ id: string; name: string }>(db, 'SELECT id, name FROM people WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1', [workspaceId, userId]);
}
async function userName(db: Db, userId: string) {
  return (await one<{ name: string }>(db, 'SELECT name FROM users WHERE id=$1', [userId]))?.name ?? null;
}

/** Completes a party edit (person <-> user <-> display text) so the three columns stay consistent. */
async function completeParty(db: Db, scope: LedgerScope, e: Edits, keys: [string, string, string]) {
  const [pk, uk, tk] = keys;
  if (e[pk] !== undefined && e[pk] !== null) {
    const p = await personInfo(db, scope.workspaceId, e[pk] as string);
    if (!p) throw notFound('Person not found');
    if (e[uk] === undefined) e[uk] = p.user_id;
    if (e[tk] === undefined) e[tk] = p.name;
  }
  if (e[uk] !== undefined && e[uk] !== null) {
    await assertMember(db, scope.workspaceId, e[uk] as string);
    if (e[pk] === undefined) e[pk] = (await personOfUser(db, scope.workspaceId, e[uk] as string))?.id ?? null;
    if (e[tk] === undefined) e[tk] = await userName(db, e[uk] as string);
  }
  if (e[pk] === null && e[uk] === undefined) e[uk] = null;
  if (e[uk] === null && e[pk] === undefined) e[pk] = null;
  // Clearing the person/user without new text means "unassigned": do not keep a stale name.
  if (e[pk] === null && e[uk] === null && e[tk] === undefined) e[tk] = null;
}

/** Ledger content changed: let the search module re-index the meeting (no-op for workspace-level items). */
export async function enqueueReindex(db: Db, jobs: { enqueue: (db: Db, j: any) => Promise<unknown> }, orgId: string, meetingIds: (string | null | undefined)[]) {
  for (const id of new Set(meetingIds.filter((x): x is string => !!x))) {
    await jobs.enqueue(db, { orgId, type: 'index.meeting', key: `index:${id}:${Date.now()}`, payload: { meetingId: id } });
  }
}

/** Applies validated edits to a row. Returns the updated row (re-loaded with meeting info) and a diff. */
export async function applyEdits(db: Db, scope: LedgerScope, type: LedgerType, row: any, rawEdits: Edits): Promise<{ row: any; diff: Record<string, { from: unknown; to: unknown }> }> {
  const e: Edits = { ...rawEdits };
  if (!Object.keys(e).length) return { row, diff: {} };
  const extra: Record<string, unknown> = {};
  if (type === 'decision') {
    await assertPerson(db, scope.workspaceId, e.ownerPersonId as string);
    await assertProject(db, scope.workspaceId, e.projectId as string);
    await assertSeries(db, scope.workspaceId, e.seriesId as string);
    for (const p of (e.participantPersonIds as string[] | undefined) ?? []) await assertPerson(db, scope.workspaceId, p);
    if ('topic' in e) extra.topic_key = topicKeyOf(e.topic as string | null);
  }
  if (type === 'action') {
    if (has(e, ASSIGNEE_KEYS)) {
      await completeParty(db, scope, e, ['assigneePersonId', 'assigneeUserId', 'assigneeText']);
      extra.assignee_inferred = false;
      extra.assignee_speaker_id = null;
    }
    await assertProject(db, scope.workspaceId, e.projectId as string);
    if (e.linkedDecisionId) await loadItem(db, scope, 'decision', e.linkedDecisionId as string);
  }
  if (type === 'commitment') {
    if (has(e, PROMISER_KEYS)) {
      await completeParty(db, scope, e, ['promisedByPersonId', 'promisedByUserId', 'promisedByText']);
      extra.promised_by_speaker_id = null;
    }
    if (has(e, PROMISEE_KEYS)) await completeParty(db, scope, e, ['promisedToPersonId', 'promisedToUserId', 'promisedToText']);
    await assertProject(db, scope.workspaceId, e.projectId as string);
  }
  if (type === 'question') {
    await assertPerson(db, scope.workspaceId, e.ownerPersonId as string);
    await assertProject(db, scope.workspaceId, e.projectId as string);
  }
  if ((type === 'action' || type === 'commitment') && 'dueDate' in e) {
    if (e.dueDate !== null && !isValidYmd(e.dueDate)) throw badRequest('Invalid dueDate');
    extra.due_inferred = false;
    if (!('dueText' in e)) e.dueText = null;
  }
  const cols = COLS[type];
  const sets: string[] = [];
  const vals: unknown[] = [];
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(e)) {
    const col = cols[k];
    if (!col) continue;
    vals.push(v);
    sets.push(`${col} = $${vals.length + 1}`);
    if (JSON.stringify(row[col] ?? null) !== JSON.stringify(v ?? null)) diff[k] = { from: row[col] ?? null, to: v ?? null };
  }
  for (const [col, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${col} = $${vals.length + 1}`);
  }
  if (!sets.length) return { row, diff: {} };
  await db.query(`UPDATE ${TABLE[type]} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [row.id, ...vals]);
  return { row: await loadItem(db, scope, type, row.id), diff };
}

// ---------------------------------------------------------------- review: edit / accept / reject
export async function editCandidate(db: Db, scope: LedgerScope, type: LedgerType, id: string, edits: Edits) {
  const row = await loadItem(db, scope, type, id, true);
  if (!isCandidate(type, row)) throw conflict('Only candidates can be edited in the Review Inbox', { code: 'not_candidate' });
  const r = await applyEdits(db, scope, type, row, edits);
  if (Object.keys(r.diff).length) await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type, id, event: 'edited', byUserId: scope.userId, diff: r.diff });
  return r.row;
}

/** Fields of the row that still carry an AI-inferred value not covered by the edits. */
export function pendingInferred(type: LedgerType, row: any, edits: Edits): string[] {
  const out: string[] = [];
  if (type === 'action' && row.assignee_inferred && !has(edits, ASSIGNEE_KEYS)) out.push('assignee');
  if ((type === 'action' || type === 'commitment') && row.due_inferred && !('dueDate' in edits)) out.push('due');
  return out;
}

export async function acceptItem(db: Db, scope: LedgerScope, type: LedgerType, id: string, opts: { edits?: Edits; confirmInferred?: boolean } = {}) {
  const edits = opts.edits ?? {};
  let row = await loadItem(db, scope, type, id, true);
  if (!isCandidate(type, row)) throw conflict('Item is not a candidate', { code: 'not_candidate' });
  const pending = pendingInferred(type, row, edits);
  if (pending.length && !opts.confirmInferred) {
    throw badRequest('AIが推測した担当/期限があります。confirmInferred:true で確認するか、値を編集してください', { code: 'confirm_inferred_required', fields: pending });
  }
  const r = await applyEdits(db, scope, type, row, edits);
  row = r.row;
  const by = scope.userId;
  if (type === 'decision') {
    await db.query("UPDATE decisions SET review_state='confirmed', confirmed_by=$2, confirmed_at=now(), updated_at=now() WHERE id=$1", [id, by]);
  } else if (type === 'action') {
    await db.query("UPDATE actions SET status='confirmed', assignee_inferred=false, due_inferred=false, confirmed_by=$2, confirmed_at=now(), updated_at=now() WHERE id=$1", [id, by]);
  } else if (type === 'commitment') {
    await db.query("UPDATE commitments SET status='open', due_inferred=false, confirmed_by=$2, confirmed_at=now(), updated_at=now() WHERE id=$1", [id, by]);
  } else {
    await db.query("UPDATE open_questions SET status='open', confirmed_by=$2, confirmed_at=now(), updated_at=now() WHERE id=$1", [id, by]);
  }
  await ledgerEvent(db, {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    type,
    id,
    event: 'accepted',
    byUserId: by,
    diff: { ...(Object.keys(r.diff).length ? { edits: r.diff } : {}), ...(pending.length ? { confirmedInferred: pending } : {}) },
  });
  return loadItem(db, scope, type, id);
}

export async function rejectItem(db: Db, scope: LedgerScope, type: LedgerType, id: string, reason?: string | null) {
  const row = await loadItem(db, scope, type, id, true);
  if (!isCandidate(type, row)) throw conflict('Item is not a candidate', { code: 'not_candidate' });
  if (type === 'decision') {
    await db.query("UPDATE decisions SET review_state='rejected', updated_at=now() WHERE id=$1", [id]);
    // Contradictions raised by a rejected candidate are moot.
    const closed = await rows<{ id: string }>(
      db,
      "UPDATE contradiction_candidates SET status='dismissed', resolved_by=$2, resolved_at=now() WHERE new_decision_id=$1 AND status='open' RETURNING id",
      [id, scope.userId],
    );
    for (const c of closed) await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'contradiction', id: c.id, event: 'dismissed', byUserId: scope.userId, diff: { cause: 'decision_rejected' } });
  } else {
    await db.query(`UPDATE ${TABLE[type]} SET status='rejected', updated_at=now() WHERE id=$1`, [id]);
  }
  await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type, id, event: 'rejected', byUserId: scope.userId, diff: reason ? { reason } : {} });
  return loadItem(db, scope, type, id);
}

// ---------------------------------------------------------------- decisions: create / supersede
export const createDecisionSchema = z.object({
  text: text(2000),
  topic: ntext(200).optional(),
  reason: ntext(2000).optional(),
  meetingId: zUuid.nullable().optional(),
  projectId: zUuid.nullable().optional(),
  seriesId: zUuid.nullable().optional(),
  ownerPersonId: zUuid.nullable().optional(),
  decidedAt: zIso.nullable().optional(),
  participantPersonIds: z.array(zUuid).max(100).optional(),
  /** Optional evidence: segments of the meeting's current transcript. */
  segmentIds: z.array(zUuid).max(20).optional(),
  supersedesDecisionId: zUuid.optional(),
});
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;

async function visibleMeeting(db: Db, scope: LedgerScope, meetingId: string) {
  const m = await one<any>(db, `SELECT m.* FROM meetings m WHERE m.id=$1 AND m.workspace_id=$2 AND ${meetingVisibleSql('m', '$3')}`, [meetingId, scope.workspaceId, scope.userId]);
  if (!m) throw notFound('Meeting not found');
  return m;
}

/** Manual decision = confirmed immediately (a human states it). Optional evidence from the current transcript. */
export async function createDecision(db: Db, scope: LedgerScope, input: CreateDecisionInput) {
  const m = input.meetingId ? await visibleMeeting(db, scope, input.meetingId) : null;
  const projectId = input.projectId !== undefined ? input.projectId : (m?.project_id ?? null);
  const seriesId = input.seriesId !== undefined ? input.seriesId : (m?.series_id ?? null);
  await assertProject(db, scope.workspaceId, projectId);
  await assertSeries(db, scope.workspaceId, seriesId);
  await assertPerson(db, scope.workspaceId, input.ownerPersonId);
  for (const p of input.participantPersonIds ?? []) await assertPerson(db, scope.workspaceId, p);
  let src = { ids: [] as string[], start: null as number | null, end: null as number | null, quote: null as string | null, transcriptId: null as string | null, revisions: {} as Record<string, number> };
  if (input.segmentIds?.length) {
    if (!m) throw badRequest('segmentIds require meetingId');
    const segs = await rows<any>(
      db,
      `SELECT s.id, s.start_ms, s.end_ms, s.text, s.revision, s.transcript_id FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id AND t.is_current
        WHERE s.meeting_id=$1 AND s.id = ANY($2) ORDER BY s.seq`,
      [m.id, input.segmentIds],
    );
    if (segs.length !== new Set(input.segmentIds).size) throw badRequest('Unknown segmentIds');
    src = {
      ids: segs.map((s) => s.id),
      start: Math.min(...segs.map((s) => s.start_ms)),
      end: Math.max(...segs.map((s) => s.end_ms)),
      quote: segs.map((s) => s.text).join(' ').slice(0, 500),
      transcriptId: segs[0].transcript_id,
      revisions: Object.fromEntries(segs.map((s) => [s.id, s.revision])),
    };
  }
  const participants = input.participantPersonIds ?? (m ? (await rows<{ person_id: string }>(db, 'SELECT person_id FROM participants WHERE meeting_id=$1 AND person_id IS NOT NULL', [m.id])).map((r) => r.person_id) : []);
  const d = await one<any>(
    db,
    `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, topic_key, decided_at, owner_person_id, reason, participant_person_ids,
                           review_state, status, source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions,
                           extracted_by, created_by, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, $10::timestamptz),$11,$12,$13,'confirmed','active',$14,$15,$16,$17,$18,$19,'user',$20,$20,now()) RETURNING id`,
    [
      scope.orgId,
      scope.workspaceId,
      m?.id ?? null,
      projectId,
      seriesId,
      input.text,
      input.topic ?? null,
      topicKeyOf(input.topic ?? null),
      input.decidedAt ?? null,
      m ? (m.scheduled_start ?? m.started_at ?? m.created_at) : scope.now,
      input.ownerPersonId ?? null,
      input.reason ?? null,
      participants,
      src.ids,
      src.start,
      src.end,
      src.quote,
      src.transcriptId,
      src.revisions,
      scope.userId,
    ],
  );
  await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'decision', id: d!.id, event: 'created', byUserId: scope.userId, diff: { manual: true } });
  if (input.supersedesDecisionId) {
    await supersedeDecision(db, scope, input.supersedesDecisionId, { newDecisionId: d!.id });
  } else {
    const created = await one<any>(db, 'SELECT * FROM decisions WHERE id=$1', [d!.id]);
    await detectContradictions(db, scope.orgId, scope.workspaceId, { id: m?.id ?? null, project_id: projectId, series_id: seriesId }, [created]);
  }
  return loadItem(db, scope, 'decision', d!.id);
}

/** Links old -> new (old is kept, marked superseded; new confirmed & active). Never deletes. */
async function linkSupersede(db: Db, scope: LedgerScope, old: any, nu: any, cause: string) {
  if (old.id === nu.id) throw badRequest('A decision cannot supersede itself');
  if (old.review_state !== 'confirmed' || old.status !== 'active') throw conflict('Only a confirmed, currently active decision can be superseded', { code: 'not_active' });
  if (nu.review_state === 'rejected' || nu.status !== 'active') throw conflict('The new decision is not active', { code: 'new_not_active' });
  if (nu.supersedes_decision_id && nu.supersedes_decision_id !== old.id) throw conflict('The new decision already supersedes another decision');
  await db.query(
    `UPDATE decisions SET supersedes_decision_id=$2, review_state='confirmed', confirmed_by=coalesce(confirmed_by, $3), confirmed_at=coalesce(confirmed_at, now()),
            topic=coalesce(topic, $4), topic_key=coalesce(topic_key, $5), updated_at=now() WHERE id=$1`,
    [nu.id, old.id, scope.userId, old.topic, old.topic_key],
  );
  await db.query("UPDATE decisions SET status='superseded', superseded_by_decision_id=$2, updated_at=now() WHERE id=$1", [old.id, nu.id]);
  if (nu.review_state === 'candidate') await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'decision', id: nu.id, event: 'accepted', byUserId: scope.userId, diff: { cause } });
  await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'decision', id: old.id, event: 'superseded', byUserId: scope.userId, diff: { supersededBy: nu.id, cause } });
  await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'decision', id: nu.id, event: 'supersedes', byUserId: scope.userId, diff: { supersedes: old.id, cause } });
}

export type SupersedeInput = { newDecisionId: string } | { text: string; topic?: string | null; reason?: string | null };

export async function supersedeDecision(db: Db, scope: LedgerScope, oldId: string, input: SupersedeInput) {
  const old = await loadItem(db, scope, 'decision', oldId, true);
  let nu: any;
  if ('newDecisionId' in input) {
    nu = await loadItem(db, scope, 'decision', input.newDecisionId, true);
  } else {
    const d = await one<any>(
      db,
      `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, topic_key, decided_at, owner_person_id, reason,
                             review_state, status, extracted_by, created_by, confirmed_by, confirmed_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed','active','user',$11,$11,now()) RETURNING id`,
      [
        scope.orgId,
        scope.workspaceId,
        old.project_id,
        old.series_id,
        input.text,
        input.topic ?? old.topic,
        topicKeyOf(input.topic ?? old.topic),
        scope.now,
        old.owner_person_id,
        input.reason ?? null,
        scope.userId,
      ],
    );
    await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'decision', id: d!.id, event: 'created', byUserId: scope.userId, diff: { manual: true } });
    nu = await loadItem(db, scope, 'decision', d!.id, true);
  }
  await linkSupersede(db, scope, old, nu, 'supersede');
  // Any open contradiction between exactly these two is answered by this change.
  await db.query(
    "UPDATE contradiction_candidates SET status='confirmed_change', resolved_by=$3, resolved_at=now() WHERE existing_decision_id=$1 AND new_decision_id=$2 AND status='open'",
    [old.id, nu.id, scope.userId],
  );
  return { old: await loadItem(db, scope, 'decision', old.id), new: await loadItem(db, scope, 'decision', nu.id) };
}

// ---------------------------------------------------------------- contradictions
export async function resolveContradiction(db: Db, scope: LedgerScope, id: string, resolution: 'change' | 'not_change' | 'dismiss') {
  if (!isUuid(id)) throw notFound('Contradiction not found');
  const c = await one<any>(
    db,
    `SELECT c.* FROM contradiction_candidates c WHERE c.id=$1 AND c.workspace_id=$2 FOR UPDATE`,
    [id, scope.workspaceId],
  );
  if (!c) throw notFound('Contradiction not found');
  // Both decisions must be visible (404 otherwise, never reveal existence).
  const old = await loadItem(db, scope, 'decision', c.existing_decision_id, true).catch(() => null);
  const nu = await loadItem(db, scope, 'decision', c.new_decision_id, true).catch(() => null);
  if (!old || !nu) throw notFound('Contradiction not found');
  if (c.status !== 'open') throw conflict('Contradiction is already resolved', { code: 'already_resolved', status: c.status });
  let status: string;
  if (resolution === 'change') {
    await linkSupersede(db, scope, old, nu, 'contradiction');
    status = 'confirmed_change';
  } else status = resolution === 'not_change' ? 'not_change' : 'dismissed';
  await db.query('UPDATE contradiction_candidates SET status=$2, resolved_by=$3, resolved_at=now() WHERE id=$1', [id, status, scope.userId]);
  await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type: 'contradiction', id, event: 'resolved', byUserId: scope.userId, diff: { resolution, existing: old.id, new: nu.id } });
  return status;
}

// ---------------------------------------------------------------- status changes of confirmed items
const STATUS_RULES: Record<Exclude<LedgerType, 'decision'>, { allowed: string[]; doneCol?: string; done?: string }> = {
  action: { allowed: ['confirmed', 'in_progress', 'done', 'cancelled'], doneCol: 'completed_at', done: 'done' },
  commitment: { allowed: ['open', 'done', 'cancelled'], doneCol: 'completed_at', done: 'done' },
  question: { allowed: ['open', 'answered', 'dropped'] },
};

/** Status transitions for reviewed items. Candidates must go through the Review Inbox (accept/reject). */
export async function setItemStatus(db: Db, scope: LedgerScope, type: Exclude<LedgerType, 'decision'>, row: any, status: string) {
  const rule = STATUS_RULES[type];
  if (row.status === 'candidate' || row.status === 'rejected') throw conflict('Candidates are confirmed or rejected in the Review Inbox', { code: 'use_review' });
  if (!rule.allowed.includes(status)) throw badRequest(`Invalid status '${status}'`);
  if (row.status === status) return;
  const done = rule.doneCol ? `, ${rule.doneCol} = CASE WHEN $2 = '${rule.done}' THEN now() ELSE NULL END` : '';
  await db.query(`UPDATE ${TABLE[type]} SET status=$2${done}, updated_at=now() WHERE id=$1`, [row.id, status]);
  await ledgerEvent(db, { orgId: scope.orgId, workspaceId: scope.workspaceId, type, id: row.id, event: 'status_changed', byUserId: scope.userId, diff: { from: row.status, to: status } });
}
