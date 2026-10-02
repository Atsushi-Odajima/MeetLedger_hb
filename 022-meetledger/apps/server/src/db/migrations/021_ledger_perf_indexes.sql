-- Ledger lists / Review Inbox / contradiction detection at spec §40 scale (500k decisions, actions, commitments per workspace).
-- * Ordered indexes on PLAIN columns: under row level security only leakproof expressions can become index conditions,
--   so keyset pagination uses (sort column, id) row comparisons (modules/ledger/queries.ts).
-- * org_id and meeting_id are INCLUDEd so that totals / Review Inbox groupings run as index-only scans
--   (the RLS policy `org_id = app_org_id()` must be evaluable from the index; the meeting ACL is applied per meeting).

-- decisions: views current / candidates / superseded (equality on review_state, status) and view=all
CREATE INDEX IF NOT EXISTS decisions_ws_state_order ON decisions (workspace_id, review_state, status, decided_at DESC NULLS LAST, id DESC) INCLUDE (meeting_id, org_id);
CREATE INDEX IF NOT EXISTS decisions_ws_order ON decisions (workspace_id, decided_at DESC NULLS LAST, id DESC) INCLUDE (meeting_id, org_id, review_state);
-- contradiction detection (bounded candidate sets): same topic / project / series / workspace, newest first
CREATE INDEX IF NOT EXISTS decisions_active_topic ON decisions (workspace_id, topic_key, created_at DESC) WHERE review_state = 'confirmed' AND status = 'active';
CREATE INDEX IF NOT EXISTS decisions_active_project ON decisions (project_id, created_at DESC) WHERE review_state = 'confirmed' AND status = 'active';
CREATE INDEX IF NOT EXISTS decisions_active_series ON decisions (series_id, created_at DESC) WHERE review_state = 'confirmed' AND status = 'active';
CREATE INDEX IF NOT EXISTS decisions_active_recent ON decisions (workspace_id, created_at DESC) WHERE review_state = 'confirmed' AND status = 'active';

-- actions: due date order (NULLS LAST = default for ASC), per status, assignee=me
CREATE INDEX IF NOT EXISTS actions_ws_due ON actions (workspace_id, due_date, id) INCLUDE (meeting_id, org_id, status);
CREATE INDEX IF NOT EXISTS actions_ws_status_due ON actions (workspace_id, status, due_date, id) INCLUDE (meeting_id, org_id);
CREATE INDEX IF NOT EXISTS actions_ws_assignee_user ON actions (workspace_id, assignee_user_id, due_date, id) INCLUDE (meeting_id, org_id, status)
  WHERE assignee_user_id IS NOT NULL;

-- commitments: due date order, per status, direction=mine / promised to me
CREATE INDEX IF NOT EXISTS commitments_ws_due ON commitments (workspace_id, due_date, id) INCLUDE (meeting_id, org_id, status);
CREATE INDEX IF NOT EXISTS commitments_ws_status_due ON commitments (workspace_id, status, due_date, id) INCLUDE (meeting_id, org_id);
CREATE INDEX IF NOT EXISTS commitments_ws_by_user ON commitments (workspace_id, promised_by_user_id, due_date, id) INCLUDE (meeting_id, org_id, status)
  WHERE promised_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commitments_to_user ON commitments (promised_to_user_id) WHERE promised_to_user_id IS NOT NULL;

-- open questions: newest first, per status
CREATE INDEX IF NOT EXISTS questions_ws_order ON open_questions (workspace_id, created_at DESC, id DESC) INCLUDE (meeting_id, org_id, status);
CREATE INDEX IF NOT EXISTS questions_ws_status_order ON open_questions (workspace_id, status, created_at DESC, id DESC) INCLUDE (meeting_id, org_id);

-- contradiction candidates: inbox / list / per meeting / by new decision
CREATE INDEX IF NOT EXISTS contradictions_ws_status ON contradiction_candidates (workspace_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS contradictions_meeting ON contradiction_candidates (meeting_id, status);
CREATE INDEX IF NOT EXISTS contradictions_new_decision ON contradiction_candidates (new_decision_id);
