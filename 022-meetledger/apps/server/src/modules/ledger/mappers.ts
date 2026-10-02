// DB rows -> DTOs (packages/shared/src/api.ts). Exported for reuse by other modules (followup, data export, MCP).
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, QuestionDto, SourceRef, SummaryDto } from '@meetledger/shared';
import { rows, type Db } from '../../db/pool';
import { iso } from '../../lib/http';
import { isUuid } from '../../rbac/access';

export interface SegState {
  revision: number;
  isCurrent: boolean;
}
export type SegStates = Map<string, SegState>;

/** Loads current revision / transcript currency of every segment referenced by `items` (rows or summary sections). */
export async function loadSegStates(db: Db, items: { source_segment_ids?: string[] | null }[] | string[]): Promise<SegStates> {
  const ids = new Set<string>();
  for (const it of items as any[]) {
    if (typeof it === 'string') {
      if (isUuid(it)) ids.add(it);
    } else for (const id of it?.source_segment_ids ?? []) if (isUuid(id)) ids.add(id);
  }
  const out: SegStates = new Map();
  if (!ids.size) return out;
  const r = await rows<{ id: string; revision: number; is_current: boolean }>(
    db,
    'SELECT s.id, s.revision, t.is_current FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id WHERE s.id = ANY($1)',
    [[...ids]],
  );
  for (const x of r) out.set(x.id, { revision: x.revision, isCurrent: x.is_current });
  return out;
}

/**
 * 'missing' when a cited segment no longer exists or its transcript was replaced; 'edited' when a cited segment's
 * revision differs from the revision recorded at extraction time; otherwise 'ok'. The stored ids/quote never change.
 */
export function sourceStatus(segmentIds: string[], revisions: Record<string, unknown> | null | undefined, states: SegStates): 'ok' | 'edited' | 'missing' {
  let status: 'ok' | 'edited' | 'missing' = 'ok';
  for (const id of segmentIds) {
    const st = states.get(id);
    if (!st || !st.isCurrent) return 'missing';
    const rev = Number((revisions ?? {})[id]);
    if (Number.isFinite(rev) && rev !== st.revision) status = 'edited';
  }
  return status;
}

export function sourceRef(row: any, states: SegStates): SourceRef | null {
  const ids: string[] = row.source_segment_ids ?? [];
  if (!ids.length && !row.source_quote && row.source_start_ms == null) {
    if (!row.meeting_id) return null;
    return { meetingId: row.meeting_id, meetingTitle: row.meeting_title ?? null, meetingDate: iso(row.meeting_date), segmentIds: [], startMs: null, endMs: null, quote: null };
  }
  return {
    meetingId: row.meeting_id ?? null,
    meetingTitle: row.meeting_title ?? null,
    meetingDate: iso(row.meeting_date),
    segmentIds: ids,
    startMs: row.source_start_ms ?? null,
    endMs: row.source_end_ms ?? null,
    quote: row.source_quote ?? null,
    status: sourceStatus(ids, row.source_revisions, states),
  };
}

function base(row: any, states: SegStates) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id ?? null,
    projectId: row.project_id ?? null,
    source: sourceRef(row, states),
    confidence: row.confidence ?? null,
    extractedBy: row.extracted_by,
    aiProvider: row.ai_provider ?? null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export function decisionDto(row: any, states: SegStates): DecisionDto & { seriesId: string | null; confirmedAt: string | null } {
  return {
    ...base(row, states),
    text: row.text,
    topic: row.topic ?? null,
    decidedAt: iso(row.decided_at),
    ownerPersonId: row.owner_person_id ?? null,
    reason: row.reason ?? null,
    reviewState: row.review_state,
    status: row.status,
    supersedesDecisionId: row.supersedes_decision_id ?? null,
    supersededByDecisionId: row.superseded_by_decision_id ?? null,
    participants: row.participant_person_ids ?? [],
    seriesId: row.series_id ?? null,
    confirmedAt: iso(row.confirmed_at),
  };
}

const OPEN_ACTION = new Set(['confirmed', 'in_progress']);

export function actionDto(row: any, states: SegStates, today: string): ActionDto & { assigneeSpeakerId: string | null; completedAt: string | null } {
  return {
    ...base(row, states),
    description: row.description,
    assigneePersonId: row.assignee_person_id ?? null,
    assigneeUserId: row.assignee_user_id ?? null,
    assigneeText: row.assignee_text ?? null,
    assigneeInferred: !!row.assignee_inferred,
    dueDate: row.due_date ?? null,
    dueText: row.due_text ?? null,
    dueInferred: !!row.due_inferred,
    status: row.status,
    overdue: !!row.due_date && row.due_date < today && OPEN_ACTION.has(row.status),
    linkedDecisionId: row.linked_decision_id ?? null,
    externalSyncState: row.external_sync_state ?? 'none',
    assigneeSpeakerId: row.assignee_speaker_id ?? null,
    completedAt: iso(row.completed_at),
  };
}

/** Direction relative to the current user: mine = promised by me; theirs = promised to me / by an outside party; else other. */
export function commitmentDirection(row: any, userId: string, myPersons: Set<string>): 'mine' | 'theirs' | 'other' {
  if (row.promised_by_user_id === userId || (row.promised_by_person_id && myPersons.has(row.promised_by_person_id))) return 'mine';
  if (row.promised_to_user_id === userId || (row.promised_to_person_id && myPersons.has(row.promised_to_person_id))) return 'theirs';
  if (row.promised_by_person_id && row.promised_by_person_user_id == null && row.promised_by_user_id == null) return 'theirs';
  return 'other';
}

export function commitmentDto(
  row: any,
  states: SegStates,
  today: string,
  userId: string,
  myPersons: Set<string>,
): CommitmentDto & { promisedByUserId: string | null; promisedToUserId: string | null; promisedBySpeakerId: string | null; completedAt: string | null } {
  return {
    ...base(row, states),
    description: row.description,
    promisedByPersonId: row.promised_by_person_id ?? null,
    promisedByText: row.promised_by_text ?? null,
    promisedToPersonId: row.promised_to_person_id ?? null,
    promisedToText: row.promised_to_text ?? null,
    direction: commitmentDirection(row, userId, myPersons),
    dueDate: row.due_date ?? null,
    dueText: row.due_text ?? null,
    dueInferred: !!row.due_inferred,
    status: row.status,
    overdue: !!row.due_date && row.due_date < today && row.status === 'open',
    promisedByUserId: row.promised_by_user_id ?? null,
    promisedToUserId: row.promised_to_user_id ?? null,
    promisedBySpeakerId: row.promised_by_speaker_id ?? null,
    completedAt: iso(row.completed_at),
  };
}

export function questionDto(row: any, states: SegStates): QuestionDto & { answeredInMeetingId: string | null } {
  return {
    ...base(row, states),
    question: row.question,
    ownerPersonId: row.owner_person_id ?? null,
    dueDate: row.due_date ?? null,
    status: row.status,
    answerText: row.answer_text ?? null,
    answeredInMeetingId: row.answered_in_meeting_id ?? null,
  };
}

export function contradictionDto(row: any, existing: DecisionDto, created: DecisionDto): ContradictionDto & { meetingId: string | null; resolvedAt: string | null } {
  return {
    id: row.id,
    existingDecision: existing,
    newDecision: created,
    reason: row.reason,
    status: row.status,
    createdAt: iso(row.created_at)!,
    meetingId: row.meeting_id ?? null,
    resolvedAt: iso(row.resolved_at),
  };
}

/** Summary sections are stored with their sources ({segmentIds,startMs,endMs,quote,revisions}). */
export function summarySegmentIds(sections: any): string[] {
  const ids: string[] = [];
  for (const t of [...(sections?.topics ?? []), ...(sections?.risks ?? [])]) for (const id of t?.source?.segmentIds ?? []) ids.push(id);
  return ids;
}

export function summaryDto(row: any, states: SegStates): SummaryDto & { transcriptId: string | null } {
  const s = row.sections ?? {};
  const ref = (src: any): SourceRef | null =>
    src
      ? {
          meetingId: row.meeting_id,
          segmentIds: src.segmentIds ?? [],
          startMs: src.startMs ?? null,
          endMs: src.endMs ?? null,
          quote: src.quote ?? null,
          status: (src.segmentIds ?? []).length ? sourceStatus(src.segmentIds, src.revisions, states) : 'ok',
        }
      : null;
  return {
    id: row.id,
    meetingId: row.meeting_id,
    version: row.version,
    provider: row.provider,
    model: row.model ?? null,
    aiGenerated: true,
    sections: {
      executive: s.executive ?? '',
      topics: (s.topics ?? []).map((t: any) => ({ title: t.title, source: ref(t.source) })),
      risks: (s.risks ?? []).map((t: any) => ({ text: t.text, source: ref(t.source) })),
      nextMeeting: s.nextMeeting ?? null,
    },
    createdAt: iso(row.created_at)!,
    transcriptId: row.transcript_id ?? null,
  };
}
