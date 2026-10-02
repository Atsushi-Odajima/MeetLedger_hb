-- audio module: lookup indexes (additive, no data change).
-- jobs_payload_meeting   : GET /meetings/:id/processing filters audio.process / ai.extract jobs by payload meetingId.
-- media_assets_meeting_sha: upload de-duplication (same file re-sent for the same meeting reuses the asset + job).
CREATE INDEX IF NOT EXISTS jobs_payload_meeting ON jobs ((payload->>'meetingId'));
CREATE INDEX IF NOT EXISTS media_assets_meeting_sha ON media_assets (meeting_id, sha256) WHERE deleted_at IS NULL;
