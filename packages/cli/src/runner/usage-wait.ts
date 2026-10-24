import { setTimeout } from "node:timers/promises";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import type { TaskOutcome } from "./harness.ts";

export interface UsageWaitInput {
  outcome: TaskOutcome;
  ledger: Pick<Ledger, "append">;
  taskId: string;
  attemptId: string;
  backoffAttempt?: number;
}

export interface UsageWaitNotice {
  taskId: string;
  /** Unix milliseconds, unlike the harness's reset timestamps (seconds). */
  resumeAt: number;
  waitMs: number;
}

export interface UsageWaitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  notify: (notice: UsageWaitNotice) => Promise<void>;
  /** Live preflight must pass again after the reset, before the loop can resume. */
  reprobe: () => Promise<boolean>;
  marginMs?: number;
}

export type UsageWaitResult = "continue" | "resume";

/** Account-wide: the loop must hold back ALL dispatch until the ledger entry's until (epoch ms). */
export async function waitForUsage(input: UsageWaitInput, opts: UsageWaitOptions): Promise<UsageWaitResult> {
  const limited = input.outcome.status === "usage-limited";
  const resetAt = input.outcome.status === "usage-limited" ? input.outcome.resetAt : input.outcome.usageWaitUntil;
  if (!limited && resetAt === undefined) return "continue";
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => setTimeout(ms));
  const start = now();
  if (!limited && resetAt !== undefined && Number.isFinite(resetAt) && resetAt * 1000 <= start) return "continue";
  const margin = opts.marginMs ?? 30_000;
  if (!Number.isFinite(start) || !Number.isFinite(margin) || margin < 0) throw new Error("invalid usage-wait clock or margin");
  const attempt = input.backoffAttempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error("invalid usage-wait backoff attempt");
  const fallbackMs = Math.min(300_000, 60_000 * 2 ** Math.min(attempt, 3));
  const resetMs = resetAt === undefined ? Number.NaN : resetAt * 1000;
  const fallback = !Number.isFinite(resetMs) || resetMs <= start;
  const resumeAt = (fallback ? start + fallbackMs : resetMs) + margin;
  const notice = { taskId: input.taskId, resumeAt, waitMs: resumeAt - start };
  input.ledger.append({
    kind: "usage_wait", actor: "runner", task_id: input.taskId, attempt_id: input.attemptId,
    data: { ...notice, until: resumeAt, resetAt: resetAt ?? null, fallback, reason: limited ? "usage-limited" : "usage-window", countsAsFailure: false },
  });
  if (notice.waitMs > 2 * 60 * 60 * 1000) {
    try { await opts.notify(notice); } catch {
      // A missed notification must never block a run (decision 50).
    }
  }
  while (now() < resumeAt) await sleep(Math.min(60_000, resumeAt - now()));
  if (!await opts.reprobe()) throw new Error("usage reset preflight probe failed; dispatch remains paused");
  return "resume";
}

/** The task id identifies who hit the limit; it never narrows this run-wide dispatch pause. */
export function activeUsageWait(entries: readonly LedgerEntry[], now: number): number | undefined {
  let until: number | undefined;
  for (const entry of entries) {
    if (entry.kind !== "usage_wait" || !entry.data || typeof entry.data !== "object") continue;
    const value = (entry.data as { until?: unknown }).until;
    if (typeof value === "number" && Number.isFinite(value) && value > now && (until === undefined || value > until)) until = value;
  }
  return until;
}
