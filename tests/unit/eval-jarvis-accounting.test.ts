import { afterEach, expect, it } from "vitest";
import { jarvisMetrics, runJarvis, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import type { LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import { fixture, removeFixtures, featureTask, planner, planFile, validTasks, options } from "./helpers/eval-jarvis-run-fixture.ts";
import { fakeLoop } from "./eval-jarvis-fixture.ts";
afterEach(removeFixtures);
it("counts process starts, not reservations, resumed leases or unspawned review adapters", () => {
  const entry = (kind: LedgerEntry["kind"], data: object): LedgerEntry => ({ kind, data, actor: "runner", seq: 1, ts: "2026-10-31T00:00:00Z", task_id: "T1", attempt_id: "a1", hash: "", prev_hash: "" });
  const m = jarvisMetrics([
    entry("attempt_started", { workspace: "w" }),
    entry("attempt_started", { processGroup: 123, processGroupRecord: { groupId: 123 } }),
    entry("attempt_started", { workspace: "w" }),
    entry("attempt_started", { processGroup: 124, processGroupRecord: { groupId: 124 } }),
    entry("review_result", { reviewer: "code", reviews: [{ reviewer: "claude", error: "preflight" }] }),
    entry("review_result", { reviewer: "code", status: "pass" }),
    entry("reconciled", { type: "review_process_started", reviewer: "claude" }),
  ], 0, 0);
  expect(m.sessions).toEqual({ build: 2, review: 1, planner: 0, total: 3 });
});
it("passes the validated plan tier to the eval loop", async () => {
  const fx = fixture(); const p = planner(planFile(validTasks(), { tier: 2 })); const calls: RunLoopOptions[] = [];
  const result = await runJarvis(featureTask(fx), options(fx, { harness: p.harness, runLoop: fakeLoop("fix", {}, calls) }));
  expect(result.outcome).toBe("complete");
  expect(calls[0]!.tier).toBe(2);
});
it("does not count a planner refused at a usage preflight as a process start", async () => {
  const fx = fixture();
  const result = await runJarvis(featureTask(fx), options(fx, {
    harness: { runTask: async () => ({ status: "usage-limited", resetAt: 2000, exitCode: null, durationMs: 0, usage: [], usageWaitUntil: 2000 }) },
    runLoop: fakeLoop("fix"),
  }));
  expect(result.metrics.sessions.planner).toBe(0);
  expect(result.metrics.usage.sessions).toBe(0);
});
it("keeps a planner process start in metrics even if its adapter throws afterwards", async () => {
  const fx = fixture();
  const result = await runJarvis(featureTask(fx), options(fx, {
    harness: { runTask: async input => { input.onSpawn?.(2100000000); throw new Error("capture failed after spawn"); } },
    runLoop: fakeLoop("fix"),
  }));
  expect(result.outcome).toBe("crashed");
  expect(result.metrics.sessions.planner).toBe(1);
});
