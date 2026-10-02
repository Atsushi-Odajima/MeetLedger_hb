#!/usr/bin/env bash
# Regenerates docs/DATA_MODEL.md table reference from a migrated database (default: newest test template).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-$(psql -h 127.0.0.1 -p 55432 -U postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'ml_tpl_%' ORDER BY oid DESC LIMIT 1")}"
{
  cat docs/_data_model_head.md
  echo "## テーブル定義（自動生成: scripts/gen-data-model.sh, migrations: $(psql -h 127.0.0.1 -p 55432 -U postgres -d "$DB" -Atc "SELECT string_agg(name, ', ' ORDER BY name) FROM schema_migrations")）"
  psql -h 127.0.0.1 -p 55432 -U postgres -d "$DB" -At -F $'\t' -c "
    SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default,'')
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema
    WHERE c.table_schema='public' AND t.table_type='BASE TABLE' ORDER BY c.table_name, c.ordinal_position" | python3 -c '
import sys, collections
tables = collections.OrderedDict()
for line in sys.stdin:
    t, col, typ, nul, d = line.rstrip("\n").split("\t")
    tables.setdefault(t, []).append((col, typ, nul, d))
for t, cols in tables.items():
    print("\n### " + t + "\n\n| column | type | null | default |\n|---|---|---|---|")
    for col, typ, nul, d in cols:
        d = d.replace("|", "/")
        d = d if len(d) <= 40 else d[:40] + "..."
        print("| %s | %s | %s | %s |" % (col, typ, "YES" if nul == "YES" else "NO", d))
'
} > docs/DATA_MODEL.md
echo "docs/DATA_MODEL.md regenerated from $DB"
