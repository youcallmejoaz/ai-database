/** Runtime settings, read from the environment once per process. */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export const config = {
  model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
  /** Rows returned by one run_select call before the result is marked truncated. */
  maxSelectRows: intFromEnv("MAX_SELECT_ROWS", 200),
  /** Serialized size cap (bytes) for one tool result sent back to Claude. */
  maxResultBytes: intFromEnv("MAX_RESULT_BYTES", 50_000),
  /** A proposed write that would touch more rows than this is refused. */
  maxWriteRows: intFromEnv("MAX_WRITE_ROWS", 100),
  statementTimeoutMs: intFromEnv("STATEMENT_TIMEOUT_MS", 10_000),
  /** Model round-trips allowed per user turn before the agent stops. */
  maxToolIterations: intFromEnv("MAX_TOOL_ITERATIONS", 15),
  auditLogPath: process.env.AUDIT_LOG_PATH || "logs/audit.jsonl",
};

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  return url;
}

/** Optional separate connection (e.g. a read-only role) for SELECTs and introspection. */
export function readDatabaseUrl(): string {
  return process.env.DATABASE_URL_READONLY || databaseUrl();
}
