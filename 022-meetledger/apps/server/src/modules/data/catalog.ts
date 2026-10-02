// Schema introspection + generic row (re)insertion used by backup/restore and workspace import.
// Table / column names always come from the PostgreSQL catalog (never from user input), values are
// passed as one JSON parameter and converted by PostgreSQL itself (jsonb_populate_recordset), so every
// column type (uuid[], tsvector, jsonb, timestamptz, date, real ...) round-trips without JS conversions.
import type { Db } from '../../db/pool';
import { rows } from '../../db/pool';

export interface ColumnInfo {
  name: string;
  /** PostgreSQL udt name, e.g. uuid, _uuid (uuid[]), jsonb, text, timestamptz */
  udt: string;
  nullable: boolean;
  generated: boolean;
  hasDefault: boolean;
}

export interface TableInfo {
  name: string;
  columns: Map<string, ColumnInfo>;
  columnOrder: string[];
  /** single-column foreign keys: column -> referenced table */
  fks: Map<string, string>;
  hasId: boolean;
}

export type Catalog = Map<string, TableInfo>;

export async function loadCatalog(db: Db): Promise<Catalog> {
  const cols = await rows<{ table_name: string; column_name: string; udt_name: string; is_nullable: string; is_generated: string; column_default: string | null }>(
    db,
    `SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable, c.is_generated, c.column_default
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const fks = await rows<{ tbl: string; col: string; ref: string }>(
    db,
    `SELECT cl.relname AS tbl, att.attname AS col, rcl.relname AS ref
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class rcl ON rcl.oid = con.confrelid
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND cardinality(con.conkey) = 1
        AND cl.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
  );
  const cat: Catalog = new Map();
  for (const c of cols) {
    let t = cat.get(c.table_name);
    if (!t) {
      t = { name: c.table_name, columns: new Map(), columnOrder: [], fks: new Map(), hasId: false };
      cat.set(c.table_name, t);
    }
    t.columns.set(c.column_name, {
      name: c.column_name,
      udt: c.udt_name,
      nullable: c.is_nullable === 'YES',
      generated: c.is_generated === 'ALWAYS',
      hasDefault: c.column_default !== null,
    });
    t.columnOrder.push(c.column_name);
    if (c.column_name === 'id') t.hasId = true;
  }
  for (const f of fks) cat.get(f.tbl)?.fks.set(f.col, f.ref);
  return cat;
}

/** Quotes an identifier taken from the catalog. */
export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface InsertionPlan {
  order: string[];
  /** FK columns inserted as NULL first and filled by an UPDATE once all rows exist (self references / cycles). */
  deferred: Map<string, string[]>;
}

/** Orders tables so that referenced tables are inserted first (self references and cycles are deferred). */
export function insertionPlan(cat: Catalog, tables: string[]): InsertionPlan {
  const list = [...new Set(tables)].filter((t) => cat.has(t)).sort();
  const set = new Set(list);
  const deferred = new Map<string, string[]>();
  const deps = new Map<string, Map<string, string>>();
  const defer = (t: string, col: string) => {
    const info = cat.get(t)!;
    if (!info.columns.get(col)?.nullable || !info.hasId) throw new Error(`cannot defer NOT NULL foreign key ${t}.${col}`);
    deferred.set(t, [...(deferred.get(t) ?? []), col]);
  };
  for (const t of list) {
    const d = new Map<string, string>();
    for (const [col, ref] of cat.get(t)!.fks) {
      if (ref === t) defer(t, col);
      else if (set.has(ref)) d.set(col, ref);
    }
    deps.set(t, d);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < list.length) {
    const ready = list.filter((t) => !done.has(t) && [...deps.get(t)!.values()].every((r) => done.has(r)));
    if (ready.length) {
      for (const t of ready) {
        order.push(t);
        done.add(t);
      }
      continue;
    }
    // Cycle between different tables: defer the unresolved (nullable) FK columns of one table.
    const remaining = list.filter((t) => !done.has(t));
    const cand = remaining.find((t) =>
      [...deps.get(t)!].filter(([, r]) => !done.has(r)).every(([c]) => cat.get(t)!.columns.get(c)!.nullable && cat.get(t)!.hasId),
    );
    if (!cand) throw new Error(`unresolvable foreign key cycle among ${remaining.join(', ')}`);
    for (const [c, r] of [...deps.get(cand)!]) {
      if (!done.has(r)) {
        defer(cand, c);
        deps.get(cand)!.delete(c);
      }
    }
  }
  return { order, deferred };
}

/** Insertable columns of `table` that are present in `keys` (generated columns are skipped). */
export function insertColumns(table: TableInfo, keys: Iterable<string>, exclude: string[] = []): string[] {
  const k = new Set(keys);
  return table.columnOrder.filter((c) => k.has(c) && !table.columns.get(c)!.generated && !exclude.includes(c));
}

/**
 * Inserts rows given as a JSON array text (`[{...},{...}]`). Returns inserted row count.
 * `columns` must come from insertColumns(). Deferred columns are left NULL here.
 */
export async function insertJsonText(db: Db, table: TableInfo, columns: string[], jsonArrayText: string, onConflictDoNothing = false): Promise<number> {
  if (!columns.length) return 0;
  const cols = columns.map(qi).join(', ');
  const r = await db.query(
    `INSERT INTO ${qi(table.name)} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${qi(table.name)}, $1::jsonb)${onConflictDoNothing ? ' ON CONFLICT DO NOTHING' : ''}`,
    [jsonArrayText],
  );
  return r.rowCount ?? 0;
}

/** Fills deferred FK columns (rows are matched by id). */
export async function updateDeferredJsonText(db: Db, table: TableInfo, deferredCols: string[], jsonArrayText: string): Promise<number> {
  if (!deferredCols.length) return 0;
  const sets = deferredCols.map((c) => `${qi(c)} = x.${qi(c)}`).join(', ');
  const any = deferredCols.map((c) => `x.${qi(c)} IS NOT NULL`).join(' OR ');
  const r = await db.query(
    `UPDATE ${qi(table.name)} t SET ${sets} FROM jsonb_populate_recordset(NULL::${qi(table.name)}, $1::jsonb) x WHERE t.id = x.id AND (${any})`,
    [jsonArrayText],
  );
  return r.rowCount ?? 0;
}

/** Inserts JS row objects in batches (used by import after id remapping). */
export async function insertObjects(
  db: Db,
  table: TableInfo,
  list: Record<string, unknown>[],
  deferredCols: string[],
  opts: { onConflictDoNothing?: boolean; batch?: number } = {},
): Promise<number> {
  if (!list.length) return 0;
  const keys = new Set<string>();
  for (const r of list) for (const k of Object.keys(r)) keys.add(k);
  const cols = insertColumns(table, keys, deferredCols);
  const size = opts.batch ?? 500;
  let n = 0;
  for (let i = 0; i < list.length; i += size) n += await insertJsonText(db, table, cols, JSON.stringify(list.slice(i, i + size)), opts.onConflictDoNothing);
  if (deferredCols.length) {
    for (let i = 0; i < list.length; i += size) {
      const part = list.slice(i, i + size).map((r) => Object.fromEntries([['id', r.id], ...deferredCols.map((c) => [c, r[c] ?? null])]));
      await updateDeferredJsonText(db, table, deferredCols, JSON.stringify(part));
    }
  }
  return n;
}
