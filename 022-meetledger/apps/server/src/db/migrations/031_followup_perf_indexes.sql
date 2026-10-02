-- followup module: indexes for Brief / Memory / Timeline / Dashboard / notification engine at spec §40 scale.
-- Complements 021_ledger_perf_indexes.sql (no duplicates). Under RLS only leakproof operators (=, <, = ANY, IS NULL)
-- become index conditions, so every OR-branch used by the followup scopes is a plain-column equality with its own index
-- (→ BitmapOr instead of a sequential scan).

-- supersession: "current decision" anti-join and Recent Changes (old → new) lookups
CREATE INDEX IF NOT EXISTS decisions_supersedes ON decisions (supersedes_decision_id) WHERE supersedes_decision_id IS NOT NULL;
-- Recent Changes windows (dashboard 7d / brief 30d / memory 90d): superseded decisions by time of change
CREATE INDEX IF NOT EXISTS decisions_superseded_recent ON decisions (workspace_id, updated_at DESC) WHERE review_state = 'confirmed' AND status = 'superseded';
CREATE INDEX IF NOT EXISTS decisions_superseded_series ON decisions (series_id, updated_at DESC) WHERE review_state = 'confirmed' AND status = 'superseded';
CREATE INDEX IF NOT EXISTS decisions_superseded_project ON decisions (project_id, updated_at DESC) WHERE review_state = 'confirmed' AND status = 'superseded';
-- person-linked branches (brief / timeline)
CREATE INDEX IF NOT EXISTS decisions_owner_person ON decisions (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS questions_owner_person ON open_questions (owner_person_id) WHERE owner_person_id IS NOT NULL;

-- series / project branches (memory, brief) for tables that have none yet
CREATE INDEX IF NOT EXISTS actions_series ON actions (series_id, status);
CREATE INDEX IF NOT EXISTS commitments_project ON commitments (project_id, status);
CREATE INDEX IF NOT EXISTS commitments_series ON commitments (series_id, status);
CREATE INDEX IF NOT EXISTS questions_project ON open_questions (project_id, status);
CREATE INDEX IF NOT EXISTS questions_series ON open_questions (series_id, status);

-- notification engine: T+1 reminders (recently confirmed open actions)
CREATE INDEX IF NOT EXISTS actions_open_confirmed_at ON actions (confirmed_at) WHERE status IN ('confirmed', 'in_progress') AND confirmed_at IS NOT NULL;
-- "meetings I take part in" (dashboard, upcoming brief reminders)
CREATE INDEX IF NOT EXISTS participants_user ON participants (user_id) WHERE user_id IS NOT NULL;
-- inbox (newest delivered first) and storm control (delivered in the last hour)
CREATE INDEX IF NOT EXISTS notifications_user_delivered ON notifications (user_id, delivered_at DESC) WHERE status = 'delivered';
