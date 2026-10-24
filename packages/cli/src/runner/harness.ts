/** The build loop's harness boundary. Times ending in At/Until are Unix seconds. */
export type TaskRole = "intake" | "spec" | "architect" | "review" | "build" | "debug" | "explore";
export type TaskTier = 0 | 1 | 2;
export type EscalationReason = "gate_fail" | "review_fail";

export interface TaskInput {
  workspace: string;
  prompt: string;
  runHeaderPath: string;
  role: TaskRole;
  tier: TaskTier;
  maxTurns: number;
  timeoutMs: number;
  logPath: string;
  failure?: EscalationReason;
}

export interface UsageWindow {
  utilization: number;
  resetsAt: number | undefined;
}

export interface UsageSample {
  windows: Readonly<Record<string, UsageWindow>>;
}

/** What a session said it consumed. As reported and unchecked: runner/usage-log.ts validates it. */
export interface SessionUsage {
  reportedModel: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  /** The harness's own figure; on a subscription an API-equivalent estimate, not a charge. */
  costUsd: number | undefined;
  turns: number | undefined;
  /** False without a final result (killed, timed out, truncated): tokens are a lower bound. */
  complete: boolean;
}

export interface TaskResult {
  /** Cleanup diagnostics never replace a process outcome. */
  cleanupErrors?: readonly string[];
  /** Absent when no session started. */
  sessionUsage?: SessionUsage;
  exitCode: number | null;
  durationMs: number;
  /** Samples in stream order, so the loop can record before/after window consumption. */
  usage: readonly UsageSample[];
  /** A proactive wait can also be needed after a finished session. */
  usageWaitUntil: number | undefined;
}

export type TaskOutcome = TaskResult & (
  | { status: "finished" }
  | { status: "refused"; reason: string }
  | { status: "error"; message: string }
  | { status: "timeout" }
  | { status: "usage-limited"; resetAt: number | undefined }
);

export interface Harness {
  /** A fresh session. Finished is a process outcome, never evidence that a task passed. */
  runTask(input: TaskInput): Promise<TaskOutcome>;
}
