-- followup module (030-039): follow-up draft editing metadata, notification digests.
-- Additive only. followup_drafts / notifications already have org_id + FORCED RLS from 001_init.sql.

ALTER TABLE followup_drafts
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'ja',
  ADD COLUMN IF NOT EXISTS tone text,
  -- true once a human edited subject/body (the draft is then never regenerated in place).
  ADD COLUMN IF NOT EXISTS edited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  -- optimistic concurrency for user edits.
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1,
  -- 'sent' is recorded by a human (mark-sent); MeetLedger never sends follow-ups automatically.
  ADD COLUMN IF NOT EXISTS sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS discarded_at timestamptz,
  -- metadata only (warnings, polish outcome); never transcript content.
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS followups_ws ON followup_drafts(workspace_id, status);

-- Storm control: notifications merged into a digest point to it.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS digest_id uuid REFERENCES notifications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(org_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS notifications_digest ON notifications(digest_id) WHERE digest_id IS NOT NULL;

-- Notification time zone: explicit value from the notification settings wins; otherwise the profile time zone (users.timezone).
ALTER TABLE user_prefs
  ADD COLUMN IF NOT EXISTS timezone_set boolean NOT NULL DEFAULT false;
