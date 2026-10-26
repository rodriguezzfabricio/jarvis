// Runner loop tests, part 7 of 7 (attempt bookkeeping). The loop tests are spread over seven files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoop, type LoopTaskInput } from "../../packages/cli/src/runner/loop.ts";
import { finished, fixture, recordGate, removeFixtureRoots, taskOf } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

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
    // The loop escalates 1 s after SIGTERM. The same 1.3 s deadline as a fixed wait, but it returns as soon as the SIGKILL arrives.
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-80_000, "SIGKILL"), { timeout: 1_300, interval: 20 });
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
