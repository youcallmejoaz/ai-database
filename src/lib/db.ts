import pg from "pg";
import { config, databaseUrl, readDatabaseUrl } from "./config";

type Pools = { write?: pg.Pool; read?: pg.Pool };

// Keep pools on globalThis so Next.js dev reloads don't leak connections.
const pools: Pools = ((globalThis as { __aiDbPools?: Pools }).__aiDbPools ??= {});

function makePool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}

export function writePool(): pg.Pool {
  return (pools.write ??= makePool(databaseUrl()));
}

export function readPool(): pg.Pool {
  if (!process.env.DATABASE_URL_READONLY) return writePool();
  return (pools.read ??= makePool(readDatabaseUrl()));
}

export interface TxOptions {
  readOnly?: boolean;
  timeoutMs?: number;
}

/**
 * Run `fn` inside a transaction with a statement timeout. `fn` returns whether
 * to commit; anything else (including a thrown error) rolls back.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  opts: TxOptions,
  fn: (client: pg.PoolClient) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    // SET does not accept bind parameters; the value is a validated integer.
    const timeout = Math.floor(opts.timeoutMs ?? config.statementTimeoutMs);
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    const { commit, value } = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only query helper for introspection. */
export async function readQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  return inTransaction(readPool(), { readOnly: true }, async (client) => {
    const result = await client.query<R>(text, values);
    return { commit: false, value: result.rows };
  });
}
