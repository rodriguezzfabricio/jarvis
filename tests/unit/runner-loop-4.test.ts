// Runner loop tests, part 4 of 6 (review repairs, paused resets, reports, intake recovery, steer, runner metadata, evidence). The loop tests are spread over six files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runLoop, type LoopTaskInput } from "../../packages/cli/src/runner/loop.ts";
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
it("refuses an inherited tracked .jarvis tree as well as additions", async () => {
  const f = fixture(); mkdirSync(join(f.repoPath, ".jarvis")); writeFileSync(join(f.repoPath, ".jarvis/forged.txt"), "old claim"); f.git(["add", "-f", ".jarvis/forged.txt"]); f.git(["commit", "-qm", "tracked runner metadata"]);
  expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
});
it("does not lose an uncharged usage checkpoint when the process restarts", async () => {
  const f = fixture(); let n = 0;
  f.setBody(async (input) => { if (++n === 1) { writeFileSync(join(input.workspace, "checkpoint"), "resume me"); return finished("usage-limited"); } expect(readFileSync(join(input.workspace, "checkpoint"), "utf8")).toBe("resume me"); return finished(); });
  await expect(runLoop({ ...f.options, reprobe: async () => false })).rejects.toThrow(/probe/);
  expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1"]); expect(f.calls[1]!.workspace).toBe(f.calls[0]!.workspace);
});
it("does not trust new evidence after it passed earlier checks but changed during review", async () => {
  const f = fixture(); let valid = true;
  const review = async () => { valid = false; return "pass" as const; };
  expect((await runLoop({ ...f.options, review, verifyEvidence: () => ({ ok: valid, problems: valid ? [] : ["changed"] }) })).blocked).toEqual(["T1"]);
  expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
});
it("does not release the run lease while other attempts are still shutting down", async () => {
  const f = fixture(2); let release!: () => void; let inInbox!: () => void;
  const entered = new Promise<void>((r) => { inInbox = r; });
  f.setBody(async (input) => { if (input.prompt.includes("Task: T1")) await new Promise<void>((r) => { release = r; }); else submitSteer(f.projectDir, "T1 update"); return finished(); });
  let settled = false;
  const pending = runLoop({ ...f.options, applyInbox: async () => { inInbox(); throw new Error("stop inbox"); } }).catch((e: unknown) => { settled = true; return e; });
  await entered; await new Promise((r) => setTimeout(r, 10)); const settledBeforeExit = settled; release();
  const error = await pending; expect(settledBeforeExit).toBe(false); expect(String(error)).toContain("stop inbox");
});
it("a recovery pass cannot review a candidate while usage dispatch is paused", async () => {
  const f = fixture(); await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "candidate-committed") throw new Error("stop"); } })).rejects.toThrow("stop");
  f.ledger.append({ kind: "usage_wait", actor: "runner", data: { until: 4000 } });
  await expect(runLoop({ ...f.options, pidAlive: () => false, reprobe: async () => false })).rejects.toThrow(/probe/); expect(f.gate).not.toHaveBeenCalled();
});
it("enforces the task timeout on the captured process group even if a harness reports success", async () => {
  const f = fixture(); let n = 0; let release!: () => void;
  const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => { release?.(); });
  const harness = { runTask: vi.fn(async (input: LoopTaskInput) => { const id = 70000 + n++; input.onSpawn(id); if (n === 1) await new Promise<void>((r) => { release = r; }); input.onGroupExit(id); return finished(); }) };
  expect((await runLoop({ ...f.options, harness, kill, taskTimeoutMs: 20 })).done).toEqual(["T1"]);
  expect(kill).toHaveBeenCalledWith(-70000, "SIGTERM"); expect(harness.runTask).toHaveBeenCalledTimes(2);
});
