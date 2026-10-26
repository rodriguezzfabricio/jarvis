// Runner loop tests, part 2 of 6 (usage waits, timeouts, refused sessions, run lease, inbox replay, crash recovery). The loop tests are spread over six files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runLoop, type LoopTaskInput } from "../../packages/cli/src/runner/loop.ts";
import { submitSteer } from "../../packages/cli/src/runner/inbox.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { finished, fixture, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

describe("runner loop", () => {
  it("resumes a usage-limited attempt in the same workspace without charging repairs", async () => {
    const f = fixture(); let n = 0;
    f.setBody(async (input) => { if (++n === 1) { writeFileSync(join(input.workspace, "checkpoint"), "keep"); return finished("usage-limited"); } expect(readFileSync(join(input.workspace, "checkpoint"), "utf8")).toBe("keep"); return finished(); });
    expect((await runLoop({ ...f.options, maxConcurrent: 1 })).done).toEqual(["T1"]);
    expect(f.calls[0]!.workspace).toBe(f.calls[1]!.workspace); expect(f.gate).toHaveBeenCalledOnce(); expect(f.sleep).toHaveBeenCalled();
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(0);
    expect(new Set(f.ledger.entries().filter((e) => e.kind === "attempt_started").map((e) => e.attempt_id)).size).toBe(1);
  });
  it("holds all new dispatch during an account-wide wait and reprobes", async () => {
    const f = fixture(2); const reprobe = vi.fn(async () => true);
    f.ledger.append({ kind: "usage_wait", actor: "runner", data: { until: 3000 } });
    f.setBody(async () => { expect(f.options.now!()).toBeGreaterThanOrEqual(3000); expect(reprobe).toHaveBeenCalled(); return finished(); });
    await runLoop({ ...f.options, reprobe }); expect(f.sleep).toHaveBeenCalled();
  });
  it("a failed reset probe prevents further dispatch", async () => {
    const f = fixture(); f.setBody(async () => finished("usage-limited"));
    await expect(runLoop({ ...f.options, reprobe: async () => false })).rejects.toThrow(/probe/); expect(f.calls).toHaveLength(1);
  });
  it("charges timeout as a failure even when the partial candidate's checks would pass", async () => {
    const f = fixture(); let n = 0; f.setBody(async () => finished(++n === 1 ? "timeout" : "finished"));
    expect((await runLoop({ ...f.options, taskTimeoutMs: 1234 })).done).toEqual(["T1"]); expect(f.calls).toHaveLength(2); expect(f.calls[0]!.timeoutMs).toBe(1234);
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(1);
  });
  it("a refused session blocks without gates or a repair", async () => {
    const f = fixture(); f.setBody(async () => ({ ...finished(), status: "refused", reason: "sandbox unavailable" }));
    expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.calls).toHaveLength(1); expect(f.gate).not.toHaveBeenCalled();
  });
  it("fails closed when process identity cannot be captured", async () => {
    const f = fixture(); expect((await runLoop({ ...f.options, readProcessStartTime: () => null })).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
  });
  it("does not accept an attempt whose whole process group has not exited", async () => {
    const f = fixture(); f.options.harness = { runTask: async (input: LoopTaskInput) => { input.onSpawn(60000); return finished(); } };
    await expect(runLoop(f.options)).rejects.toThrow(/group.*exit/); expect(f.gate).not.toHaveBeenCalled();
  });
  it("holds an exclusive run lease even between task dispatches", async () => {
    const f = fixture(); let release!: () => void, entered!: () => void; const enteredPromise = new Promise<void>((r) => { entered = r; });
    f.setBody(async () => { entered(); await new Promise<void>((r) => { release = r; }); return finished(); });
    const first = runLoop(f.options); await enteredPromise;
    await expect(runLoop(f.options)).rejects.toThrow(/lease|active/); release(); await first;
  });
  it("replays inbox actions only after their effects are durable", async () => {
    const f = fixture(); submitSteer(f.projectDir, "T1 change the goal"); let first = true;
    const applyInbox = vi.fn(async (_action, ledger: Ledger) => { if (first) { first = false; throw new Error("inbox crash"); } ledger.append({ kind: "decision", actor: "runner", data: { applied: true } }); });
    await expect(runLoop({ ...f.options, applyInbox })).rejects.toThrow("inbox crash");
    await runLoop({ ...f.options, applyInbox, pidAlive: () => false }); expect(applyInbox).toHaveBeenCalledTimes(2);
    const cursor = JSON.parse(readFileSync(join(f.projectDir, "inbox-cursor.json"), "utf8")); expect(cursor.seq).toBeGreaterThan(0);
  });
  it("recovers a crash mid-attempt, cleans its workspace and never reruns finished tasks", async () => {
    const f = fixture(2); let crash = true;
    const onCheckpoint = (name: string, taskId?: string) => { if (name === "spawned" && taskId === "T2" && crash) { crash = false; throw new Error("injected kill"); } };
    await expect(runLoop({ ...f.options, maxConcurrent: 1, onCheckpoint })).rejects.toThrow("injected kill");
    expect(f.ledger.entries().filter((e) => e.kind === "run_ended")).toHaveLength(0);
    expect((await runLoop({ ...f.options, maxConcurrent: 1, pidAlive: () => false })).done).toEqual(["T1", "T2"]);
    expect(f.calls.filter((c) => c.prompt.includes("Task: T1"))).toHaveLength(1);
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T2!)).toBe(0);
  });
});
