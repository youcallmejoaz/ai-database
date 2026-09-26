"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent";
import type { TableResult } from "@/lib/results";
import { Markdown } from "./Markdown";
import { ResultTable } from "./ResultTable";
import { postForEvents } from "./sse";

type ToolPart = {
  type: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { isError: boolean; content: string; table?: TableResult };
};

type WritePart = {
  type: "write";
  id: string;
  summary: string;
  sql: string;
  op: string;
  table: string;
  affectedRows: number;
  rows: TableResult;
  cascadesTo: string[];
  decision?: { approved: boolean; isError: boolean; content: string; table?: TableResult };
};

type Part = { type: "text"; text: string } | { type: "error"; message: string } | ToolPart | WritePart;

type Item = { role: "user"; text: string } | { role: "assistant"; parts: Part[] };

const EXAMPLES = [
  "Which tables are in this database?",
  "Who are our top 3 customers by total spend?",
  "Which products are out of stock?",
  "Mark order 7 as paid",
];

/** Apply one streamed event to the parts of the assistant message being built. */
function applyEvent(parts: Part[], event: AgentEvent): Part[] {
  switch (event.type) {
    case "text": {
      const last = parts.at(-1);
      if (last?.type === "text") return [...parts.slice(0, -1), { ...last, text: last.text + event.delta }];
      return [...parts, { type: "text", text: event.delta }];
    }
    case "tool_call":
      if (event.name === "propose_write") return parts; // shown as an approval card instead
      return [...parts, { type: "tool", id: event.id, name: event.name, input: (event.input ?? {}) as Record<string, unknown> }];
    case "tool_result": {
      const exists = parts.some((p) => p.type === "tool" && p.id === event.id);
      const result = { isError: event.isError, content: event.content, table: event.table };
      if (!exists) {
        // A rejected write proposal (e.g. too many rows) comes back as a tool result.
        return [...parts, { type: "tool", id: event.id, name: event.name, input: {}, result }];
      }
      return parts.map((p) => (p.type === "tool" && p.id === event.id ? { ...p, result } : p));
    }
    case "pending_write":
      return [...parts, { ...event, type: "write" }];
    case "write_result":
      return parts.map((p) =>
        p.type === "write" && p.id === event.id
          ? { ...p, decision: { approved: event.approved, isError: event.isError, content: event.content, table: event.table } }
          : p,
      );
    case "error":
      return [...parts, { type: "error", message: event.message }];
    default:
      return parts;
  }
}

function ToolCall({ part }: { part: ToolPart }) {
  const sql = typeof part.input.sql === "string" ? part.input.sql : undefined;
  const label =
    part.name === "run_select"
      ? "Ran a query"
      : part.name === "describe_table"
        ? `Looked at ${String(part.input.table ?? "a table")}`
        : part.name === "list_tables"
          ? "Listed tables"
          : part.name === "propose_write"
            ? "Proposed change was refused"
            : part.name;
  const running = !part.result;
  return (
    <div className={`tool ${part.result?.isError ? "tool-error" : ""}`}>
      <details open={Boolean(part.result?.isError && part.name === "propose_write")}>
        <summary>
          <span className={`dot ${running ? "dot-running" : part.result?.isError ? "dot-error" : "dot-ok"}`} aria-hidden />
          {label}
          {running && <span className="muted"> …</span>}
          {part.result?.isError && <span className="muted"> (error)</span>}
        </summary>
        {sql && <pre className="sql">{sql}</pre>}
        {part.result && !part.result.table && <pre className="tool-output">{part.result.content}</pre>}
      </details>
      {part.result?.table && <ResultTable result={part.result.table} />}
    </div>
  );
}

function WriteCard({
  part,
  busy,
  onDecide,
}: {
  part: WritePart;
  busy: boolean;
  onDecide: (part: WritePart, approve: boolean) => void;
}) {
  const verb = part.op === "insert" ? "insert" : part.op === "update" ? "change" : "delete";
  return (
    <div className={`write-card ${part.decision ? "decided" : ""}`}>
      <div className="write-head">
        <span className={`badge badge-${part.op}`}>{part.op.toUpperCase()}</span>
        <strong>{part.summary}</strong>
      </div>
      <p className="muted">
        This will {verb} {part.affectedRows} row{part.affectedRows === 1 ? "" : "s"} in <code>{part.table}</code>.
        {part.op === "delete" ? " These are the rows that would be removed:" : " Preview of the result:"}
      </p>
      <ResultTable result={part.rows} />
      {part.cascadesTo.length > 0 && (
        <p className="cascade">
          Related rows in {part.cascadesTo.map((t, i) => <code key={t}>{i > 0 ? ", " : ""}{t}</code>)} will also be deleted
          (ON DELETE CASCADE).
        </p>
      )}
      <details>
        <summary>SQL</summary>
        <pre className="sql">{part.sql}</pre>
      </details>
      {part.decision ? (
        <p className={`decision ${part.decision.approved && !part.decision.isError ? "ok" : "no"}`}>
          {part.decision.approved
            ? part.decision.isError
              ? "Approved, but it was not applied. See the reply below."
              : "Approved and applied."
            : "Rejected. Nothing was changed."}
        </p>
      ) : (
        <div className="write-actions">
          <button className="btn-approve" disabled={busy} onClick={() => onDecide(part, true)}>
            Approve and run
          </button>
          <button className="btn-reject" disabled={busy} onClick={() => onDecide(part, false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function Chat() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const conversationId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, status]);

  const updateAssistant = (fn: (parts: Part[]) => Part[]) =>
    setItems((prev) => {
      const last = prev.at(-1);
      if (last?.role === "assistant") return [...prev.slice(0, -1), { role: "assistant", parts: fn(last.parts) }];
      return [...prev, { role: "assistant", parts: fn([]) }];
    });

  /** Stream a request and fold its events into the latest assistant message. */
  async function run(url: string, body: unknown) {
    setBusy(true);
    setStatus("Working…");
    const controller = new AbortController();
    abort.current = controller;
    try {
      await postForEvents(
        url,
        body,
        (event) => {
          if (event.type === "conversation") conversationId.current = event.id;
          else if (event.type === "status") setStatus(event.status === "thinking" ? "Thinking…" : "Querying the database…");
          else if (event.type === "text") setStatus(null);
          else if (event.type === "pending_write") setStatus(null);
          else if (event.type === "done") setStatus(null);
          if (event.type === "write_result") {
            // The card may sit in an earlier message (a new message rejects a pending change).
            setItems((prev) => prev.map((it) => (it.role === "assistant" ? { ...it, parts: applyEvent(it.parts, event) } : it)));
            return;
          }
          updateAssistant((parts) => applyEvent(parts, event));
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        updateAssistant((parts) => [...parts, { type: "error", message: (err as Error).message }]);
      }
    } finally {
      setBusy(false);
      setStatus(null);
      abort.current = null;
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setItems((prev) => [...prev, { role: "user", text: message }, { role: "assistant", parts: [] }]);
    await run("/api/chat", { conversationId: conversationId.current, message });
  }

  async function decide(part: WritePart, approve: boolean) {
    if (!conversationId.current || busy) return;
    await run(`/api/chat/${conversationId.current}/decision`, { toolUseId: part.id, approve });
  }

  function newChat() {
    abort.current?.abort();
    conversationId.current = undefined;
    setItems([]);
    setInput("");
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Database Agent</h1>
        <button className="btn-ghost" onClick={newChat} disabled={items.length === 0}>
          New chat
        </button>
      </header>

      <main className="thread" aria-live="polite">
        {items.length === 0 && (
          <div className="empty">
            <p>Ask about your data in plain English. Reads run right away; changes wait for your approval.</p>
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button key={example} className="chip" onClick={() => send(example)}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item, i) =>
          item.role === "user" ? (
            <div key={i} className="msg msg-user">
              {item.text}
            </div>
          ) : (
            <div key={i} className="msg msg-assistant">
              {item.parts.map((part, j) => {
                if (part.type === "text") return <Markdown key={j} text={part.text} />;
                if (part.type === "error") return <p key={j} className="error">{part.message}</p>;
                if (part.type === "tool") return <ToolCall key={part.id} part={part} />;
                return <WriteCard key={part.id} part={part} busy={busy} onDecide={decide} />;
              })}
              {i === items.length - 1 && status && <p className="status">{status}</p>}
            </div>
          ),
        )}
        <div ref={bottom} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask a question or describe a change…"
          rows={1}
          aria-label="Message"
        />
        {busy ? (
          <button type="button" className="btn-ghost" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn-send" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
