import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages";
import { config } from "./config";
import type { TableResult } from "./results";
import { getSchemaSummary } from "./schema";
import type { Conversation } from "./store";
import {
  executeWrite,
  inputSchemas,
  isToolName,
  previewWrite,
  rejectWrite,
  runReadTool,
  toolDefinitions,
  type ToolOutcome,
  type WritePreview,
} from "./tools";

/**
 * The agent loop. It streams a model turn, runs the tools Claude asks for, and
 * repeats until Claude answers. When Claude proposes a write, the loop stops
 * and waits: the conversation keeps the unanswered tool call, and
 * `decideWrite` supplies its result once the user approves or rejects it.
 * History is only ever appended to, never edited.
 */

export type AgentEvent =
  | { type: "conversation"; id: string }
  | { type: "status"; status: "thinking" | "running_tools" }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; content: string; table?: TableResult }
  | {
      type: "pending_write";
      id: string;
      summary: string;
      sql: string;
      op: WritePreview["op"];
      table: string;
      affectedRows: number;
      rows: TableResult;
      cascadesTo: string[];
    }
  | { type: "write_result"; id: string; approved: boolean; isError: boolean; content: string; table?: TableResult }
  | { type: "error"; message: string }
  | { type: "done" };

export type Emit = (event: AgentEvent) => void;

export interface AgentDeps {
  client: Anthropic;
  getSchema: () => Promise<string>;
  signal?: AbortSignal;
}

let defaultClient: Anthropic | undefined;

export function defaultDeps(signal?: AbortSignal): AgentDeps {
  defaultClient ??= new Anthropic();
  return { client: defaultClient, getSchema: () => getSchemaSummary(), signal };
}

const SYSTEM_PROMPT = `You are a database assistant connected to a live PostgreSQL database. You help people find answers in their data and make careful changes to it.

How to work:
- The schema summary below lists the tables and columns you can use. Rely on it, and call describe_table when you need constraints, defaults or example values (for instance the exact spelling of a status). If the summary says it only lists names, call describe_table before writing SQL against a table.
- Answer questions with run_select. Prefer one well-formed query that aggregates or filters in SQL over fetching many rows.
- To change data, always use propose_write with a single INSERT, UPDATE or DELETE. The user sees a preview of the affected rows and decides; nothing changes until they approve. Look up ids with run_select first, so the WHERE clause targets exactly the intended rows. If the user asks for several changes, propose them one at a time.
- If a query fails, read the error, fix the SQL and try again. If a request is ambiguous (which customer, which date range), ask a short question instead of guessing.
- You cannot change the schema (CREATE/ALTER/DROP/TRUNCATE). Say so if asked.

How to answer:
- Result rows are shown to the user as a table next to your reply, so do not reprint them. Summarize what they show, and mention anything surprising.
- Keep replies short and plain. Use Markdown sparingly.
- After a write, say plainly whether it was applied, rejected or failed.`;

const REFUSAL_TEXT = "I can't help with that request.";

export function buildRequest(messages: BetaMessageParam[], schema: string): BetaMessageStreamParams {
  return {
    model: config.model,
    max_tokens: 64_000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    // Anthropic's recommended fallback model re-runs a request the safety
    // classifiers decline, instead of returning the refusal to the user.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      // The schema only changes on refresh, so it is cached with the prompt.
      { type: "text", text: `<database_schema>\n${schema}\n</database_schema>`, cache_control: { type: "ephemeral" } },
    ],
    tools: toolDefinitions,
    // Also cache the growing conversation between turns.
    cache_control: { type: "ephemeral" },
    messages,
  };
}

/**
 * After a mid-output fallback, blocks the declined model produced before the
 * last `fallback` marker must not be sent back (except text).
 */
export function echoableContent(content: BetaContentBlock[]): BetaContentBlock[] {
  const lastFallback = content.findLastIndex((block) => block.type === "fallback");
  if (lastFallback === -1) return content;
  return content.filter((block, index) => index >= lastFallback || block.type === "text");
}

function toolResult(toolUseId: string, outcome: ToolOutcome): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, content: outcome.content, is_error: outcome.isError || undefined };
}

/**
 * Keep the history valid before new input is added: if the last assistant turn
 * has tool calls without results (the stream was interrupted, or a write is
 * still pending), answer them.
 */
async function settleOpenToolCalls(conversation: Conversation, emit: Emit): Promise<void> {
  if (conversation.pending) {
    const pending = conversation.pending;
    conversation.pending = undefined;
    const outcome = await rejectWrite(pending.preview, conversation.id, "the user sent a new message instead of deciding");
    emit({ type: "write_result", id: pending.toolUseId, approved: false, isError: false, content: outcome.content });
    conversation.messages.push({ role: "user", content: orderedResults(pending.toolUseOrder, pending.otherResults, toolResult(pending.toolUseId, outcome)) });
    return;
  }
  const last = conversation.messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return;
  const open = last.content.filter((block) => block.type === "tool_use");
  if (open.length === 0) return;
  conversation.messages.push({
    role: "user",
    content: open.map((block) =>
      toolResult(block.id, { content: "This tool call was interrupted and did not run.", isError: true }),
    ),
  });
}

function orderedResults(
  order: string[],
  results: BetaToolResultBlockParam[],
  extra?: BetaToolResultBlockParam,
): BetaToolResultBlockParam[] {
  const all = extra ? [...results, extra] : results;
  return order.map((id) => all.find((r) => r.tool_use_id === id)).filter((r) => r !== undefined);
}

/** Add the user's text, joining the trailing tool-result message if there is one. */
function appendUserText(conversation: Conversation, text: string): void {
  const last = conversation.messages.at(-1);
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text });
  } else {
    conversation.messages.push({ role: "user", content: [{ type: "text", text }] });
  }
}

export async function sendUserMessage(conversation: Conversation, text: string, emit: Emit, deps: AgentDeps): Promise<void> {
  await settleOpenToolCalls(conversation, emit);
  appendUserText(conversation, text);
  await runLoop(conversation, emit, deps);
}

export async function decideWrite(
  conversation: Conversation,
  decision: { approve: boolean; reason?: string },
  emit: Emit,
  deps: AgentDeps,
): Promise<void> {
  const pending = conversation.pending;
  if (!pending) throw new Error("There is no change waiting for a decision.");
  conversation.pending = undefined;

  const outcome = decision.approve
    ? await executeWrite(pending.preview, conversation.id)
    : await rejectWrite(pending.preview, conversation.id, decision.reason);
  emit({
    type: "write_result",
    id: pending.toolUseId,
    approved: decision.approve,
    isError: outcome.isError,
    content: outcome.content,
    table: outcome.table,
  });
  conversation.messages.push({
    role: "user",
    content: orderedResults(pending.toolUseOrder, pending.otherResults, toolResult(pending.toolUseId, outcome)),
  });
  await runLoop(conversation, emit, deps);
}

async function streamTurn(conversation: Conversation, emit: Emit, deps: AgentDeps): Promise<BetaMessage> {
  const schema = await deps.getSchema();
  const stream = deps.client.beta.messages.stream(buildRequest(conversation.messages, schema), { signal: deps.signal });
  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start" && event.content_block.type === "thinking") {
      emit({ type: "status", status: "thinking" });
    }
  });
  stream.on("text", (delta) => emit({ type: "text", delta }));
  return stream.finalMessage();
}

async function runLoop(conversation: Conversation, emit: Emit, deps: AgentDeps): Promise<void> {
  for (let step = 0; step < config.maxToolIterations; step++) {
    const message = await streamTurn(conversation, emit, deps);

    if (message.stop_reason === "refusal") {
      // Keep the turn order valid without replaying a declined partial answer.
      conversation.messages.push({ role: "assistant", content: [{ type: "text", text: REFUSAL_TEXT }] });
      emit({ type: "error", message: "The model declined this request." });
      emit({ type: "done" });
      return;
    }

    const content = echoableContent(message.content);
    conversation.messages.push({ role: "assistant", content });

    if (message.stop_reason === "pause_turn") continue;

    const toolUses = content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
    if (toolUses.length === 0) {
      if (message.stop_reason === "max_tokens") emit({ type: "error", message: "The reply was cut off because it got too long." });
      emit({ type: "done" });
      return;
    }

    emit({ type: "status", status: "running_tools" });
    const paused = await handleToolUses(conversation, toolUses, message.stop_reason === "max_tokens", emit);
    if (paused) return;
  }

  emit({
    type: "error",
    message: `Stopped after ${config.maxToolIterations} steps without a final answer. Try a more specific question.`,
  });
  emit({ type: "done" });
}

/**
 * Run one turn's tool calls and append their results. Returns true when a
 * write is now waiting for the user (the loop stops until `decideWrite`).
 */
async function handleToolUses(
  conversation: Conversation,
  toolUses: BetaToolUseBlock[],
  truncated: boolean,
  emit: Emit,
): Promise<boolean> {
  const results: BetaToolResultBlockParam[] = [];
  const writes: { toolUse: BetaToolUseBlock; sql: string; summary: string }[] = [];

  const finish = (toolUse: BetaToolUseBlock, outcome: ToolOutcome) => {
    emit({ type: "tool_result", id: toolUse.id, name: toolUse.name, isError: outcome.isError, content: outcome.content, table: outcome.table });
    results.push(toolResult(toolUse.id, outcome));
  };

  // Reads run in parallel; the write (if any) is previewed after them.
  await Promise.all(
    toolUses.map(async (toolUse) => {
      emit({ type: "tool_call", id: toolUse.id, name: toolUse.name, input: toolUse.input });
      if (truncated) {
        return finish(toolUse, { content: "The tool input was cut off (output limit reached) and was not run.", isError: true });
      }
      if (!isToolName(toolUse.name)) {
        return finish(toolUse, { content: `Unknown tool "${toolUse.name}".`, isError: true });
      }
      const parsed = inputSchemas[toolUse.name].safeParse(toolUse.input);
      if (!parsed.success) {
        return finish(toolUse, { content: `Invalid input: ${parsed.error.message}`, isError: true });
      }
      if (toolUse.name === "propose_write") {
        const { sql, summary } = parsed.data as { sql: string; summary: string };
        writes.push({ toolUse, sql, summary });
        return;
      }
      finish(toolUse, await runReadTool(toolUse.name, parsed.data, conversation.id));
    }),
  );

  let pending: { toolUse: BetaToolUseBlock; preview: WritePreview } | undefined;
  for (const write of writes) {
    if (pending) {
      finish(write.toolUse, {
        content: "Only one change can wait for approval at a time. Propose this one again after the user decides on the first.",
        isError: true,
      });
      continue;
    }
    const result = await previewWrite(write.sql, write.summary, conversation.id);
    if (result.ok) pending = { toolUse: write.toolUse, preview: result.preview };
    else finish(write.toolUse, result.outcome);
  }

  const order = toolUses.map((toolUse) => toolUse.id);
  if (pending) {
    conversation.pending = { toolUseId: pending.toolUse.id, preview: pending.preview, toolUseOrder: order, otherResults: results };
    const { preview } = pending;
    emit({
      type: "pending_write",
      id: pending.toolUse.id,
      summary: preview.summary,
      sql: preview.sql,
      op: preview.op,
      table: preview.table,
      affectedRows: preview.affectedRows,
      rows: preview.rows,
      cascadesTo: preview.cascadesTo,
    });
    return true;
  }

  conversation.messages.push({ role: "user", content: orderedResults(order, results) });
  return false;
}

/** A short message for the UI; details go to the server log. */
export function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key cannot use the configured model.";
  if (err instanceof Anthropic.NotFoundError) return `The model "${config.model}" was not found. Check ANTHROPIC_MODEL.`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIUserAbortError) return "The request was cancelled.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check the network and try again.";
  if (err instanceof Anthropic.InternalServerError) return "The Anthropic API is busy or had an error. Try again shortly.";
  if (err instanceof Anthropic.APIError) return `The Anthropic API returned an error: ${err.message}`;
  const code = (err as { code?: string })?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "28P01" || code === "3D000") {
    return "Could not connect to the database. Check DATABASE_URL.";
  }
  return (err as Error)?.message || "Something went wrong.";
}
