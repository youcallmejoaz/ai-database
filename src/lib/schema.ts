import { readQuery } from "./db";

/**
 * Introspects the database into a compact text summary that goes into the
 * system prompt, so Claude can write correct SQL without a lookup per table.
 */

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";
const MAX_SCHEMA_CHARS = 40_000;

interface ColumnRow {
  schema: string;
  table: string;
  kind: string;
  /** null when the table has never been analyzed. */
  estimate: string | null;
  column: string;
  type: string;
  not_null: boolean;
  is_pk: boolean;
  table_comment: string | null;
}

interface ForeignKeyRow {
  schema: string;
  table: string;
  definition: string;
}

const KIND_LABEL: Record<string, string> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

export async function loadSchemaSummary(): Promise<string> {
  const columns = await readQuery<ColumnRow>(`
    SELECT n.nspname AS schema, c.relname AS table, c.relkind AS kind,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimate,
           a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null,
           EXISTS (SELECT 1 FROM pg_index i
                   WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS is_pk,
           obj_description(c.oid, 'pg_class') AS table_comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_temp%'
      AND NOT c.relispartition
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname, a.attnum`);

  const foreignKeys = await readQuery<ForeignKeyRow>(`
    SELECT n.nspname AS schema, c.relname AS table, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    ORDER BY n.nspname, c.relname, con.conname`);

  if (columns.length === 0) return "(No tables are visible to this database user.)";

  const fksByTable = new Map<string, string[]>();
  for (const fk of foreignKeys) {
    const key = `${fk.schema}.${fk.table}`;
    fksByTable.set(key, [...(fksByTable.get(key) ?? []), fk.definition]);
  }

  // Group the column rows (already ordered by table) into one text block per table.
  const tables = new Map<string, string[]>();
  for (const col of columns) {
    const key = `${col.schema}.${col.table}`;
    let lines = tables.get(key);
    if (!lines) {
      const kind = KIND_LABEL[col.kind] ?? col.kind;
      const size = col.kind === "v" || col.estimate === null ? "" : `, ~${col.estimate} rows`;
      const comment = col.table_comment ? ` -- ${col.table_comment}` : "";
      lines = [`${key} (${kind}${size})${comment}`];
      tables.set(key, lines);
    }
    const flags = [col.is_pk ? "PK" : "", col.not_null && !col.is_pk ? "NOT NULL" : ""].filter(Boolean);
    lines.push(`  ${col.column} ${col.type}${flags.length ? " " + flags.join(" ") : ""}`);
  }
  const blocks = [...tables].map(([key, lines]) =>
    [...lines, ...(fksByTable.get(key) ?? []).map((fk) => `  ${fk}`)].join("\n"),
  );

  const full = blocks.join("\n");
  if (full.length <= MAX_SCHEMA_CHARS) return full;

  // Very large schemas: list table names only and let Claude call describe_table.
  const names = blocks.map((b) => b.split("\n")[0]);
  return `${names.join("\n")}\n\n(The schema is large, so only table names are listed. Call describe_table for columns.)`;
}

interface SchemaCache {
  text?: string;
  loadedAt?: number;
  loading?: Promise<string>;
}

const cache: SchemaCache = ((globalThis as { __aiDbSchema?: SchemaCache }).__aiDbSchema ??= {});

/** Cached schema summary. The same text keeps the prompt cache warm between turns. */
export async function getSchemaSummary(opts: { refresh?: boolean } = {}): Promise<string> {
  if (!opts.refresh && cache.text !== undefined) return cache.text;
  if (!cache.loading) {
    cache.loading = loadSchemaSummary()
      .then((text) => {
        cache.text = text;
        cache.loadedAt = Date.now();
        return text;
      })
      .finally(() => {
        cache.loading = undefined;
      });
  }
  return cache.loading;
}
