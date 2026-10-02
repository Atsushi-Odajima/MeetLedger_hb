-- MeetLedger schema v1.
-- Tenant isolation: every tenant table carries org_id and has a FORCED row level security policy
-- (app.org_id session setting). Application code ALSO filters by org/workspace (defense in depth).

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

-- ---------------------------------------------------------------- identity (global, no RLS)
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_sample boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text,
  locale text NOT NULL DEFAULT 'ja',
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members(user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------- tenant tables
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX workspaces_org ON workspaces(org_id);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{read}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE user_prefs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  quiet_start_min int NOT NULL DEFAULT 1320,  -- 22:00
  quiet_end_min int NOT NULL DEFAULT 480,     -- 08:00
  email_enabled boolean NOT NULL DEFAULT false,
  max_per_hour int NOT NULL DEFAULT 6,
  brief_lead_min int NOT NULL DEFAULT 60,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'project' CHECK (kind IN ('project','client')),
  client_name text,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_ws ON projects(workspace_id);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  meeting_type text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

CREATE TABLE series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  cadence text,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  meeting_type text NOT NULL DEFAULT 'other',
  template_key text,
  default_visibility text NOT NULL DEFAULT 'workspace',
  calendar_recurring_id text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX series_ws ON series(workspace_id);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  organization text,
  role_title text,
  email text,
  notes text,
  tags text[] NOT NULL DEFAULT '{}',
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX people_ws ON people(workspace_id);
CREATE INDEX people_email ON people(workspace_id, lower(email));
CREATE INDEX people_user ON people(workspace_id, user_id);

CREATE TABLE person_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_notes_person ON person_notes(person_id);

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  source text NOT NULL DEFAULT 'manual',
  calendar_event_id text,
  calendar_connection_id uuid,
  organizer_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  meeting_type text NOT NULL DEFAULT 'other' CHECK (meeting_type IN ('sales','client','internal','one_on_one','project','interview','workshop','other')),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  series_id uuid REFERENCES series(id) ON DELETE SET NULL,
  template_key text,
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('private','workspace','selected')),
  consent_state text NOT NULL DEFAULT 'not_recording' CHECK (consent_state IN ('not_recording','pending','notified','confirmed','declined')),
  audio_retention text NOT NULL DEFAULT 'until_processed' CHECK (audio_retention IN ('never','until_processed','7d','30d','custom')),
  audio_retention_days int,
  transcription_mode text NOT NULL DEFAULT 'local' CHECK (transcription_mode IN ('local','cloud','none')),
  ai_enabled boolean NOT NULL DEFAULT true,
  is_confidential boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','processing','ready','needs_review','archived')),
  language text,
  created_by uuid NOT NULL REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX meetings_ws_start ON meetings(workspace_id, scheduled_start DESC);
CREATE INDEX meetings_series ON meetings(series_id, scheduled_start);
CREATE INDEX meetings_project ON meetings(project_id, scheduled_start);
CREATE INDEX meetings_status ON meetings(workspace_id, status);
CREATE UNIQUE INDEX meetings_calendar_event ON meetings(workspace_id, calendar_event_id) WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE meeting_access (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX meeting_access_user ON meeting_access(user_id);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  email text,
  role text NOT NULL DEFAULT 'attendee' CHECK (role IN ('organizer','attendee','optional')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participants_meeting ON participants(meeting_id);
CREATE INDEX participants_person ON participants(person_id);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('recording','transcription','ai_processing','disclosure_shown','external_transfer')),
  state text NOT NULL CHECK (state IN ('notified','confirmed','declined','acknowledged')),
  method text NOT NULL DEFAULT 'in_app' CHECK (method IN ('in_app','verbal','calendar_note','email','chat_message','other')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_meeting ON consent_records(meeting_id);

CREATE TABLE meeting_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, author_user_id)
);

CREATE TABLE agenda_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text text NOT NULL,
  source_type text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','action','question','commitment','decision','template')),
  source_id uuid,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','accepted','rejected','done')),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, source_type, source_id)
);

-- ---------------------------------------------------------------- media & transcripts
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('original_audio','original_video','normalized_audio','transcript_file','attachment')),
  storage_key text NOT NULL,
  mime text NOT NULL,
  original_name text,
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL,
  duration_ms int,
  channels int,
  encrypted boolean NOT NULL DEFAULT true,
  retention_until timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX media_meeting ON media_assets(meeting_id);
CREATE INDEX media_retention ON media_assets(retention_until) WHERE deleted_at IS NULL;

CREATE TABLE transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  version int NOT NULL,
  provider text NOT NULL,
  is_local boolean NOT NULL,
  language text,
  input_hash text NOT NULL,
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  job_id uuid,
  is_current boolean NOT NULL DEFAULT true,
  quality_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, version),
  UNIQUE (meeting_id, input_hash, provider)
);
CREATE INDEX transcripts_meeting ON transcripts(meeting_id) WHERE is_current;

CREATE TABLE meeting_speakers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label text NOT NULL,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  display_name text,
  source text NOT NULL DEFAULT 'diarization' CHECK (source IN ('diarization','channel','manual','import','none')),
  suggestion text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, label)
);

CREATE TABLE transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  seq int NOT NULL,
  start_ms int NOT NULL,
  end_ms int NOT NULL,
  speaker_id uuid REFERENCES meeting_speakers(id) ON DELETE SET NULL,
  speaker_label text NOT NULL DEFAULT 'Speaker 1',
  text text NOT NULL,
  confidence real,
  flags text[] NOT NULL DEFAULT '{}',
  revision int NOT NULL DEFAULT 1,
  edited_by uuid,
  edited_at timestamptz,
  tsv tsvector,
  UNIQUE (transcript_id, seq)
);
CREATE INDEX segments_meeting ON transcript_segments(meeting_id, start_ms);
CREATE INDEX segments_tsv ON transcript_segments USING gin(tsv);

CREATE TABLE segment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  revision int NOT NULL,
  old_text text,
  new_text text,
  old_speaker_label text,
  new_speaker_label text,
  edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  edited_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX segment_revisions_segment ON segment_revisions(segment_id);

CREATE TABLE summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript_id uuid REFERENCES transcripts(id) ON DELETE SET NULL,
  version int NOT NULL,
  provider text NOT NULL,
  model text,
  sections jsonb NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, version)
);

-- ---------------------------------------------------------------- ledgers
-- Common source columns: source_segment_ids, source_start_ms, source_end_ms, source_quote,
-- source_transcript_id, source_revisions (segment id -> revision at extraction time).

CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  series_id uuid REFERENCES series(id) ON DELETE SET NULL,
  text text NOT NULL,
  topic text,
  topic_key text,
  decided_at timestamptz,
  owner_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  reason text,
  participant_person_ids uuid[] NOT NULL DEFAULT '{}',
  review_state text NOT NULL DEFAULT 'candidate' CHECK (review_state IN ('candidate','confirmed','rejected')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','revoked')),
  supersedes_decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  superseded_by_decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  source_segment_ids uuid[] NOT NULL DEFAULT '{}',
  source_start_ms int,
  source_end_ms int,
  source_quote text,
  source_transcript_id uuid,
  source_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real,
  extracted_by text NOT NULL DEFAULT 'user' CHECK (extracted_by IN ('ai','user','import')),
  ai_provider text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_ws ON decisions(workspace_id, review_state, status);
CREATE INDEX decisions_meeting ON decisions(meeting_id);
CREATE INDEX decisions_project ON decisions(project_id) WHERE review_state = 'confirmed';
CREATE INDEX decisions_topic ON decisions(workspace_id, topic_key);

CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  series_id uuid REFERENCES series(id) ON DELETE SET NULL,
  description text NOT NULL,
  assignee_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  assignee_speaker_id uuid REFERENCES meeting_speakers(id) ON DELETE SET NULL,
  assignee_text text,
  assignee_inferred boolean NOT NULL DEFAULT false,
  due_date date,
  due_text text,
  due_inferred boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','in_progress','done','cancelled','rejected')),
  linked_decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  external_sync_state text NOT NULL DEFAULT 'none' CHECK (external_sync_state IN ('none','pending_approval','synced','failed')),
  external_ref text,
  source_segment_ids uuid[] NOT NULL DEFAULT '{}',
  source_start_ms int,
  source_end_ms int,
  source_quote text,
  source_transcript_id uuid,
  source_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real,
  extracted_by text NOT NULL DEFAULT 'user' CHECK (extracted_by IN ('ai','user','import')),
  ai_provider text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_ws ON actions(workspace_id, status, due_date);
CREATE INDEX actions_meeting ON actions(meeting_id);
CREATE INDEX actions_assignee_user ON actions(assignee_user_id, status);
CREATE INDEX actions_assignee_person ON actions(assignee_person_id, status);
CREATE INDEX actions_project ON actions(project_id, status);

CREATE TABLE commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  series_id uuid REFERENCES series(id) ON DELETE SET NULL,
  description text NOT NULL,
  promised_by_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  promised_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  promised_by_speaker_id uuid REFERENCES meeting_speakers(id) ON DELETE SET NULL,
  promised_by_text text,
  promised_to_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  promised_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  promised_to_text text,
  due_date date,
  due_text text,
  due_inferred boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','open','done','cancelled','rejected')),
  source_segment_ids uuid[] NOT NULL DEFAULT '{}',
  source_start_ms int,
  source_end_ms int,
  source_quote text,
  source_transcript_id uuid,
  source_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real,
  extracted_by text NOT NULL DEFAULT 'user' CHECK (extracted_by IN ('ai','user','import')),
  ai_provider text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commitments_ws ON commitments(workspace_id, status, due_date);
CREATE INDEX commitments_meeting ON commitments(meeting_id);
CREATE INDEX commitments_by ON commitments(promised_by_person_id, status);
CREATE INDEX commitments_to ON commitments(promised_to_person_id, status);

CREATE TABLE open_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  series_id uuid REFERENCES series(id) ON DELETE SET NULL,
  question text NOT NULL,
  owner_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  due_date date,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','open','answered','dropped','rejected')),
  answer_text text,
  answered_in_meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  source_segment_ids uuid[] NOT NULL DEFAULT '{}',
  source_start_ms int,
  source_end_ms int,
  source_quote text,
  source_transcript_id uuid,
  source_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real,
  extracted_by text NOT NULL DEFAULT 'user' CHECK (extracted_by IN ('ai','user','import')),
  ai_provider text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_ws ON open_questions(workspace_id, status);
CREATE INDEX questions_meeting ON open_questions(meeting_id);

CREATE TABLE contradiction_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  existing_decision_id uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  new_decision_id uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed_change','not_change','dismissed')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (existing_decision_id, new_decision_id)
);

CREATE TABLE ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event text NOT NULL,
  by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_events_entity ON ledger_events(entity_type, entity_id, created_at);
CREATE INDEX ledger_events_ws ON ledger_events(workspace_id, created_at DESC);

-- ---------------------------------------------------------------- follow-up & notifications
CREATE TABLE followup_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('thank_you_email','internal_recap','client_recap','slack_update')),
  subject text,
  body text NOT NULL,
  referenced_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','discarded')),
  generated_by text NOT NULL DEFAULT 'template' CHECK (generated_by IN ('template','ai')),
  external_write_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX followups_meeting ON followup_drafts(meeting_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  entity_type text,
  entity_id uuid,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','suppressed','digested')),
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user ON notifications(user_id, status, scheduled_for DESC);

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  to_address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','held')),
  dedupe_key text UNIQUE,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- ---------------------------------------------------------------- search & AI
CREATE TABLE search_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text,
  body text NOT NULL,
  tsv tsvector NOT NULL,
  occurred_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX search_docs_tsv ON search_docs USING gin(tsv);
CREATE INDEX search_docs_ws ON search_docs(workspace_id, occurred_at DESC);

-- Vector store for semantic retrieval. Only meetings with ai_enabled=true are indexed.
-- ACL metadata (org/workspace/meeting) is stored with every vector; ACL is enforced in SQL before scoring.
CREATE TABLE ai_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  chunk_index int NOT NULL DEFAULT 0,
  text text NOT NULL,
  start_ms int,
  end_ms int,
  embedding real[] NOT NULL,
  embedding_model text NOT NULL,
  tsv tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, chunk_index, embedding_model)
);
CREATE INDEX ai_chunks_meeting ON ai_chunks(meeting_id);
CREATE INDEX ai_chunks_ws ON ai_chunks(workspace_id);
CREATE INDEX ai_chunks_tsv ON ai_chunks USING gin(tsv);

-- Metadata-only audit of every outbound call to a third party (no content is stored).
CREATE TABLE external_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid,
  kind text NOT NULL,
  provider text NOT NULL,
  host text NOT NULL,
  purpose text NOT NULL,
  bytes_sent bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX external_calls_meeting ON external_calls(meeting_id);
CREATE INDEX external_calls_org ON external_calls(org_id, created_at DESC);

CREATE TABLE brief_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, user_id)
);

-- ---------------------------------------------------------------- jobs
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead','cancelled')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_runnable ON jobs(status, run_after);

-- ---------------------------------------------------------------- connectors & external writes
CREATE TABLE connector_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','error','revoked')),
  scopes text[] NOT NULL DEFAULT '{}',
  secret_ciphertext text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_accounts_ws ON connector_accounts(workspace_id);

CREATE TABLE external_write_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connector_accounts(id) ON DELETE SET NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  target text,
  preview jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','executed','rejected','failed','expired')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_ciphertext text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool text NOT NULL,
  args_hash text NOT NULL,
  preview jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit & deletion
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  user_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org ON audit_events(org_id, created_at DESC);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  scope text NOT NULL CHECK (scope IN ('meeting','meeting_audio','meeting_transcript','meeting_ai_index','person','workspace')),
  target_id uuid NOT NULL,
  target_label text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- ---------------------------------------------------------------- RLS for every tenant table
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = current_schema() AND c.column_name = 'org_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('org_members')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR org_id = app_org_id()) WITH CHECK (app_is_system() OR org_id = app_org_id())', t);
  END LOOP;
END $$;
