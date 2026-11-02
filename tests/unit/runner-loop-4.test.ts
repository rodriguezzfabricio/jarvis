// Runner loop tests, part 4 of 9 (review repairs, paused resets, reports, intake recovery, steer, notes). The loop tests are spread over nine files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { submitSteer } from "../../packages/cli/src/runner/inbox.ts";
import { data, finished, fixture, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

it("a failed independent review gets two repairs and cannot promote", async () => {
  const f = fixture(); const review = vi.fn(async () => "fail" as const); expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]); expect(review).toHaveBeenCalledTimes(3); expect(f.calls[1]!.failure).toBe("review_fail");
  expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
});
it("keeps a failed reset globally paused across a restart", async () => {
  const f = fixture(); let limited = true; f.setBody(async () => { if (limited) { limited = false; return finished("usage-limited"); } return finished(); });
  await expect(runLoop({ ...f.options, reprobe: async () => false })).rejects.toThrow(/probe/);
  const reprobe = vi.fn(async () => false);
  await expect(runLoop({ ...f.options, pidAlive: () => false, reprobe })).rejects.toThrow(/probe/); expect(f.calls).toHaveLength(1);
});
it("uses final text only as an unverified claim when no notes file exists", async () => {
  const f = fixture(); f.setBody(async () => ({ ...finished(), finalMessage: "fallback claim" })); await runLoop(f.options);
  expect(readFileSync(join(f.repoPath, ".jarvis/REPORT.md"), "utf8")).toContain("fallback claim");
});
it("calls injected intake recovery and seeds an optional plan just once", async () => {
  const f = fixture(); const recoverIntake = vi.fn(async () => {});
  const plan = { tasks: [{ id: "T2", goal: "added", exitCondition: "verified", dependencies: ["T1"] }] };
  expect((await runLoop({ ...f.options, plan, recoverIntake })).done).toEqual(["T1", "T2"]);
  await runLoop({ ...f.options, plan, recoverIntake }); expect(f.calls).toHaveLength(2); expect(recoverIntake).toHaveBeenCalledTimes(2);
});
it("records default steer effects durably and includes them in subsequent prompts", async () => {
  const f = fixture(); submitSteer(f.projectDir, "T1 use the new requirement"); await runLoop(f.options); expect(f.calls[0]!.prompt).toContain("use the new requirement");
  expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "inbox_applied")).toBe(true);
});
it("excludes notes even when the base checkout has no .jarvis ignore rule", async () => {
  const f = fixture(); writeFileSync(join(f.repoPath, ".gitignore"), ""); f.git(["add", "-A"]); f.git(["commit", "-qm", "no ignore"]);
  f.setBody(async (input) => { const path = join(input.workspace, ".jarvis/notes/T1.md"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "claim"); return finished(); });
  expect((await runLoop(f.options)).done).toEqual(["T1"]); expect(f.git(["ls-tree", "-r", "--name-only", "last-green"])).not.toContain(".jarvis/");
});

it("refuses changed task IDs on a second run instead of reusing old completion evidence", async () => {
  const f = fixture();
  expect((await runLoop(f.options)).done).toEqual(["T1"]);
  const calls = f.calls.length, head = f.git(["rev-parse", "HEAD"]);
  const plan = { tasks: [{ id: "T1", goal: "a different feature", exitCondition: "new feature proven", dependencies: [] }] };
  await expect(runLoop({ ...f.options, plan })).rejects.toThrow(/T1.*changed.*fresh task ID/);
  expect(f.calls).toHaveLength(calls);
  expect(f.git(["rev-parse", "HEAD"])).toBe(head);
  expect(f.ledger.entries().filter((e) => e.kind === "task_created" && e.task_id === "T1")).toHaveLength(1);
});

it("refuses old completed evidence when the same plan is rerun at a higher risk tier", async () => {
  const f = fixture();
  const plan = { tasks: [{ id: "T2", goal: "risk-sensitive work", exitCondition: "verified", dependencies: ["T1"] }] };
  expect((await runLoop({ ...f.options, plan, tier: 0 })).done).toEqual(["T1", "T2"]);
  const count = f.calls.length;
  await expect(runLoop({ ...f.options, plan, tier: 2 })).rejects.toThrow(/T2.*fresh task ID/);
  expect(f.calls).toHaveLength(count);
});

it("retains a recorded task's risk floor when resuming from the ledger without a plan", async () => {
  const f = fixture();
  f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { goal: "high risk task", exitCondition: "verified", riskTier: 2, dependencies: ["T1"] } });
  await runLoop({ ...f.options, tier: 0 });
  expect(f.calls.find((c) => c.prompt.includes("Task: T2"))?.tier).toBe(2);
});

it("binds completed evidence to approved requirements and check bytes", async () => {
  const f = fixture();
  const plan = { tasks: [{ id: "T2", goal: "same goal", exitCondition: "same condition", dependencies: ["T1"] }] };
  expect((await runLoop({ ...f.options, plan, inputHash: "a".repeat(64) })).status).toBe("complete");
  const count = f.calls.length;
  await expect(runLoop({ ...f.options, plan, inputHash: "b".repeat(64) })).rejects.toThrow(/T2.*fresh task ID/);
  expect(f.calls).toHaveLength(count);
});
