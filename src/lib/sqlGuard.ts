import { parse } from "libpg-query";

/**
 * Parses model-written SQL with the real Postgres parser and decides whether
 * it may run. This is the first safety layer; the second is that SELECTs run in
 * a READ ONLY transaction and writes only run after a person approves them.
 */

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

export type WriteOp = "insert" | "update" | "delete";

export interface CheckedSelect {
  sql: string;
}

export interface CheckedWrite {
  sql: string;
  op: WriteOp;
  table: string;
  hasReturning: boolean;
}

type Node = Record<string, unknown>;

const WRITE_NODES: Record<string, WriteOp> = {
  InsertStmt: "insert",
  UpdateStmt: "update",
  DeleteStmt: "delete",
};

// Functions with side effects outside the transaction, or that run arbitrary
// SQL text, which would bypass the checks above.
const BLOCKED_FUNCTION_PREFIXES = ["pg_", "dblink", "lo_"];
const BLOCKED_FUNCTIONS = new Set(["set_config", "setval", "nextval", "currval", "lastval"]);
const ALLOWED_PG_FUNCTIONS = new Set([
  "pg_typeof",
  "pg_size_pretty",
  "pg_relation_size",
  "pg_total_relation_size",
  "pg_table_size",
  "pg_indexes_size",
  "pg_column_size",
]);

function isBlockedFunction(name: string): boolean {
  const lower = name.toLowerCase();
  if (ALLOWED_PG_FUNCTIONS.has(lower)) return false;
  if (BLOCKED_FUNCTIONS.has(lower)) return true;
  if (lower.includes("_to_xml")) return true; // query_to_xml & co. execute a SQL string
  return BLOCKED_FUNCTION_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Depth-first walk over every object node of the parse tree. */
function walk(value: unknown, visit: (key: string, node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Node)) {
    if (child !== null && typeof child === "object") visit(key, child as Node);
    walk(child, visit);
  }
}

function functionName(funcCall: Node): string {
  const parts = (funcCall.funcname as Node[] | undefined) ?? [];
  const last = parts[parts.length - 1] as { String?: { sval?: string } } | undefined;
  return last?.String?.sval ?? "";
}

interface ParsedStatement {
  type: string;
  node: Node;
  /** The statement's own text, without surrounding semicolons or trailing statements. */
  text: string;
}

async function parseSingle(sql: string): Promise<ParsedStatement> {
  if (!sql.trim()) throw new SqlGuardError("The SQL is empty.");
  let tree;
  try {
    tree = await parse(sql);
  } catch (err) {
    throw new SqlGuardError(`SQL does not parse: ${(err as Error).message}`);
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) {
    throw new SqlGuardError(`Send exactly one SQL statement (got ${stmts.length}).`);
  }
  const { stmt, stmt_location: location = 0, stmt_len: length = 0 } = stmts[0];
  if (!stmt) throw new SqlGuardError("The SQL is empty.");
  const [type] = Object.keys(stmt);
  // Offsets are in bytes of the UTF-8 text; a length of 0 means "to the end".
  const bytes = Buffer.from(sql, "utf8");
  const end = length ? location + length : bytes.length;
  const text = bytes.subarray(location, end).toString("utf8").trim();
  return { type, node: (stmt as Node)[type] as Node, text };
}

function rejectBlockedConstructs(root: Node, allowWriteAtTop: boolean): void {
  walk(root, (key, node) => {
    if (key === "FuncCall") {
      const name = functionName(node);
      if (isBlockedFunction(name)) {
        throw new SqlGuardError(`The function ${name}() is not allowed.`);
      }
    }
    if (key in WRITE_NODES || key === "MergeStmt") {
      throw new SqlGuardError(
        allowWriteAtTop
          ? "Nested data-modifying statements (e.g. in a WITH clause) are not allowed."
          : "Only SELECT queries can run here. Use propose_write for changes.",
      );
    }
    if (key === "intoClause") {
      throw new SqlGuardError("SELECT ... INTO creates a table and is not allowed.");
    }
    if (key === "lockingClause") {
      throw new SqlGuardError("Row-locking clauses (FOR UPDATE / FOR SHARE) are not allowed.");
    }
  });
}

function relationName(relation: Node | undefined): string {
  if (!relation) return "?";
  const schema = relation.schemaname as string | undefined;
  const name = relation.relname as string;
  return schema ? `${schema}.${name}` : name;
}

export async function checkSelect(sql: string): Promise<CheckedSelect> {
  const { type, node, text } = await parseSingle(sql);
  if (type !== "SelectStmt") {
    throw new SqlGuardError(
      type in WRITE_NODES
        ? "run_select only runs SELECT queries. Use propose_write for INSERT/UPDATE/DELETE."
        : `Only SELECT queries can run here (got ${type.replace(/Stmt$/, "")}).`,
    );
  }
  rejectBlockedConstructs(node, false);
  return { sql: text };
}

function hasReturningClause(node: Node): boolean {
  // Postgres 18's parser nests the list in returningClause; older ones use returningList.
  const clause = node.returningClause as { exprs?: unknown[] } | undefined;
  const list = clause?.exprs ?? (node.returningList as unknown[] | undefined);
  return Array.isArray(list) && list.length > 0;
}

export async function checkWrite(sql: string): Promise<CheckedWrite> {
  const { type, node, text } = await parseSingle(sql);
  const op = WRITE_NODES[type];
  if (!op) {
    throw new SqlGuardError(
      type === "SelectStmt"
        ? "propose_write is for INSERT/UPDATE/DELETE. Use run_select to read data."
        : `Only INSERT, UPDATE and DELETE can be proposed (got ${type.replace(/Stmt$/, "")}). ` +
            "Schema changes (DDL), TRUNCATE, COPY and MERGE are not allowed.",
    );
  }
  if ((op === "update" || op === "delete") && !node.whereClause) {
    throw new SqlGuardError(
      `${op.toUpperCase()} without a WHERE clause is not allowed. Add a WHERE clause that selects the rows to change.`,
    );
  }
  rejectBlockedConstructs(node, true);
  return {
    sql: text,
    op,
    table: relationName(node.relation as Node | undefined),
    hasReturning: hasReturningClause(node),
  };
}

/**
 * The statement with `RETURNING *` added when it has none, so the preview can
 * show the affected rows. A newline comes first so a trailing `--` comment
 * cannot swallow it, and the result is parsed again to be sure it is still the
 * same single statement.
 */
export async function withReturning(write: CheckedWrite): Promise<string> {
  if (write.hasReturning) return write.sql;
  const sql = `${write.sql}\nRETURNING *`;
  const again = await checkWrite(sql);
  if (again.op !== write.op || !again.hasReturning) {
    throw new SqlGuardError("Could not add RETURNING to this statement; add RETURNING * yourself.");
  }
  return again.sql;
}
