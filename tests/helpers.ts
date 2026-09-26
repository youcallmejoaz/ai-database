import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

/** Connection string for the throwaway test database; tests that need it skip without it. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

/** Reload the demo schema and data so each test starts from the same state. */
export async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET client_min_messages = warning");
    await client.query(readFileSync(path.resolve(import.meta.dirname, "../db/seed.sql"), "utf8"));
  } finally {
    await client.end();
  }
}

export async function queryOne<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows[0] as T;
  } finally {
    await client.end();
  }
}
