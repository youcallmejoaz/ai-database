#!/usr/bin/env node
/**
 * Records the README screenshots and demo GIF into docs/media by driving the
 * running app in headless Chromium.
 *
 *   APP_URL=http://localhost:3000 DEMO_DATABASE_URL=postgres://agent:agent@localhost:5432/shop pnpm media
 *
 * If the app has its login enabled, set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD too.
 *
 * Works against real Claude or scripts/demo-claude.mjs. When DEMO_DATABASE_URL
 * is set, the demo tables are reloaded before each scene. Point it only at the
 * demo database: db/seed.sql drops and recreates its tables.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import gifenc from "gifenc";
import pg from "pg";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const { GIFEncoder, nearestColorIndex, quantize, snapColorsToPalette } = gifenc;

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const OUT = path.resolve(import.meta.dirname, "../docs/media");
const SEED = path.resolve(import.meta.dirname, "../db/seed.sql");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sign in when the app has the login enabled.
const httpCredentials = process.env.BASIC_AUTH_USER
  ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASSWORD ?? "" }
  : undefined;

async function reseed() {
  if (!process.env.DEMO_DATABASE_URL) return;
  const client = new pg.Client({ connectionString: process.env.DEMO_DATABASE_URL });
  await client.connect();
  await client.query("SET client_min_messages = warning");
  await client.query(await readFile(SEED, "utf8"));
  await client.end();
}

/** Wait until the agent has finished its turn (the Send button is back). */
async function waitIdle(page) {
  await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 5_000 }).catch(() => {});
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector(".status"));
  await sleep(300);
}

async function ask(page, text, { typeDelay = 0 } = {}) {
  const box = page.getByLabel("Message");
  await box.click();
  if (typeDelay) await box.pressSequentially(text, { delay: typeDelay });
  else await box.fill(text);
  await page.keyboard.press("Enter");
  await waitIdle(page);
}

async function approve(page) {
  const button = page.getByRole("button", { name: "Approve and run" });
  await button.waitFor();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await sleep(250);
  await button.click();
  await waitIdle(page);
}

/** Grow the viewport so the whole conversation fits, then screenshot it. */
async function shootConversation(page, file) {
  await page.getByLabel("Message").blur();
  const height = await page.evaluate(() => {
    const thread = document.querySelector(".thread");
    // The thread stretches to fill the window, so measure its content instead.
    const end = thread.lastElementChild.getBoundingClientRect().bottom - thread.getBoundingClientRect().top + thread.scrollTop;
    const chrome = document.querySelector(".topbar").offsetHeight + document.querySelector(".composer").offsetHeight;
    return Math.ceil(end + 16 + chrome);
  });
  const { width } = page.viewportSize();
  await page.setViewportSize({ width, height: Math.max(height, 420) });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, file) });
  console.log("wrote", file);
}

async function newPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    httpCredentials,
    ...options,
  });
  const page = await context.newPage();
  await page.goto(APP_URL);
  await page.getByLabel("Message").waitFor();
  return page;
}

// --- GIF recording -----------------------------------------------------------

/** A visible cursor dot, since headless screenshots do not draw the pointer. */
const CURSOR_SCRIPT = () => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
      "background:rgba(47,91,211,.35);border:2px solid rgba(47,91,211,.9);pointer-events:none;left:-40px;top:-40px;" +
      "transition:transform .12s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => {
      dot.style.left = e.clientX + "px";
      dot.style.top = e.clientY + "px";
    });
    addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"));
    addEventListener("mouseup", () => (dot.style.transform = ""));
  });
};

async function record(page, script, { interval = 110 } = {}) {
  const frames = [];
  let recording = true;
  const loop = (async () => {
    while (recording) {
      const started = Date.now();
      frames.push({ png: await page.screenshot(), at: started });
      await sleep(Math.max(0, interval - (Date.now() - started)));
    }
  })();
  await script();
  await sleep(2_500); // hold on the final state
  recording = false;
  await loop;
  return frames;
}

/**
 * Map RGBA pixels to palette indices (offset by 1 for the transparent key).
 * Uses an exact-color cache: gifenc's applyPalette caches by RGB565, which
 * lets near-white pixels decide what pure white maps to.
 */
function toIndexed(rgba, colors, lookup) {
  const index = new Uint8Array(rgba.length / 4);
  for (let p = 0, o = 0; p < index.length; p++, o += 4) {
    const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    let value = lookup.get(key);
    if (value === undefined) {
      value = nearestColorIndex(colors, [rgba[o], rgba[o + 1], rgba[o + 2]]) + 1;
      lookup.set(key, value);
    }
    index[p] = value;
  }
  return index;
}

/**
 * Encode frames with one shared palette. A pixel whose palette index matches
 * what is already on screen is written as transparent (the previous frame is
 * kept underneath), which keeps a UI recording small.
 */
function encodeGif(frames) {
  const decoded = frames.map((f) => PNG.sync.read(f.png));
  const { width, height } = decoded[0];
  const pixels = width * height;
  // Build the palette from a spread of frames so every UI color is represented.
  const step = Math.max(1, Math.floor(decoded.length / 8));
  const sample = decoded.filter((_, i) => i % step === 0 || i === decoded.length - 1).map((d) => d.data);
  const merged = new Uint8Array(sample.reduce((n, d) => n + d.length, 0));
  sample.reduce((offset, d) => (merged.set(d, offset), offset + d.length), 0);
  const colors = quantize(merged, 255);
  // Quantizing averages nearby colors; snap back to the exact theme colors so
  // white stays white (values from src/app/globals.css, light theme).
  const theme = ["#ffffff", "#f7f7f5", "#f0f0ec", "#1c1c1a", "#6b6b66", "#e2e2dc", "#2f5bd3", "#1f7a4a", "#e6f4ec", "#fff6e0", "#e8c66a", "#f3f2ee"];
  snapColorsToPalette(colors, theme.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))), 12);
  const palette = [[255, 0, 255], ...colors]; // index 0 = transparent key

  const lookup = new Map();
  const gif = GIFEncoder();
  let onScreen = null; // palette index currently displayed at each pixel
  let written = 0;
  for (let i = 0; i < decoded.length; i++) {
    const delay = i + 1 < frames.length ? frames[i + 1].at - frames[i].at : 3_000;
    const index = toIndexed(decoded[i].data, colors, lookup);

    const out = new Uint8Array(pixels);
    let changed = 0;
    for (let p = 0; p < pixels; p++) {
      if (onScreen && onScreen[p] === index[p]) continue; // 0 = transparent
      out[p] = index[p];
      changed++;
    }
    if (onScreen && changed === 0) {
      gif.writeFrame(out, width, height, { delay, transparent: true, transparentIndex: 0, dispose: 1 });
      continue;
    }
    gif.writeFrame(out, width, height, {
      palette,
      delay,
      transparent: Boolean(onScreen),
      transparentIndex: 0,
      // 1 = keep the previous frame underneath, so transparent pixels show it.
      dispose: 1,
      repeat: 0,
    });
    onScreen = index;
    written++;
  }
  gif.finish();
  console.log(`gif: ${frames.length} frames (${written} distinct), ${width}x${height}, ${colors.length} colors`);
  return gif.bytes();
}

// --- Scenes ------------------------------------------------------------------

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

try {
  // 1. The main conversation: a question, then an approved change.
  await reseed();
  let page = await newPage(browser);
  await ask(page, "Who are our top 3 customers by total spend?");
  await ask(page, "Restock the HD webcam to 25 units");
  await approve(page);
  await shootConversation(page, "conversation.png");
  await page.context().close();

  // 2. A delete that cascades: the approval card, close up.
  await reseed();
  page = await newPage(browser);
  await ask(page, "Remove the cancelled order 4");
  await page.locator(".write-card").screenshot({ path: path.join(OUT, "approval-card.png") });
  console.log("wrote approval-card.png");
  await page.context().close();

  // 3. Guardrails: a mass delete is refused before it reaches the database.
  await reseed();
  page = await newPage(browser);
  await ask(page, "Delete all customers");
  await shootConversation(page, "guardrail.png");
  await page.context().close();

  // 4. Dark mode.
  await reseed();
  page = await newPage(browser, { colorScheme: "dark" });
  await ask(page, "Show revenue by category");
  await shootConversation(page, "dark-mode.png");
  await page.context().close();

  // 5. Phone.
  await reseed();
  page = await newPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ask(page, "Which products are out of stock?");
  await page.getByLabel("Message").blur();
  await page.screenshot({ path: path.join(OUT, "mobile.png") });
  console.log("wrote mobile.png");
  await page.context().close();

  // 6. Demo GIF: ask, see the answer stream in, request a change, approve it.
  await reseed();
  const context = await browser.newContext({ viewport: { width: 880, height: 620 }, deviceScaleFactor: 1, httpCredentials });
  await context.addInitScript(CURSOR_SCRIPT);
  page = await context.newPage();
  await page.goto(APP_URL);
  await page.getByLabel("Message").waitFor();
  const frames = await record(page, async () => {
    await sleep(900);
    const chip = page.getByRole("button", { name: "Who are our top 3 customers by total spend?" });
    const box = await chip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
    await sleep(300);
    await chip.click();
    await waitIdle(page);
    await sleep(1_200);
    await ask(page, "Restock the HD webcam to 25 units", { typeDelay: 45 });
    await sleep(1_200);
    await approve(page);
  });
  await writeFile(path.join(OUT, "demo.gif"), encodeGif(frames));
  console.log("wrote demo.gif");
  await context.close();
} finally {
  await browser.close();
}
