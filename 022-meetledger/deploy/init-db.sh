#!/bin/sh
# Creates the application role WITHOUT superuser/BYPASSRLS so PostgreSQL row level security is enforced.
set -e
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE ROLE meetledger LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE DATABASE meetledger OWNER meetledger;
SQL
