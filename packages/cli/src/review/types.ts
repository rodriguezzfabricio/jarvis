import type { CodexRoute } from "./routing.ts";
import type { Effort } from "../runner/routing.ts";
export interface ReviewRequest { taskId: string; attemptId: string; revision: string }
export type Review = (request: ReviewRequest) => Promise<"pass" | "fail">;
export interface ReviewerInput {
  workspace: string;
  outputDir: string;
  prompt: string;
  model: string;
  effort: Effort | CodexRoute["effort"];
  maxTurns: number;
  timeoutMs: number;
}
export type FallbackReason = "usage_limit" | "missing_binary" | "version_mismatch";
export interface ReviewerOutput {
  reviewer: "claude" | "codex";
  model: string;
  rawOutput: string;
  rawVerdict: string;
  error?: string;
  fallbackReason?: FallbackReason;
  failureKind?: "policy";
}
export type Reviewer = (input: ReviewerInput) => Promise<ReviewerOutput>;
