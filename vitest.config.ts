import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    // The database tests share one test database, so run files one at a time.
    fileParallelism: false,
    env: { AUDIT_LOG_PATH: "logs/test-audit.jsonl" },
  },
});
