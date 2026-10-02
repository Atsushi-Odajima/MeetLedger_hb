-- search module: performance at large scale (spec §40).
-- Context: under FORCE ROW LEVEL SECURITY PostgreSQL only uses an index for a qual whose operator is LEAKPROOF.
-- `tsvector @@ tsquery` (ts_match_vq) and array operators are not leakproof, so the GIN indexes on tsv / person_ids are
-- not usable by tenant queries. Search therefore walks meetings newest-first through btree indexes (leakproof
-- uuid / timestamptz comparisons) and filters content per meeting window.

-- Recency windows over visible meetings (keyset: mdate <= $d AND (mdate < $d OR id < $id)).
CREATE INDEX IF NOT EXISTS meetings_ws_mdate ON meetings (workspace_id, (coalesce(scheduled_start, created_at)) DESC, id DESC) WHERE deleted_at IS NULL;

-- Person documents (workspace-level, meeting_id IS NULL) without scanning all meeting documents.
CREATE INDEX IF NOT EXISTS search_docs_ws_nomeeting ON search_docs (workspace_id, entity_type) WHERE meeting_id IS NULL;

-- People referenced by a meeting's indexed content (speakers, owners, promisers, assignees, participants at index time).
-- btree lookup replaces the (RLS-unusable) GIN on search_docs.person_ids for the personId filter.
CREATE TABLE IF NOT EXISTS search_person_refs (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, person_id, meeting_id)
);
CREATE INDEX IF NOT EXISTS search_person_refs_meeting ON search_person_refs (meeting_id);
ALTER TABLE search_person_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_person_refs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search_person_refs;
CREATE POLICY tenant_isolation ON search_person_refs USING (app_is_system() OR org_id = app_org_id()) WITH CHECK (app_is_system() OR org_id = app_org_id());
