-- search module: index metadata (additive).
-- person_ids : people a document / chunk is about (participants, speakers, owners, promisers) -> person filter.
-- meta       : non-content metadata used for display / ranking (status, review state, source timestamps, segment ids).
-- content_hash (ai_chunks): skip re-embedding unchanged chunks (idempotent re-index, no duplicate cloud calls).
-- ACL is NOT snapshotted here: visibility/access is always joined live from meetings at query time.

ALTER TABLE search_docs ADD COLUMN IF NOT EXISTS person_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE search_docs ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS search_docs_meeting ON search_docs(meeting_id);
CREATE INDEX IF NOT EXISTS search_docs_persons ON search_docs USING gin(person_ids);

ALTER TABLE ai_chunks ADD COLUMN IF NOT EXISTS person_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_chunks ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_chunks ADD COLUMN IF NOT EXISTS content_hash text;
