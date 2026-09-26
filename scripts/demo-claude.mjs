#!/usr/bin/env node
/**
 * A scripted stand-in for the Claude Messages API (streaming), used to record
 * the README screenshots and demo GIF without an API key. The replies below
 * are canned for the demo shop database (db/seed.sql); they are NOT generated
 * by Claude. Everything else in the app runs for real: the SDK, the agent
 * loop, the SQL checks, Postgres, and the UI.
 *
 *   node scripts/demo-claude.mjs            # listens on :4010
 *   ANTHROPIC_BASE_URL=http://localhost:4010 ANTHROPIC_API_KEY=demo pnpm dev
 */
import http from "node:http";

const PORT = Number(process.env.DEMO_PORT || 4010);
const CHUNK_DELAY_MS = Number(process.env.DEMO_CHUNK_DELAY_MS || 30);
const THINK_DELAY_MS = Number(process.env.DEMO_THINK_DELAY_MS || 700);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const think = { type: "thinking" };
const say = (text) => ({ type: "text", text });
const call = (name, input) => ({ type: "tool_use", name, input });

/** First turn for each question, matched against the user's text. */
const OPENERS = [
  {
    match: /which tables/i,
    blocks: [think, call("list_tables", {})],
  },
  {
    match: /top.*customers/i,
    blocks: [
      think,
      say("I'll add up each customer's order lines, leaving out cancelled orders."),
      call("run_select", {
        sql: `SELECT c.name, c.country, count(DISTINCT o.id) AS orders,
       sum(oi.quantity * oi.unit_price) AS total_spend
FROM customers c
JOIN orders o ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status <> 'cancelled'
GROUP BY c.id
ORDER BY total_spend DESC
LIMIT 3`,
      }),
    ],
  },
  {
    match: /revenue.*category|category.*revenue/i,
    blocks: [
      think,
      call("run_select", {
        sql: `SELECT p.category, sum(oi.quantity) AS units,
       sum(oi.quantity * oi.unit_price) AS revenue
FROM order_items oi
JOIN products p ON p.id = oi.product_id
JOIN orders o ON o.id = oi.order_id
WHERE o.status IN ('paid', 'shipped')
GROUP BY p.category
ORDER BY revenue DESC`,
      }),
    ],
  },
  {
    match: /out of stock/i,
    blocks: [
      think,
      call("run_select", {
        sql: `SELECT p.sku, p.name, p.stock,
       string_agg(o.id || ' (' || o.status || ')', ', ') AS open_orders
FROM products p
LEFT JOIN order_items oi ON oi.product_id = p.id
LEFT JOIN orders o ON o.id = oi.order_id AND o.status IN ('pending', 'paid')
WHERE p.stock = 0
GROUP BY p.id`,
      }),
    ],
  },
  {
    match: /restock/i,
    blocks: [
      think,
      call("propose_write", {
        sql: "UPDATE products SET stock = 25 WHERE sku = 'WC-005'",
        summary: "Set HD Webcam (WC-005) stock to 25 units",
      }),
    ],
  },
  {
    match: /order 4/i,
    blocks: [
      think,
      say("Order 4 is cancelled, so it's safe to remove. Here's the change for you to confirm:"),
      call("propose_write", {
        sql: "DELETE FROM orders WHERE id = 4 AND status = 'cancelled'",
        summary: "Delete cancelled order 4",
      }),
    ],
  },
  {
    match: /delete all customers/i,
    blocks: [call("propose_write", { sql: "DELETE FROM customers", summary: "Delete every customer" })],
  },
];

/** Follow-up turn after a tool result, matched against the tool's SQL. */
function followUp(sql, result, toolName) {
  const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  if (text.includes("approved_and_applied")) {
    if (/WC-005/.test(sql)) return [say("Done. The **HD Webcam** now has **25 units** in stock, so pending order 11 can ship.")];
    return [say("Done. The change was applied.")];
  }
  if (text.includes("rejected")) return [say("OK, I left it as it was. Nothing was changed.")];
  if (result.is_error && /DELETE FROM customers/.test(sql)) {
    return [
      say(
        "I can't do that one. Deleting every customer would need a `DELETE` without a `WHERE` clause, and this agent refuses those. " +
          "If you want to remove specific customers, tell me which ones and I'll show you the rows first.",
      ),
    ];
  }
  if (toolName === "list_tables") {
    return [
      say(
        "There are 4 tables: **customers**, **products**, **orders** and **order_items**. " +
          "Each order belongs to a customer, and order_items link orders to the products in them.",
      ),
    ];
  }
  if (/total_spend/.test(sql)) {
    return [
      say(
        "**Ada Obi** (Nigeria) is well ahead at **$907.88** across 3 orders, more than twice Diana Rossi's $438.99. " +
          "Ben Carter is third at $289.00.",
      ),
    ];
  }
  if (/revenue/.test(sql)) {
    return [
      say(
        "**Displays** lead with **$1,049.97**, from just 3 monitors. Audio is second at $533.00, and Accessories sell the most units (7) " +
          "but bring in the least. Only paid and shipped orders are counted.",
      ),
    ];
  }
  if (/stock = 0/.test(sql)) {
    return [say("Only the **HD Webcam** (WC-005) is at zero, and pending order 11 is waiting on one. Want me to restock it?")];
  }
  return [say("Here's what I found.")];
}

let counter = 0;

async function stream(res, blocks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = ++counter;
  send("message_start", {
    message: {
      id: `msg_demo_${id}`, type: "message", role: "assistant", model: "claude-opus-5", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 0 },
    },
  });
  let stop = "end_turn";
  for (const [index, block] of blocks.entries()) {
    if (block.type === "thinking") {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      await sleep(THINK_DELAY_MS);
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: "demo" } });
    } else if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const piece of block.text.match(/\S+\s*/g) ?? []) {
        send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        await sleep(CHUNK_DELAY_MS);
      }
    } else {
      stop = "tool_use";
      send("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_demo_${id}_${index}`, name: block.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      await sleep(CHUNK_DELAY_MS * 4);
    }
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 80 } });
  send("message_stop", {});
  res.end();
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { messages } = JSON.parse(body);
        const last = messages.at(-1);
        const blocks = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
        const userText = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
        const result = blocks.find((b) => b.type === "tool_result");

        if (userText) {
          const opener = OPENERS.find((o) => o.match.test(userText));
          return await stream(res, opener ? opener.blocks : [say("This demo only knows the example questions. Set a real ANTHROPIC_API_KEY to ask anything.")]);
        }
        if (result) {
          // Find the SQL of the call this result answers.
          const calls = messages.at(-2).content.filter((b) => b.type === "tool_use");
          const answered = calls.find((c) => c.id === result.tool_use_id);
          return await stream(res, followUp(answered?.input?.sql ?? "", result, answered?.name));
        }
        await stream(res, [say("Hello!")]);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } }));
      }
    });
  })
  .listen(PORT, () => console.log(`demo Claude API on http://localhost:${PORT}`));
