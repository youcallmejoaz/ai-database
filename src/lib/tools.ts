import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages";
import type pg from "pg";
import { z } from "zod";
import { audit } from "./audit";
import { config } from "./config";
import { inTransaction, readPool, readQuery, writePool } from "./db";
import { toTableResult, type TableResult } from "./results";
import { checkSelect, checkWrite, SqlGuardError, withReturning, type WriteOp } from "./sqlGuard";

/**
 * The tools Claude can call. Reads run immediately; writes only produce a
 * preview here and wait for a person to approve them (see agent.ts).
 */

// Kept in a fixed order: the tool list is part of the cached prompt prefix.
export const toolDefinitions: BetaTool[] = [
  {
    name: "list_tables",
    description:
      "List the tables and views in the database with approximate row counts. " +
      "Use this when the schema summary in the system prompt is missing or only lists names.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "describe_table",
    description:
      "Show one table's columns and types, constraints, indexes and 3 sample rows. " +
      "Call it before writing SQL against a table whose columns or values you are unsure about.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: 'Table name, optionally schema-qualified, e.g. "orders" or "sales.orders".' },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
  {
    name: "run_select",
    description:
      "Run one read-only SQL SELECT (PostgreSQL dialect) and get the rows back. " +
      `At most ${config.maxSelectRows} rows are returned, so aggregate or filter in SQL rather than fetching everything. ` +
      "The rows are shown to the user as a table, so there is no need to repeat them in full. " +
      "It cannot change data. For INSERT/UPDATE/DELETE use propose_write.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_write",
    description:
      "Propose one INSERT, UPDATE or DELETE. It is dry-run first to show the user the affected rows, " +
      "and only runs if the user approves it. The result says whether it was approved, rejected or failed. " +
      "UPDATE and DELETE need a WHERE clause. " +
      `Changes touching more than ${config.maxWriteRows} rows are refused. Schema changes (DDL) are not allowed.`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single INSERT, UPDATE or DELETE statement." },
        summary: {
          type: "string",
          description: 'One sentence in plain language for the approval prompt, e.g. "Set the price of Wireless Mouse to 24.99".',
        },
      },
      required: ["sql", "summary"],
      additionalProperties: false,
    },
  },
];

export const inputSchemas = {
  list_tables: z.object({}).strict(),
  describe_table: z.object({ table: z.string().min(1).max(200) }).strict(),
  run_select: z.object({ sql: z.string().min(1).max(20_000) }).strict(),
  propose_write: z.object({ sql: z.string().min(1).max(20_000), summary: z.string().min(1).max(500) }).strict(),
};

export type ToolName = keyof typeof inputSchemas;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(inputSchemas, name);
}

/** What a tool call produced: text for Claude, plus optional data for the UI. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
  table?: TableResult;
}

function errorOutcome(err: unknown): ToolOutcome {
  if (err instanceof SqlGuardError) return { content: `Not allowed: ${err.message}`, isError: true };
  const pgErr = err as pg.DatabaseError;
  if (pgErr && typeof pgErr === "object" && "code" in pgErr && pgErr.code) {
    const detail = [pgErr.detail, pgErr.hint && `Hint: ${pgErr.hint}`].filter(Boolean).join(" ");
    return { content: `Database error ${pgErr.code}: ${pgErr.message}${detail ? ` (${detail})` : ""}`, isError: true };
  }
  return { content: `Error: ${(err as Error)?.message ?? String(err)}`, isError: true };
}

function tableOutcome(table: TableResult): ToolOutcome {
  return { content: JSON.stringify(table), isError: false, table };
}

/** Run a query in array mode, as the extended protocol (one statement only). */
function arrayQuery(client: pg.PoolClient, text: string, values: unknown[] = []) {
  return client.query<unknown[]>({ text, values, rowMode: "array", queryMode: "extended" } as pg.QueryArrayConfig);
}

export async function listTables(): Promise<ToolOutcome> {
  const rows = await readQuery<{ table: string; kind: string; estimated_rows: string | null }>(`
    SELECT n.nspname || '.' || c.relname AS table,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                          WHEN 'f' THEN 'foreign table' ELSE 'table' END AS kind,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY 1`);
  return { content: JSON.stringify(rows), isError: false };
}

export async function describeTable(table: string): Promise<ToolOutcome> {
  return inTransaction<ToolOutcome>(readPool(), { readOnly: true }, async (client) => {
    // to_regclass parses the name like Postgres does (quoting, search_path) and
    // returns NULL instead of raising for an unknown table.
    const found = await client.query<{ oid: number; name: string }>(
      "SELECT oid::int AS oid, oid::regclass::text AS name FROM pg_class WHERE oid = to_regclass($1)",
      [table],
    );
    if (found.rows.length === 0) {
      return { commit: false, value: { content: `No table or view named "${table}".`, isError: true } };
    }
    const { oid, name } = found.rows[0];

    const columns = await client.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default,
              col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [oid],
    );
    const constraints = await client.query(
      "SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1 ORDER BY conname",
      [oid],
    );
    const indexes = await client.query(
      "SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = $1",
      [oid],
    );
    const comment = await client.query("SELECT obj_description($1::oid, 'pg_class') AS comment", [oid]);

    // `name` comes from Postgres itself (regclass output), so it is safely quoted.
    const sample = await arrayQuery(client, `SELECT * FROM ${name} LIMIT 3`);
    const sampleTable = toTableResult(sample.fields, sample.rows, { maxRows: 3, maxBytes: 8_000 });

    const description = {
      table: name,
      comment: comment.rows[0]?.comment ?? null,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows.map((r) => r.definition),
      sample_rows: sampleTable,
    };
    return { commit: false, value: { content: JSON.stringify(description), isError: false } };
  });
}

export async function runSelect(sql: string, conversationId: string): Promise<ToolOutcome> {
  const started = Date.now();
  try {
    const checked = await checkSelect(sql);
    const table = await inTransaction(readPool(), { readOnly: true }, async (client) => {
      // A cursor fetches only the rows we keep, and leaves the query itself
      // untouched (no rewriting to add a LIMIT).
      await client.query({ text: `DECLARE ai_select NO SCROLL CURSOR FOR ${checked.sql}`, queryMode: "extended" } as pg.QueryConfig);
      const fetched = await arrayQuery(client, `FETCH ${config.maxSelectRows + 1} FROM ai_select`);
      const value = toTableResult(fetched.fields, fetched.rows, {
        maxRows: config.maxSelectRows,
        maxBytes: config.maxResultBytes,
      });
      return { commit: false, value };
    });
    await audit({ kind: "select", conversationId, sql, ok: true, rowCount: table.rowCount, ms: Date.now() - started });
    return tableOutcome(table);
  } catch (err) {
    const outcome = errorOutcome(err);
    await audit({ kind: "select", conversationId, sql, ok: false, error: outcome.content, ms: Date.now() - started });
    return outcome;
  }
}

/** A write that passed the checks and dry run, waiting for the user's decision. */
export interface WritePreview {
  sql: string;
  executableSql: string;
  op: WriteOp;
  table: string;
  summary: string;
  affectedRows: number;
  rows: TableResult;
  /** Tables whose rows a DELETE would also remove through ON DELETE CASCADE. */
  cascadesTo: string[];
}

export type PreviewResult = { ok: true; preview: WritePreview } | { ok: false; outcome: ToolOutcome };

/** Tables with a foreign key to `table` that deletes their rows too (ON DELETE CASCADE). */
async function cascadingTables(table: string): Promise<string[]> {
  const rows = await readQuery<{ name: string }>(
    `SELECT DISTINCT conrelid::regclass::text AS name FROM pg_constraint
     WHERE contype = 'f' AND confdeltype = 'c' AND confrelid = to_regclass($1) ORDER BY 1`,
    [table],
  );
  return rows.map((r) => r.name);
}

/**
 * Validate a proposed write and dry-run it inside a transaction that is always
 * rolled back, to count and show the rows it would touch.
 */
export async function previewWrite(sql: string, summary: string, conversationId: string): Promise<PreviewResult> {
  try {
    const checked = await checkWrite(sql);
    const executableSql = await withReturning(checked);
    const result = await inTransaction(writePool(), {}, async (client) => {
      const res = await arrayQuery(client, executableSql);
      return { commit: false, value: res };
    });
    const affectedRows = result.rowCount ?? 0;
    if (affectedRows > config.maxWriteRows) {
      const outcome: ToolOutcome = {
        content:
          `Not allowed: this ${checked.op.toUpperCase()} would affect ${affectedRows} rows, over the limit of ${config.maxWriteRows}. ` +
          "Narrow the WHERE clause, or split it into smaller changes.",
        isError: true,
      };
      await audit({ kind: "write_proposed", conversationId, sql, ok: false, rowCount: affectedRows, error: outcome.content });
      return { ok: false, outcome };
    }
    const rows = toTableResult(result.fields, result.rows, { maxRows: 20, maxBytes: 20_000 });
    const cascadesTo = checked.op === "delete" && affectedRows > 0 ? await cascadingTables(checked.table) : [];
    await audit({ kind: "write_proposed", conversationId, sql, ok: true, rowCount: affectedRows });
    return {
      ok: true,
      preview: { sql: checked.sql, executableSql, op: checked.op, table: checked.table, summary, affectedRows, rows, cascadesTo },
    };
  } catch (err) {
    const outcome = errorOutcome(err);
    await audit({ kind: "write_proposed", conversationId, sql, ok: false, error: outcome.content });
    return { ok: false, outcome };
  }
}

/**
 * Run an approved write for real. If the number of affected rows no longer
 * matches the preview (the data changed in between), it is rolled back.
 */
export async function executeWrite(preview: WritePreview, conversationId: string): Promise<ToolOutcome> {
  try {
    const outcome = await inTransaction<ToolOutcome>(writePool(), {}, async (client) => {
      const res = await arrayQuery(client, preview.executableSql);
      const affected = res.rowCount ?? 0;
      if (affected !== preview.affectedRows) {
        return {
          commit: false,
          value: {
            content:
              `The user approved it, but it was NOT applied: it would now affect ${affected} rows instead of the ` +
              `${preview.affectedRows} shown in the preview, so the data changed in the meantime. Nothing was changed.`,
            isError: true,
          },
        };
      }
      const table = toTableResult(res.fields, res.rows, { maxRows: 20, maxBytes: 20_000 });
      return {
        commit: true,
        value: {
          content: JSON.stringify({ status: "approved_and_applied", affected_rows: affected, returned: table }),
          isError: false,
          table,
        } satisfies ToolOutcome,
      };
    });
    await audit({
      kind: "write_decision",
      conversationId,
      sql: preview.sql,
      decision: "approved",
      ok: !outcome.isError,
      rowCount: preview.affectedRows,
      error: outcome.isError ? outcome.content : undefined,
    });
    return outcome;
  } catch (err) {
    const outcome = errorOutcome(err);
    await audit({ kind: "write_decision", conversationId, sql: preview.sql, decision: "approved", ok: false, error: outcome.content });
    return { ...outcome, content: `The user approved it, but it failed and nothing was changed. ${outcome.content}` };
  }
}

export async function rejectWrite(preview: WritePreview, conversationId: string, reason?: string): Promise<ToolOutcome> {
  await audit({ kind: "write_decision", conversationId, sql: preview.sql, decision: "rejected", ok: true });
  const why = reason ? ` Reason given: ${reason}` : "";
  return { content: `The user rejected this change, so nothing was changed.${why}`, isError: false };
}

/** Run a read-only tool. propose_write is handled by the agent loop. */
export async function runReadTool(name: Exclude<ToolName, "propose_write">, input: unknown, conversationId: string): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_tables":
        return await listTables();
      case "describe_table":
        return await describeTable(inputSchemas.describe_table.parse(input).table);
      case "run_select":
        return await runSelect(inputSchemas.run_select.parse(input).sql, conversationId);
    }
  } catch (err) {
    return errorOutcome(err);
  }
}
