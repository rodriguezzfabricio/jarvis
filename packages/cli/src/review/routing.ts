import { z } from "zod";
import { DEFAULT_ROUTING, validateRouting, type RoutingTable } from "../runner/routing.ts";

export const CodexRouteSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
}).strict();
export type CodexRoute = z.infer<typeof CodexRouteSchema>;
/** Lane-owned extension until the shared routing loader adopts cross-model settings. */
export type ReviewRouting = RoutingTable & { cross_model?: { codex: CodexRoute } };
export const DEFAULT_REVIEW_ROUTING = {
  ...DEFAULT_ROUTING,
  cross_model: { codex: { model: "gpt-6.1-sol", effort: "high" } },
} as const satisfies ReviewRouting;

/** Copies both routes once; candidate files cannot change routing during a run. */
export function validateReviewRouting(input: ReviewRouting): RoutingTable & { cross_model: { codex: CodexRoute } } {
  const { cross_model, ...base } = input;
  const cross = z.object({ codex: CodexRouteSchema }).strict().parse(cross_model ?? DEFAULT_REVIEW_ROUTING.cross_model);
  return { ...validateRouting(base), cross_model: cross };
}
