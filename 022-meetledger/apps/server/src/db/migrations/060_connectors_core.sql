-- connectors / MCP (060-069): OAuth state, calendar preview cache, webhook deliveries, idempotency indexes.
-- Additive only. New tenant tables carry org_id + the standard FORCED tenant_isolation RLS policy.

-- Server-side OAuth authorization requests: state (hashed) + PKCE code_verifier (encrypted). One-time, 10 min TTL.
CREATE TABLE connector_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  verifier_ciphertext text NOT NULL,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Calendar event preview cache (what sync/preview returned). Importing creates meetings from these rows.
-- Only scheduling metadata is kept (no event body/description).
CREATE TABLE connector_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  series_key text,
  recurrence text,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  all_day boolean NOT NULL DEFAULT false,
  start_date date,
  end_date date,
  timezone text,
  organizer jsonb,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  flags text[] NOT NULL DEFAULT '{}',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, event_key)
);
CREATE INDEX connector_events_connector ON connector_events(connector_id, starts_at);

-- Outbound webhook deliveries (retried by the job worker).
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (webhook_id, dedupe_key)
);
CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- External writes: the same payload can be pending/executed only once per workspace (re-approve never re-sends).
CREATE UNIQUE INDEX external_writes_payload_once ON external_write_requests(workspace_id, payload_hash)
  WHERE status IN ('pending_approval','approved','executed');
CREATE INDEX external_writes_ws ON external_write_requests(workspace_id, created_at DESC);

-- Calendar import: recurring events are grouped into one series per calendar recurrence id.
CREATE UNIQUE INDEX series_calendar_recurring ON series(workspace_id, calendar_recurring_id) WHERE calendar_recurring_id IS NOT NULL;

CREATE INDEX connector_accounts_user ON connector_accounts(workspace_id, user_id, provider);
CREATE INDEX mcp_confirmations_user ON mcp_confirmations(user_id, expires_at);
CREATE INDEX api_tokens_ws_user ON api_tokens(workspace_id, user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connector_oauth_states','connector_events','webhook_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR org_id = app_org_id()) WITH CHECK (app_is_system() OR org_id = app_org_id())', t);
  END LOOP;
END $$;
