// Direct ledger inserts for followup tests (the ledger module is built concurrently; we only READ its tables).
import type { TestEnv } from './helpers';

type Ctx = { env: TestEnv; orgId: string; workspaceId: string };

async function ins(c: Ctx, sql: string, params: unknown[]): Promise<string> {
  return c.env.tenantTx(c.orgId, async (db) => (await db.query(sql, params)).rows[0].id as string);
}

/** project_id / series_id default to the meeting's (as the ledger module does). */
const fromMeeting = (col: 'project_id' | 'series_id', p: string) => `coalesce(${p}::uuid, (SELECT m.${col} FROM meetings m WHERE m.id = $3::uuid))`;

export function ledger(c: Ctx) {
  return {
    decision: (o: {
      meetingId?: string | null;
      text: string;
      reason?: string | null;
      topic?: string | null;
      reviewState?: 'candidate' | 'confirmed' | 'rejected';
      status?: 'active' | 'superseded' | 'revoked';
      projectId?: string | null;
      seriesId?: string | null;
      ownerPersonId?: string | null;
      participantPersonIds?: string[];
      decidedAt?: string | null;
      confirmedAt?: string | null;
    }) =>
      ins(
        c,
        `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, reason, topic, review_state, status, owner_person_id, participant_person_ids, decided_at, confirmed_at)
         VALUES ($1,$2,$3,${fromMeeting('project_id', '$4')},${fromMeeting('series_id', '$5')},$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          c.orgId,
          c.workspaceId,
          o.meetingId ?? null,
          o.projectId ?? null,
          o.seriesId ?? null,
          o.text,
          o.reason ?? null,
          o.topic ?? null,
          o.reviewState ?? 'confirmed',
          o.status ?? 'active',
          o.ownerPersonId ?? null,
          o.participantPersonIds ?? [],
          o.decidedAt ?? null,
          o.confirmedAt ?? null,
        ],
      ),
    action: (o: {
      meetingId?: string | null;
      description: string;
      status?: 'candidate' | 'confirmed' | 'in_progress' | 'done' | 'cancelled' | 'rejected';
      assigneeUserId?: string | null;
      assigneePersonId?: string | null;
      assigneeText?: string | null;
      dueDate?: string | null;
      confirmedAt?: string | null;
      projectId?: string | null;
      seriesId?: string | null;
    }) =>
      ins(
        c,
        `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, series_id, description, status, assignee_user_id, assignee_person_id, assignee_text, due_date, confirmed_at)
         VALUES ($1,$2,$3,${fromMeeting('project_id', '$4')},${fromMeeting('series_id', '$5')},$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          c.orgId,
          c.workspaceId,
          o.meetingId ?? null,
          o.projectId ?? null,
          o.seriesId ?? null,
          o.description,
          o.status ?? 'confirmed',
          o.assigneeUserId ?? null,
          o.assigneePersonId ?? null,
          o.assigneeText ?? null,
          o.dueDate ?? null,
          o.confirmedAt ?? null,
        ],
      ),
    commitment: (o: {
      meetingId?: string | null;
      description: string;
      status?: 'candidate' | 'open' | 'done' | 'cancelled' | 'rejected';
      promisedByUserId?: string | null;
      promisedByPersonId?: string | null;
      promisedByText?: string | null;
      promisedToUserId?: string | null;
      promisedToPersonId?: string | null;
      promisedToText?: string | null;
      dueDate?: string | null;
      projectId?: string | null;
      seriesId?: string | null;
    }) =>
      ins(
        c,
        `INSERT INTO commitments(org_id, workspace_id, meeting_id, project_id, series_id, description, status, promised_by_user_id, promised_by_person_id, promised_by_text,
                                 promised_to_user_id, promised_to_person_id, promised_to_text, due_date)
         VALUES ($1,$2,$3,${fromMeeting('project_id', '$4')},${fromMeeting('series_id', '$5')},$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          c.orgId,
          c.workspaceId,
          o.meetingId ?? null,
          o.projectId ?? null,
          o.seriesId ?? null,
          o.description,
          o.status ?? 'open',
          o.promisedByUserId ?? null,
          o.promisedByPersonId ?? null,
          o.promisedByText ?? null,
          o.promisedToUserId ?? null,
          o.promisedToPersonId ?? null,
          o.promisedToText ?? null,
          o.dueDate ?? null,
        ],
      ),
    question: (o: { meetingId?: string | null; question: string; status?: 'candidate' | 'open' | 'answered' | 'dropped' | 'rejected'; ownerPersonId?: string | null; projectId?: string | null; seriesId?: string | null }) =>
      ins(
        c,
        `INSERT INTO open_questions(org_id, workspace_id, meeting_id, project_id, series_id, question, status, owner_person_id)
         VALUES ($1,$2,$3,${fromMeeting('project_id', '$4')},${fromMeeting('series_id', '$5')},$6,$7,$8) RETURNING id`,
        [c.orgId, c.workspaceId, o.meetingId ?? null, o.projectId ?? null, o.seriesId ?? null, o.question, o.status ?? 'open', o.ownerPersonId ?? null],
      ),
    /** old → superseded by new (both directions recorded, as the ledger module does on "change"). */
    supersede: (oldId: string, newId: string) =>
      c.env.tenantTx(c.orgId, async (db) => {
        await db.query(`UPDATE decisions SET status='superseded', superseded_by_decision_id=$2, updated_at=now() WHERE id=$1`, [oldId, newId]);
        await db.query(`UPDATE decisions SET supersedes_decision_id=$1 WHERE id=$2`, [oldId, newId]);
      }),
    setMeeting: (meetingId: string, fields: { status?: string; ended_at?: string | null; scheduled_start?: string | null }) =>
      c.env.tenantTx(c.orgId, async (db) => {
        const cols = Object.keys(fields);
        const sets = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await db.query(`UPDATE meetings SET ${sets} WHERE id = $1`, [meetingId, ...cols.map((k) => (fields as any)[k])]);
      }),
  };
}
