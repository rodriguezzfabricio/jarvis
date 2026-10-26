// Runner loop tests, part 6 of 6 (promotion integrity and attempt bookkeeping). The loop tests are spread over six files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runLoop, type LoopTaskInput, type RunLoopOptions } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { commitBase, data, expectEveryPromotedRevisionGated, finished, fixture, recordGate, removeFixtureRoots, showAt, taskOf } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

describe("promotion integrity", () => {
  it("promotes concurrent tasks only as revisions that were gated and reviewed", async () => {
    const f = fixture(3);
    f.setBody(async (input) => { await new Promise((r) => setTimeout(r, 10)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    const start = f.git(["rev-parse", "main"]);
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).status).toBe("complete");
    expectEveryPromotedRevisionGated(f, start);
  });

  it("re-gates a candidate merged onto a moved branch: a stale caller of a renamed API is caught and repaired", async () => {
    const f = fixture(2); commitBase(f, { "api.txt": "v1" });
    f.setBody(async (input) => {
      if (taskOf(input) === "T1") writeFileSync(join(input.workspace, "api.txt"), "v2");
      else { await new Promise((r) => setTimeout(r, 30)); writeFileSync(join(input.workspace, "caller.txt"), `uses ${readFileSync(join(input.workspace, "api.txt"), "utf8")}`); }
      writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished();
    });
    f.gate.mockImplementation(async (g) => { const caller = showAt(f, g.revision, "caller.txt"); return recordGate(g, caller !== null && caller !== `uses ${showAt(f, g.revision, "api.txt")}` ? "fail" : "pass"); });
    const start = f.git(["rev-parse", "main"]);
    expect(await runLoop({ ...f.options, maxConcurrent: 2 })).toEqual({ status: "complete", done: ["T1", "T2"], blocked: [] });
    expect(showAt(f, "last-green", "caller.txt")).toBe("uses v2");
    expect(f.calls.filter((c) => taskOf(c) === "T2")).toHaveLength(2);
    expect(f.calls.at(-1)!.prompt).toContain("Repair T2 (1/2)");
    expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "merge_candidate" && e.task_id === "T2")).toBe(true);
    expectEveryPromotedRevisionGated(f, start);
  });

  it("redoes a task whose candidate conflicts with the moved branch, without charging a repair", async () => {
    const f = fixture(2); commitBase(f, { "shared.txt": "base" });
    f.setBody(async (input) => {
      const shared = join(input.workspace, "shared.txt");
      if (taskOf(input) === "T1") writeFileSync(shared, "one");
      else { await new Promise((r) => setTimeout(r, 30)); writeFileSync(shared, `${readFileSync(shared, "utf8")}+two`); }
      return finished();
    });
    const start = f.git(["rev-parse", "main"]);
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).status).toBe("complete");
    const t2 = f.calls.filter((c) => taskOf(c) === "T2");
    expect(t2).toHaveLength(2);
    expect(t2[1]!.prompt).toMatch(/run branch moved/i); expect(t2[1]!.prompt).not.toContain("Repair");
    expect(showAt(f, "last-green", "shared.txt")).toBe("one+two");
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T2!)).toBe(0);
    expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "stale_base" && e.task_id === "T2")).toBe(true);
    expectEveryPromotedRevisionGated(f, start);
  });

  it("a promotion that git refuses blocks the task instead of crashing this run or the next", async () => {
    const f = fixture();
    const git: NonNullable<RunLoopOptions["git"]> = (cwd, args, opts) => { if (args.includes("--ff-only")) throw new Error("merge refused"); return safeGit(cwd, args, opts); };
    expect(await runLoop({ ...f.options, git })).toEqual({ status: "blocked", done: [], blocked: ["T1"] });
    expect(f.ledger.entries().some((e) => e.kind === "blocked" && /promotion/.test(String(data(e).reason)))).toBe(true);
    await expect(runLoop({ ...f.options, git })).resolves.toMatchObject({ status: "blocked" });
  });

  it("records a task passed only once it is promoted, so dependents wait for the promotion", async () => {
    const f = fixture(); f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { dependencies: ["T1"] } });
    let crash = true;
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "passed" && taskId === "T1" && crash) { crash = false; throw new Error("before promotion"); } } })).rejects.toThrow("before promotion");
    expect(f.ledger.entries().filter((e) => e.kind === "state_reached")).toEqual([]);
    expect(f.calls.map(taskOf)).toEqual(["T1"]);
    expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1", "T2"]);
    expect(f.calls.map(taskOf)).toEqual(["T1", "T2"]);
  });

  it("keeps promoting across consecutive runs when the repo doesn't ignore .jarvis/", async () => {
    const f = fixture(); writeFileSync(join(f.repoPath, ".gitignore"), ""); f.git(["add", "-A"]); f.git(["commit", "-qm", "no ignore"]);
    expect((await runLoop(f.options)).done).toEqual(["T1"]);
    f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: {} });
    expect((await runLoop(f.options)).done).toEqual(["T1", "T2"]);
    expect(f.git(["status", "--porcelain"])).toBe("");
  });
});

describe("attempt bookkeeping", () => {
  it("keeps the repair prompt when a repair attempt crashed before finishing", async () => {
    const f = fixture(); let gates = 0; let spawns = 0;
    f.gate.mockImplementation(async (g) => recordGate(g, ++gates === 1 ? "fail" : "pass"));
    await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "spawned" && ++spawns === 2) throw new Error("crash in repair"); } })).rejects.toThrow("crash in repair");
    expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1"]);
    expect(f.calls).toHaveLength(3); expect(f.calls[2]!.prompt).toContain("Repair T1 (1/2)"); expect(f.calls[2]!.failure).toBe("gate_fail");
  });

  it("requires a captured process group for a usage-limited session that ran", async () => {
    const f = fixture();
    const usage = { reportedModel: undefined, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 1, complete: false };
    f.options.harness = { runTask: vi.fn(async () => ({ ...finished("usage-limited"), sessionUsage: usage })) };
    expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
  });

  it("waits out a usage limit reported before any session started (no group to capture)", async () => {
    const f = fixture(); const runTask = f.harness.runTask; let first = true;
    f.options.harness = { runTask: vi.fn(async (input: LoopTaskInput) => { if (first) { first = false; return { ...finished("usage-limited"), exitCode: null, durationMs: 0 }; } return runTask(input); }) };
    expect((await runLoop(f.options)).done).toEqual(["T1"]); expect(f.sleep).toHaveBeenCalled();
  });

  it("keeps the SIGKILL escalation armed after the harness returns while the group is alive", async () => {
    const f = fixture(); const kill = vi.fn();
    const harness = { runTask: async (input: LoopTaskInput) => { input.onSpawn(80_000); await new Promise((r) => setTimeout(r, 60)); return finished(); } };
    await expect(runLoop({ ...f.options, harness, kill, taskTimeoutMs: 20 })).rejects.toThrow(/group.*exit/);
    expect(kill).toHaveBeenCalledWith(-80_000, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(kill).toHaveBeenCalledWith(-80_000, "SIGKILL");
  });

  it("does not let a reused PID hold a dead run's lease", async () => {
    const f = fixture();
    f.ledger.append({ kind: "reconciled", actor: "runner", data: { type: "run_lease_acquired", runId: "old-run", pid: process.pid, startedAt: "a process that has since exited" } });
    expect((await runLoop(f.options)).done).toEqual(["T1"]);
  });

  it("still refuses a lease whose holder is the same live process", async () => {
    const f = fixture();
    f.ledger.append({ kind: "reconciled", actor: "runner", data: { type: "run_lease_acquired", runId: "live-run", pid: process.pid, startedAt: "started" } });
    await expect(runLoop(f.options)).rejects.toThrow(/lease/);
  });

  it("stops an in-flight session's candidate from being gated once the run has failed", async () => {
    const f = fixture(2);
    f.setBody(async (input) => { if (taskOf(input) === "T1") await new Promise((r) => setTimeout(r, 50)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "spawned" && taskId === "T2") throw new Error("fatal"); } })).rejects.toThrow("fatal");
    expect(f.gate).not.toHaveBeenCalled();
  });

  it("stops an in-flight verification from promoting once the run has failed", async () => {
    const f = fixture(2);
    f.setBody(async (input) => { if (taskOf(input) === "T2") await new Promise((r) => setTimeout(r, 10)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    f.gate.mockImplementation(async (g) => { await new Promise((r) => setTimeout(r, 60)); return recordGate(g, "pass"); });
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "spawned" && taskId === "T2") throw new Error("fatal"); } })).rejects.toThrow("fatal");
    expect(f.gate).toHaveBeenCalled();
    expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
    expect(f.ledger.entries().filter((e) => e.kind === "state_reached")).toEqual([]);
  });

  it("logs one session_usage entry per session with its route", async () => {
    const f = fixture();
    const usage = { reportedModel: "claude-sonnet-5-5", inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, turns: 2, complete: true };
    f.setBody(async (input) => { writeFileSync(join(input.workspace, "T1.txt"), "ok"); return { ...finished(), sessionUsage: usage }; });
    await runLoop(f.options);
    const logged = f.ledger.entries().filter((e) => e.kind === "session_usage");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ task_id: "T1", data: { role: "build", tier: 1, model: "claude-sonnet-5-5", status: "finished", tokens: { input: 5, output: 6 } } });
    const report = readFileSync(join(f.repoPath, ".jarvis/REPORT.md"), "utf8");
    expect(report).toContain("## Usage"); expect(report).toContain("## Footprint");
    expect(f.ledger.entries().filter((e) => e.kind === "footprint")).toHaveLength(1);
  });
});
