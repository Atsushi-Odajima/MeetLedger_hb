#!/usr/bin/env bash
# Local PostgreSQL 16 cluster for development & tests (NOT for production).
# Usage: scripts/pg-test.sh start|stop|status|psql
# Runs as the 'postgres' OS user when executed as root (PostgreSQL refuses to run as root).
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/tmp/meetledger-pg/data}"
PGPORT="${PGPORT:-55432}"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); fi

case "${1:-start}" in
  start)
    mkdir -p "$(dirname "$PGDATA")"
    [ "$(id -u)" = "0" ] && chown -R postgres:postgres "$(dirname "$PGDATA")"
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      "${RUNAS[@]}" "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
      cat >> "$PGDATA/postgresql.conf" <<CONF
port = $PGPORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '/tmp'
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 200
shared_buffers = 512MB
work_mem = 32MB
maintenance_work_mem = 512MB
CONF
    fi
    if ! "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
      "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/../server.log" -w start >/dev/null
    fi
    # Application role: NOT superuser, no BYPASSRLS -> row level security is enforced.
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAc "SELECT 1 FROM pg_roles WHERE rolname='meetledger'" | grep -q 1 || \
      psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE ROLE meetledger LOGIN PASSWORD 'meetledger' CREATEDB NOSUPERUSER NOBYPASSRLS"
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAc "SELECT 1 FROM pg_database WHERE datname='meetledger'" | grep -q 1 || \
      psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE DATABASE meetledger OWNER meetledger"
    echo "postgres://meetledger:meetledger@127.0.0.1:$PGPORT/meetledger"
    ;;
  stop) "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop ;;
  status) "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" status ;;
  psql) shift; psql -h 127.0.0.1 -p "$PGPORT" -U meetledger meetledger "$@" ;;
  *) echo "usage: $0 start|stop|status|psql"; exit 1 ;;
esac
