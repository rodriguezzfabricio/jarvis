import { afterEach, expect, it } from "vitest";
import { createReviewService } from "../../packages/cli/src/review/service.ts";
import { jarvisMetrics } from "../../packages/cli/src/eval/jarvis.ts";
import type { ReviewerOutput } from "../../packages/cli/src/review/types.ts";
import { setup, removeFixtureRoots } from "./helpers/review-service-fixture.ts";
afterEach(removeFixtureRoots);
it("records a typed limit and reset without running another reviewer or returning a code failure", async () => {
  const s = setup();
  s.claude.mockResolvedValue({ reviewer: "claude", model: "claude-opus-5-5", rawOutput: "limit", rawVerdict: "", usageLimit: { resetAt: 2000 } });
  const service = createReviewService(s.options);
  const r = await service.reviewDetailed(s.request);
  expect(r.verdict).toBe("usage-limited");
  expect(r.entry.data).toMatchObject({ status: "usage-limited", resetAt: 2000 });
  expect(s.codex).not.toHaveBeenCalled();
  expect(await service.review(s.request)).toEqual({ status: "usage-limited", resetAt: 2000 });
  expect(jarvisMetrics(s.ledger.entries(), 0, 0).sessions.review).toBe(0);
});
it("counts actual reviewer starts and includes their usage with the material tier", async () => {
  const s = setup(2); s.options.codex = null as never;
  s.claude.mockImplementation(async input => {
    input.onSpawn?.();
    return { reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: '{"findings":[],"checked":["spec-criteria","data-flow","error-paths","unchanged-callers"]}',
      sessionOutcome: { status: "finished", exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined,
        sessionUsage: { reportedModel: input.model, inputTokens: 23, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 1, complete: true } } };
  });
  await createReviewService(s.options).reviewDetailed(s.request);
  const metrics = jarvisMetrics(s.ledger.entries(), 0, 0);
  expect(metrics.sessions.review).toBe(1);
  expect(metrics.usage).toMatchObject({ inputTokens: 23, outputTokens: 7 });
  expect(s.ledger.entries().find(e => e.kind === "session_usage")?.data).toMatchObject({ tier: 2, role: "review" });
});
const CHECKED = ["spec-criteria", "data-flow", "error-paths", "unchanged-callers"];
const limitedFallback = (s: ReturnType<typeof setup>): ReviewerOutput => {
  s.codex.mockImplementation(async (i) => ({ reviewer: "codex", model: i.model, rawOutput: "codex-unavailable", rawVerdict: "", error: "usage_limit", fallbackReason: "usage_limit" }));
  return { reviewer: "claude", model: "claude-opus-5-5", rawOutput: "limit", rawVerdict: "", usageLimit: { resetAt: 2000 } };
};
it("keeps another reviewer's fail when the strong fallback then hits the limit: no wait can overturn it", async () => {
  const s = setup(2), limit = limitedFallback(s);
  s.claude.mockResolvedValueOnce({ reviewer: "claude", model: "claude-opus-5-5", rawOutput: "raw", rawVerdict: JSON.stringify({ checked: CHECKED, findings: [{ severity: "critical", confidence: 1, impact: "security", file: "app.txt", line: 1, scenario: "leaks", fix: "redact" }] }) })
    .mockResolvedValueOnce(limit);
  const r = await createReviewService(s.options).reviewDetailed(s.request);
  expect(s.claude).toHaveBeenCalledTimes(2);
  expect(r.verdict).toBe("fail");
  expect(r.entry.data).toMatchObject({ status: "fail" });
  expect(r.entry.data).not.toHaveProperty("resetAt");
});
it.each(["pass", "error"] as const)("waits on a limited fallback when the other reviewer's result was %s", async (first) => {
  const s = setup(2), limit = limitedFallback(s);
  s.claude.mockResolvedValueOnce({ reviewer: "claude", model: "claude-opus-5-5", rawOutput: "raw", rawVerdict: first === "pass" ? JSON.stringify({ findings: [], checked: CHECKED }) : "not json" })
    .mockResolvedValueOnce(limit);
  const r = await createReviewService(s.options).reviewDetailed(s.request);
  expect(r.verdict).toBe("usage-limited");
  expect(r.entry.data).toMatchObject({ status: "usage-limited", resetAt: 2000 });
});
