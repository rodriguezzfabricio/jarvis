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

export interface TaskResult {
  /** Cleanup diagnostics never replace a process outcome. */
  cleanupErrors?: readonly string[];
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
