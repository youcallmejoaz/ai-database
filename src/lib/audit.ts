import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export type AuditEvent =
  | { kind: "select"; conversationId: string; sql: string; ok: boolean; rowCount?: number; error?: string; ms: number }
  | { kind: "write_proposed"; conversationId: string; sql: string; ok: boolean; rowCount?: number; error?: string }
  | { kind: "write_decision"; conversationId: string; sql: string; decision: "approved" | "rejected"; ok: boolean; rowCount?: number; error?: string };

let dirReady: Promise<unknown> | null = null;

/** Append one JSON line per event. Failures are logged, never thrown. */
export async function audit(event: AuditEvent): Promise<void> {
  const file = path.resolve(config.auditLogPath);
  try {
    dirReady ??= mkdir(path.dirname(file), { recursive: true });
    await dirReady;
    await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch (err) {
    console.error("[audit] could not write audit log:", (err as Error).message);
  }
}
