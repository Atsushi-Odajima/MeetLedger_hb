-- Review Inbox paging walks visible meetings newest-first (meeting date = scheduled, else started, else created) and stops
-- after one page of meetings that have candidates. Used only for ORDER BY (no expression quals), so it works under RLS.
CREATE INDEX IF NOT EXISTS meetings_ws_review_order ON meetings (workspace_id, (coalesce(scheduled_start, started_at, created_at)) DESC, id DESC);
