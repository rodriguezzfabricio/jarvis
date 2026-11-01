import type { TaskOutcome } from "../runner/harness.ts";
import type { CodexRoute } from "./routing.ts";
import type { Effort } from "../runner/routing.ts";
export interface ReviewRequest { taskId: string; attemptId: string; revision: string }
export type Review = (request: ReviewRequest) => Promise<"pass" | "fail" | { status: "usage-limited"; resetAt: number | undefined }>;
export interface ReviewerInput {
  workspace: string;
  outputDir: string;
  prompt: string;
  model: string;
  effort: Effort | CodexRoute["effort"];
  maxTurns: number;
  timeoutMs: number;
  /** Called only when the review process starts, before its payload runs. */
  onSpawn?: () => void;
}
export type FallbackReason = "usage_limit" | "missing_binary" | "version_mismatch";
export interface ReviewerOutput {
  reviewer: "claude" | "codex";
  model: string;
  rawOutput: string;
  rawVerdict: string;
  error?: string;
  usageLimit?: { resetAt: number | undefined };
  sessionOutcome?: TaskOutcome;
  fallbackReason?: FallbackReason;
  failureKind?: "policy";
}
export type Reviewer = (input: ReviewerInput) => Promise<ReviewerOutput>;
