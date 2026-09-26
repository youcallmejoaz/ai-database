# ai-database

**Talk to your Postgres database in plain English, safely.**

An AI agent that answers questions about your data by writing and running SQL,
and makes changes only after you've seen exactly which rows they touch and
clicked **Approve**.

![Next.js](https://img.shields.io/badge/Next.js-16-000?logo=nextdotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-any-4169e1?logo=postgresql&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Opus%205-d97757)
![Tests](https://img.shields.io/badge/tests-31%20passing-2ea44f)

<p align="center">
  <img src="docs/media/demo.gif" alt="Asking for the top customers, then restocking a product: the agent proposes an UPDATE, shows the affected row, and applies it after approval" width="880">
</p>

## Highlights

- **Plain-English answers, backed by real SQL.** Every answer shows the query
  it ran and the result table, so you can check its work.
- **Human-in-the-loop writes.** A change is dry-run first. You see the rows it
  would touch, a warning if a delete cascades to other tables, and Approve /
  Reject buttons. Nothing is written until you approve.
- **Guardrails that parse, not pattern-match.** SQL goes through the real
  Postgres parser. Mass updates, schema changes, and dangerous functions are
  blocked before they reach the database.
- **Built for real use.** It streams responses, keeps the schema in a cached
  prompt, adapts to your schema automatically, logs every action to an audit
  log, and works on phones and in dark mode.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/media/conversation.png" alt="A question answered with a result table, followed by an approved stock update"></td>
    <td width="50%"><img src="docs/media/approval-card.png" alt="Approval card for a DELETE, warning that related order_items rows will also be deleted"></td>
  </tr>
  <tr>
    <td><b>Ask, then act.</b> The answer comes with the SQL and data behind it. The stock update was applied only after approval.</td>
    <td><b>See before you change.</b> The preview shows the exact rows affected and warns about <code>ON DELETE CASCADE</code>.</td>
  </tr>
  <tr>
    <td><img src="docs/media/guardrail.png" alt="A request to delete all customers is blocked because the DELETE has no WHERE clause"></td>
    <td><img src="docs/media/dark-mode.png" alt="Revenue by category in dark mode"></td>
  </tr>
  <tr>
    <td><b>Guardrails.</b> "Delete all customers" is refused before it reaches the database.</td>
    <td><b>Dark mode</b>, following the system setting.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/media/mobile.png" alt="The chat on a phone, listing an out-of-stock product" width="300">
</p>

> The screenshots and GIF use the bundled demo shop database. The assistant's
> wording in them comes from [`scripts/demo-claude.mjs`](scripts/demo-claude.mjs),
> a scripted stand-in for the Claude API, so the demo runs without an API key.
> Everything else is the real app: the agent loop, SQL checks, Postgres
> queries, previews and UI. Run `pnpm media` against real Claude to re-shoot
> them.

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

### Try it without an API key

```bash
pnpm demo:claude                  # scripted Claude stand-in on :4010
ANTHROPIC_BASE_URL=http://localhost:4010 ANTHROPIC_API_KEY=demo pnpm dev
```

Then click the example questions, or ask *"Restock the HD webcam to 25 units"*
or *"Remove the cancelled order 4"*. The demo only knows these scripted
questions. With a real key, you can ask anything.

## How it works

```mermaid
sequenceDiagram
    actor U as You
    participant UI as Chat UI
    participant A as Agent loop
    participant C as Claude
    participant G as SQL guard
    participant DB as Postgres

    U->>UI: "Restock the HD webcam to 25 units"
    UI->>A: POST /api/chat (streamed back as SSE)
    A->>C: conversation + cached schema + tools
    C-->>A: propose_write(UPDATE products …)
    A->>G: parse: one UPDATE, has WHERE, no blocked functions
    A->>DB: BEGIN, run with RETURNING *, ROLLBACK (dry run)
    A-->>UI: preview: 1 row, before you decide
    Note over A: turn paused, tool call left open
    U->>UI: Approve
    UI->>A: POST /api/chat/:id/decision
    A->>DB: BEGIN, run, check row count matches preview, COMMIT
    A->>C: tool result: applied
    C-->>UI: "Done. The HD Webcam now has 25 units…"
```

- **Tools** (`src/lib/tools.ts`):
  - `list_tables` returns tables and views with row estimates.
  - `describe_table` returns columns, constraints, indexes, and 3 sample rows.
  - `run_select` runs a single read-only SELECT.
  - `propose_write` handles one INSERT/UPDATE/DELETE and waits for approval.
- **Schema awareness.** At startup the agent introspects the database into a
  compact summary: tables, columns, types, keys and foreign keys. The summary
  goes into the prompt as a cached block, so later turns are faster and cheaper.
  Very large schemas are summarized as table names only, and the agent calls
  `describe_table` as needed. `POST /api/schema` reloads the summary after a
  migration.

## Engineering decisions

- **Pausing the agent loop for approval.** The loop is hand-written around
  `client.messages.stream()`, not a helper that runs to completion. Approval
  arrives in a *different HTTP request*, so the loop has to stop at
  `propose_write`, keep the open tool call, and resume when the decision
  comes in. History is append-only: earlier messages are never edited, which
  keeps the prompt cache valid.
- **Parse SQL instead of matching it with regexes.** A regex can't reliably
  tell `DELETE` inside a string literal from a data-modifying CTE.
  `libpg-query` is the actual Postgres parser compiled to WASM, so the guard
  sees what the database will see.
- **Defense in depth.** The parser check is the first layer, not the only one.
  Reads run inside `READ ONLY` transactions with the extended protocol, which
  refuses a second statement. Writes are capped by row count. A least-privilege
  database role is recommended as the final layer (below).
- **Catching drift between preview and approval.** Someone can change the
  data while you're reading the preview. So the approved statement runs again
  and is committed only if it touches the same number of rows the preview
  showed. Otherwise it rolls back and tells the model why.
- **Testable without an API key.** The Anthropic client is injected, so the
  tests drive the full pause → approve → resume flow against a real Postgres
  with a scripted client. The same idea powers the keyless demo.

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

## Hosted databases (Render, Supabase, Neon, …)

- Use the **external** connection URL. Internal URLs (such as Render's
  internal database URL) only resolve for services running inside that
  provider's network, so they don't work locally or on another host.
- These providers require SSL, so add `sslmode` to the URL:
  `…/dbname?sslmode=verify-full`. node-postgres treats `sslmode=require` as
  `verify-full`. If the connection fails with a certificate error, use
  `sslmode=no-verify`: traffic is still encrypted, but the server certificate
  isn't checked.
- Keep the URL in `.env.local` (git-ignored). If the database also backs a live
  app, connect with the restricted role described in [Safety model](#safety-model),
  not the owner account.

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

To re-record the screenshots and GIF in `docs/media` (the app must be running;
`DEMO_DATABASE_URL` reloads the demo tables before each scene):

```bash
APP_URL=http://localhost:3000 DEMO_DATABASE_URL=postgres://agent:agent@localhost:5432/shop pnpm media
```

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
scripts/              keyless demo server and screenshot/GIF capture
```

## Limitations and next steps

- Conversations live in server memory. They are lost on restart and are not
  shared across multiple server instances. `ConversationStore` in `store.ts` is
  the seam for a Redis- or Postgres-backed store.
- No authentication or per-user permissions in the UI.
- Postgres only. Another engine (MySQL, SQLite) would need its own guard and
  introspection.
- No schema changes through the agent, by design.
