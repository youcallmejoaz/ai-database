import type Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { beforeEach, describe, expect, it } from "vitest";
import { queryOne, resetDatabase, TEST_DATABASE_URL } from "./helpers";
import { buildRequest, decideWrite, echoableContent, sendUserMessage, type AgentEvent } from "@/lib/agent";
import { store } from "@/lib/store";

/**
 * A stand-in for the Anthropic client that replays scripted model turns and
 * records every request, so the loop can be tested without an API key.
 */
function fakeClient(turns: BetaContentBlock[][]) {
  const requests: BetaMessageStreamParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: BetaMessageStreamParams) {
          requests.push(structuredClone(params));
          const content = turns.shift();
          if (!content) throw new Error("no scripted turn left");
          const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
          const message = {
            id: `msg_${requests.length}`,
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content,
            stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          } as unknown as BetaMessage;
          return {
            on(event: string, handler: (...args: unknown[]) => void) {
              (handlers[event] ??= []).push(handler);
              return this;
            },
            async finalMessage() {
              for (const block of content) {
                if (block.type === "text") handlers.text?.forEach((h) => h(block.text));
              }
              return message;
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const text = (t: string) => ({ type: "text", text: t, citations: null }) as BetaContentBlock;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as BetaContentBlock;

function roles(messages: BetaMessageParam[]) {
  return messages.map((m) => m.role);
}

describe("buildRequest", () => {
  it("caches the schema block and uses the configured model with fallbacks", () => {
    const req = buildRequest([{ role: "user", content: "hi" }], "public.t (table)");
    expect(req.model).toBe("claude-opus-5");
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toContain("server-side-fallback-2026-07-01");
    expect(req.thinking).toEqual({ type: "adaptive" });
    const system = req.system as { text: string; cache_control?: unknown }[];
    expect(system[1].text).toContain("public.t (table)");
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(req.tools?.map((t) => (t as { name: string }).name)).toEqual(["list_tables", "describe_table", "run_select", "propose_write"]);
  });
});

describe("echoableContent", () => {
  it("drops non-text blocks from before a fallback marker", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      text("partial"),
      toolUse("t1", "run_select", { sql: "SELECT 1" }),
      { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      toolUse("t2", "run_select", { sql: "SELECT 2" }),
    ] as unknown as BetaContentBlock[];
    expect(echoableContent(content).map((b) => b.type)).toEqual(["text", "fallback", "tool_use"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("agent loop", () => {
  beforeEach(resetDatabase);

  it("answers a question with a query, then pauses a write until it is approved", async () => {
    const { client, requests } = fakeClient([
      [text("Let me check."), toolUse("tu_1", "run_select", { sql: "SELECT id, status FROM orders WHERE id = 7" })],
      [text("Order 7 is pending.")],
      [toolUse("tu_2", "propose_write", { sql: "UPDATE orders SET status = 'paid' WHERE id = 7", summary: "Mark order 7 as paid" })],
      [text("Done: order 7 is now paid.")],
    ]);
    const deps = { client, getSchema: async () => "public.orders (table)" };
    const conversation = store.create();
    const events: AgentEvent[] = [];
    const emit = (e: AgentEvent) => events.push(e);

    await sendUserMessage(conversation, "What is the status of order 7?", emit, deps);
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "run_select", isError: false, table: { rows: [[7, "pending"]] } });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("pending");
    expect(roles(conversation.messages)).toEqual(["user", "assistant", "user", "assistant"]);

    events.length = 0;
    await sendUserMessage(conversation, "Mark it as paid", emit, deps);
    const pending = events.find((e) => e.type === "pending_write");
    expect(pending).toMatchObject({ id: "tu_2", op: "update", affectedRows: 1, summary: "Mark order 7 as paid" });
    expect(conversation.pending?.toolUseId).toBe("tu_2");
    expect(await queryOne("SELECT status FROM orders WHERE id = 7")).toEqual({ status: "pending" });
    expect(requests).toHaveLength(3); // the loop stopped and waits for the user

    events.length = 0;
    await decideWrite(conversation, { approve: true }, emit, deps);
    expect(events.find((e) => e.type === "write_result")).toMatchObject({ approved: true, isError: false });
    expect(await queryOne("SELECT status FROM orders WHERE id = 7")).toEqual({ status: "paid" });

    // The model saw the approval as the tool result for its own call.
    const last = requests[3].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "tu_2", content: expect.stringContaining("approved_and_applied") }),
    ]);
    // History is append-only: earlier requests are prefixes of later ones.
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1].messages;
      expect(requests[i].messages.slice(0, prev.length - 1)).toEqual(prev.slice(0, -1));
    }
    expect(conversation.pending).toBeUndefined();
  });

  it("a rejected write changes nothing and tells the model", async () => {
    const { client, requests } = fakeClient([
      [toolUse("tu_1", "propose_write", { sql: "DELETE FROM order_items WHERE order_id = 4", summary: "Clear order 4" })],
      [text("OK, I left it alone.")],
    ]);
    const conversation = store.create();
    const deps = { client, getSchema: async () => "" };
    await sendUserMessage(conversation, "Delete the items of order 4", () => {}, deps);
    await decideWrite(conversation, { approve: false, reason: "wrong order" }, () => {}, deps);

    expect(await queryOne("SELECT count(*)::int AS n FROM order_items WHERE order_id = 4")).toEqual({ n: 1 });
    const last = requests[1].messages.at(-1)!;
    expect(JSON.stringify(last.content)).toMatch(/rejected this change.*wrong order/);
  });

  it("a new message while a write is pending rejects it and keeps the history valid", async () => {
    const { client, requests } = fakeClient([
      [
        toolUse("tu_1", "run_select", { sql: "SELECT 1 AS one" }),
        toolUse("tu_2", "propose_write", { sql: "UPDATE products SET stock = 10 WHERE id = 5", summary: "Restock webcams" }),
      ],
      [text("Understood, cancelled.")],
    ]);
    const conversation = store.create();
    const deps = { client, getSchema: async () => "" };
    const events: AgentEvent[] = [];
    await sendUserMessage(conversation, "Restock webcams", (e) => events.push(e), deps);
    expect(conversation.pending?.toolUseId).toBe("tu_2");

    await sendUserMessage(conversation, "Actually never mind", (e) => events.push(e), deps);
    expect(events.find((e) => e.type === "write_result")).toMatchObject({ id: "tu_2", approved: false });
    expect(await queryOne("SELECT stock FROM products WHERE id = 5")).toEqual({ stock: 0 });

    // Both tool results, in call order, then the new text, all in one user message.
    const last = requests[1].messages.at(-1)!;
    expect((last.content as { type: string; tool_use_id?: string }[]).map((b) => b.tool_use_id ?? b.type)).toEqual([
      "tu_1",
      "tu_2",
      "text",
    ]);
  });

  it("blocked SQL and invalid input come back to the model as errors", async () => {
    const { client, requests } = fakeClient([
      [
        toolUse("tu_1", "run_select", { sql: "DROP TABLE customers" }),
        toolUse("tu_2", "run_select", { query: "SELECT 1" }),
        toolUse("tu_3", "propose_write", { sql: "DELETE FROM customers", summary: "Delete everyone" }),
      ],
      [text("Those were not allowed.")],
    ]);
    const conversation = store.create();
    await sendUserMessage(conversation, "Drop everything", () => {}, { client, getSchema: async () => "" });
    expect(conversation.pending).toBeUndefined();
    const results = requests[1].messages.at(-1)!.content as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ["tu_1", true],
      ["tu_2", true],
      ["tu_3", true],
    ]);
    expect(results[2].content).toMatch(/WHERE/);
    expect(await queryOne("SELECT count(*)::int AS n FROM customers")).toEqual({ n: 8 });
  });
});
