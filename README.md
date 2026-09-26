# ai-database

A chat agent for your Postgres database. Ask questions in plain English and it
writes and runs the SQL, then shows the answer with the result table. Ask for a
change and it drafts the `INSERT` / `UPDATE` / `DELETE`, dry-runs it, and shows
you exactly which rows it would touch. **Nothing changes until you click
Approve.**

Built with Next.js, TypeScript, [`pg`](https://node-postgres.com/) and Claude
(`claude-opus-5`) through the Anthropic SDK.

## Quick start

Requires Node 20.9+, pnpm, and a Postgres database.

```bash
pnpm install
cp .env.example .env.local        # then set ANTHROPIC_API_KEY and DATABASE_URL
pnpm dev                          # http://localhost:3000
```

No database handy? Start the demo one (a small online shop: customers,
products, orders, order_items):

```bash
docker compose up -d              # Postgres on :5432 with the demo data loaded
# DATABASE_URL=postgres://agent:agent@localhost:5432/shop
```

Then try: *"Who are our top 3 customers by total spend?"*, *"Which products
are out of stock?"*, *"Restock the webcam to 25 units"*.

## How it works

```
Browser chat ──SSE──▶ /api/chat ──▶ agent loop ──▶ Claude (streaming, tool use)
                                        │
                                        ├─ list_tables / describe_table ─┐
                                        ├─ run_select ───────────────────┼─▶ Postgres
                                        └─ propose_write ─▶ dry run ─────┘
                                                              │
                                   pauses, shows preview ◀────┘
Approve / Reject ──▶ /api/chat/:id/decision ──▶ runs (or not), loop resumes
```

- **Schema awareness.** At startup the agent introspects the database into a
  compact summary: tables, columns, types, keys and foreign keys. The summary goes
  into the prompt, and the prompt is cached, so later turns are faster and
  cheaper. Very large schemas are summarized as table names only, and the agent
  calls `describe_table` as needed. After a migration, `POST /api/schema`
  reloads the summary.
- **Tools** (`src/lib/tools.ts`):
  - `list_tables` returns tables and views with row estimates.
  - `describe_table` returns columns, constraints, indexes, and 3 sample rows.
  - `run_select` runs a single SELECT and returns at most `MAX_SELECT_ROWS` rows.
  - `propose_write` handles one INSERT/UPDATE/DELETE and waits for approval.
- **Streaming UI.** The reply streams as it's written. Every query shows its SQL
  (collapsed) and its result table. A write appears as an approval card with a
  preview of the affected rows.

## Safety model

Several layers stand between the model and your data:

1. **SQL is parsed, not pattern-matched.** `src/lib/sqlGuard.ts` uses the real
   Postgres parser (`libpg-query`) and allows exactly one statement:
   - `run_select` accepts only `SELECT`. It rejects `SELECT … INTO`, `FOR UPDATE`,
     and data-modifying CTEs.
   - `propose_write` accepts only `INSERT` / `UPDATE` / `DELETE`. `UPDATE` and
     `DELETE` must have a `WHERE` clause.
   - DDL, `TRUNCATE`, `COPY`, `MERGE` and `SET` are refused.
   - Functions with side effects outside the transaction are refused: `pg_sleep`,
     `pg_terminate_backend`, `pg_read_file`, `dblink`, `lo_*`, `set_config`,
     `nextval`/`setval`, and `query_to_xml` and similar (they run SQL strings).
2. **Reads run in `BEGIN READ ONLY` transactions** with a statement timeout.
   They use the extended query protocol, which also refuses multiple statements.
   Rows come through a cursor, so a huge table costs only the rows actually
   returned.
3. **Writes are previewed, then approved:**
   - The preview runs the statement in a transaction that is always rolled back.
     It captures the affected row count and the rows (`RETURNING *`).
   - Changes over `MAX_WRITE_ROWS` rows are refused outright.
   - A DELETE preview warns when `ON DELETE CASCADE` will remove rows in other
     tables.
   - On approval the statement runs again in a transaction. If the row count
     differs from the preview (someone changed the data in the meantime), it is
     rolled back and nothing is applied.
4. **Audit log.** Every query, proposal and decision is appended to
   `logs/audit.jsonl`.
5. **Least-privilege database role (recommended).** Point `DATABASE_URL` at a
   role that can only read and write rows, so even a bug in the layers above
   cannot change the schema:

   ```sql
   CREATE ROLE ai_agent LOGIN PASSWORD '…';
   GRANT USAGE ON SCHEMA public TO ai_agent;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_agent;
   GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ai_agent;
   -- optional read-only role for DATABASE_URL_READONLY:
   CREATE ROLE ai_agent_ro LOGIN PASSWORD '…';
   GRANT USAGE ON SCHEMA public TO ai_agent_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_agent_ro;
   ```

   Leave out tables the agent should never see or touch. They also drop out
   of its schema summary.

The dry run executes the statement for real before rolling it back, so it can
advance sequences and fire triggers. Triggers that call out to external systems
would fire during the preview.

**The web UI has no login.** Run it only on a trusted network, or put
authentication in front of it before exposing it. Anyone who can open it can
read your data and propose changes.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `DATABASE_URL` | (required) | Postgres connection used for writes (and reads, unless the next one is set) |
| `DATABASE_URL_READONLY` | none | Separate read-only connection for SELECTs and introspection |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Claude model |
| `MAX_SELECT_ROWS` | `200` | Rows returned per query |
| `MAX_RESULT_BYTES` | `50000` | Size cap for one result sent to the model |
| `MAX_WRITE_ROWS` | `100` | Largest change that can be proposed |
| `STATEMENT_TIMEOUT_MS` | `10000` | Per-statement timeout |
| `MAX_TOOL_ITERATIONS` | `15` | Model round-trips per message before stopping |
| `AUDIT_LOG_PATH` | `logs/audit.jsonl` | Audit log file |

Requests use adaptive thinking and streaming, and set `fallbacks: "default"`.
If the primary model's safety classifier declines a request, Anthropic
re-runs it on its recommended fallback model instead of returning a refusal.

## Development

```bash
pnpm typecheck && pnpm lint
TEST_DATABASE_URL=postgres://agent:agent@localhost:5432/shop_test pnpm test
```

`tests/sqlGuard.test.ts` needs no database. `tests/tools.test.ts` and
`tests/agent.test.ts` run against `TEST_DATABASE_URL` and skip without it.
Each test **drops and reloads the demo tables** in that database, so use a
throwaway one (docker compose creates `shop_test`). The agent tests drive the
full loop, including pause, approve and resume, with a scripted stand-in for
the Claude API, so they need no API key.

Layout:

```
src/lib/agent.ts      agent loop, prompt, pause/resume for approvals
src/lib/tools.ts      tool definitions and executors
src/lib/sqlGuard.ts   SQL parsing and allow-rules
src/lib/schema.ts     schema introspection → prompt summary
src/lib/db.ts         connection pools and transactions
src/lib/store.ts      conversation store (in memory)
src/app/api/…         chat, decision and schema endpoints (SSE)
src/components/…      chat UI
db/seed.sql           demo schema and data
```

## Limitations and next steps

- Conversations live in server memory. They are lost on restart and are not
  shared across multiple server instances. `ConversationStore` in `store.ts` is
  the seam for a Redis- or Postgres-backed store.
- No authentication or per-user permissions in the UI.
- Postgres only. Another engine (MySQL, SQLite) would need its own guard and
  introspection.
- No schema changes through the agent, by design.
