// Runner loop tests, part 5 of 9 (real gates, usage barriers on reviews). The loop tests are spread over nine files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { data, finished, fixture, recordGate, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

it("ships unique mutation definitions whose anchors each occur once", () => {
  const definitions = JSON.parse(readFileSync(new URL("../../packages/cli/src/runner/mutations-loop.json", import.meta.url), "utf8")) as { name: string; file: string; anchor: string; replacement: string }[];
  expect(definitions.length).toBeGreaterThanOrEqual(12); expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
  for (const d of definitions) expect(readFileSync(new URL(`../../${d.file}`, import.meta.url), "utf8").split(d.anchor)).toHaveLength(2);
});
it("uses the injected process killer when cleaning a crashed attempt", async () => {
  const f = fixture(); const kill = vi.fn();
  await expect(runLoop({ ...f.options, kill, onCheckpoint: () => { throw new Error("kill here"); } })).rejects.toThrow("kill here");
  await runLoop({ ...f.options, kill, pidAlive: () => false }); expect(kill).toHaveBeenCalledWith(-2_000_000_000, "SIGKILL");
});
it("runs every required check before deciding repair, even when the first check fails", async () => {
  const f = fixture(); f.options.plan = { tasks: [{ id: "T2", dependencies: ["T1"], requiredChecks: ["unit"] }] };
  f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T3", data: { requiredChecks: ["unit", "acceptance"] } });
  f.options.checks = { ...f.options.checks, acceptance: { ...f.options.checks.unit!, name: "acceptance" } };
  f.gate.mockImplementation(async (g) => recordGate(g, g.check.name === "unit" ? "fail" : "pass"));
  await runLoop({ ...f.options, maxConcurrent: 1 });
  expect(f.gate.mock.calls.filter(([g]) => g.taskId === "T3").map(([g]) => g.check.name)).toEqual(["unit", "acceptance", "unit", "acceptance", "unit", "acceptance"]); expect(f.review).not.toHaveBeenCalled();
}, 60_000); // runs real gates; slow under load
it("recovers a recorded timeout candidate as a charged failure", async () => {
  const f = fixture(); let n = 0; f.setBody(async () => finished(++n === 1 ? "timeout" : "finished"));
  await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "candidate-committed") throw new Error("timeout crash"); } })).rejects.toThrow("timeout crash");
  await runLoop({ ...f.options, pidAlive: () => false });
  expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(1);
});
it("holds fresh reviews while another in-flight task is waiting for account usage", async () => {
  const f = fixture(2); let limited = false, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const released = new Promise<void>((r) => { release = r; });
  f.setBody(async (input) => { if (input.prompt.includes("Task: T1") && !limited) { limited = true; return finished("usage-limited"); } return finished(); });
  const sleep = async (ms: number) => { entered(); await released; await f.sleep(ms); };
  const pending = runLoop({ ...f.options, sleep });
  await waiting; await new Promise((r) => setTimeout(r, 20)); const reviewsBeforeReset = f.review.mock.calls.length; release();
  // T1's candidate is built on the old head, so it is merged onto T2's promotion and reviewed again.
  await pending; expect(reviewsBeforeReset).toBe(0); expect(f.review).toHaveBeenCalledTimes(3);
});
