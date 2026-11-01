import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { runLoop, type ReviewInput, type ReviewVerdict } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { data, finished, fixture, recordGate, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);
it("waits through repeated review limits on one revision without spending the error retry", async () => {
  const f = fixture();
  const statuses = ["error", "usage-limited", "usage-limited", "pass"] as const;
  const review = vi.fn(async (r: ReviewInput): Promise<ReviewVerdict> => {
    const status = statuses[review.mock.calls.length - 1] ?? "error";
    f.ledger.append({ kind: "review_result", actor: "runner", task_id: r.taskId, attempt_id: r.attemptId,
      data: { reviewer: "code", revision: r.revision, status, resetAt: status === "usage-limited" ? 3 + review.mock.calls.length : null } });
    return { recorded: true, status };
  });
  const reprobe = vi.fn(async () => true);
  expect((await runLoop({ ...f.options, review, reprobe })).status).toBe("complete");
  expect(review).toHaveBeenCalledTimes(4);
  expect(new Set(review.mock.calls.map(([r]) => r.revision)).size).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(reprobe).toHaveBeenCalledTimes(2);
  expect(f.ledger.entries().filter(e => e.kind === "usage_wait").map(e => data(e).resetAt)).toEqual([5, 6]);
  expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 10000, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(0);
});

it("recovers a checkpointed review limit without rebuilding the candidate", async () => {
  const f = fixture(); let limited = true;
  const review = vi.fn(async (r: ReviewInput): Promise<ReviewVerdict> => {
    const status = limited ? "usage-limited" : "pass"; limited = false;
    f.ledger.append({ kind: "review_result", actor: "runner", task_id: r.taskId, attempt_id: r.attemptId,
      data: { reviewer: "code", revision: r.revision, status, resetAt: 2 } });
    return { recorded: true, status };
  });
  await expect(runLoop({ ...f.options, review, sleep: async () => { throw new Error("power loss in wait"); } })).rejects.toThrow("power loss in wait");
  expect((await runLoop({ ...f.options, review, pidAlive: () => false })).status).toBe("complete");
  expect(f.calls).toHaveLength(1);
  expect(f.ledger.entries().filter(e => e.kind === "usage_wait")).toHaveLength(1);
  expect(review.mock.calls[1]![0].revision).toBe(review.mock.calls[0]![0].revision);
});

it("stops the run after a ceiling of review waits, unblocked and uncharged, and the next run resumes the same review", async () => {
  const f = fixture(); let limited = true;
  const review = vi.fn(async (r: ReviewInput): Promise<ReviewVerdict> => {
    if (review.mock.calls.length > 12) throw new Error("review waits without a ceiling");
    const status = limited ? "usage-limited" : "pass";
    f.ledger.append({ kind: "review_result", actor: "runner", task_id: r.taskId, attempt_id: r.attemptId, data: { reviewer: "code", revision: r.revision, status, resetAt: null } });
    return { recorded: true, status };
  });
  await expect(runLoop({ ...f.options, review })).rejects.toThrow(/still usage-limited after 8 waits/);
  expect(review).toHaveBeenCalledTimes(9);
  expect(f.ledger.entries().filter(e => e.kind === "usage_wait")).toHaveLength(8);
  expect(f.ledger.entries().filter(e => e.kind === "blocked")).toHaveLength(0);
  limited = false;
  expect((await runLoop({ ...f.options, review, pidAlive: () => false })).status).toBe("complete");
  expect(f.calls).toHaveLength(1);
  expect(new Set(review.mock.calls.map(([r]) => r.revision)).size).toBe(1);
  expect(f.ledger.entries().filter(e => e.kind === "usage_wait")).toHaveLength(9); // the checkpointed limit is waited out first
  expect(repairsUsed(rebuildState(f.ledger.entries(), { now: f.options.now!(), verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(0);
});

it.each([false, true])("a usage limit wins over the loop timer during shutdown (repair: %s)", async (repair) => {
  const f = fixture(); const limitCall = repair ? 2 : 1;
  if (repair) f.gate.mockImplementationOnce(async g => recordGate(g, "fail"));
  f.setBody(async input => {
    writeFileSync(join(input.workspace, "T1.txt"), "built");
    if (f.calls.length === limitCall) { await delay(30); return finished("usage-limited"); }
    return finished();
  });
  expect((await runLoop({ ...f.options, taskTimeoutMs: 10 })).status).toBe("complete");
  expect(f.calls).toHaveLength(limitCall + 1);
  expect(f.calls[limitCall]!.workspace).toBe(f.calls[limitCall - 1]!.workspace);
  expect(f.ledger.entries().filter(e => e.kind === "usage_wait")).toHaveLength(1);
  expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 10000, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(repair ? 1 : 0);
});
it("records no builder usage row when the preflight limit started no process", async () => {
  const f = fixture(); let first = true;
  const harness = { runTask: async (input: Parameters<typeof f.harness.runTask>[0]) => {
    if (first) { first = false; return { ...finished("usage-limited"), exitCode: null }; }
    return f.harness.runTask(input);
  } };
  expect((await runLoop({ ...f.options, harness })).status).toBe("complete");
  expect(f.ledger.entries().filter(e => e.kind === "session_usage")).toHaveLength(1);
});
