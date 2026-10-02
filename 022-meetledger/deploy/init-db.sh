#!/bin/sh
# Creates the application role WITHOUT superuser/BYPASSRLS so PostgreSQL row level security is enforced.
set -e
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE ROLE meetledger LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE DATABASE meetledger OWNER meetledger;
SQL
# Lets PostgreSQL use GIN full-text indexes under row level security (the tsvector @@ tsquery operator is not marked
# leakproof by default, so RLS-protected queries could not use the index). MeetLedger never runs user-supplied SQL.
# Optional: without it search still works but rare-word searches are time-budgeted (truncated:true). See docs/AI_RAG_SECURITY.md §10.
psql -v ON_ERROR_STOP=1 --username postgres --dbname meetledger -c "ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF;"
