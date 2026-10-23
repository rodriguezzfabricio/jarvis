import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "./broker.ts";

/**
 * Local adapters (stage 1): every approved action is written to an outbox folder instead of leaving the
 * machine. This is the "local SMTP stub" the golden tasks use; real adapters arrive in stage 5.
 */
export function outboxAdapters(outboxDir: string): Adapter[] {
  mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  const write = (op: string) => async (payload: unknown) => {
    const file = join(outboxDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${op}.json`);
    writeFileSync(file, `${JSON.stringify({ op, payload }, null, 2)}\n`, { mode: 0o600 });
    return { outcome: "succeeded" as const, detail: { outbox: file, delivered: false } };
  };
  return ["email.send", "deploy.preview", "deploy.promote"].map((op) => ({ op, execute: write(op) }));
}
