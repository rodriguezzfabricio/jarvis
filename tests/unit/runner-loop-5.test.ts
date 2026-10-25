// Runner loop tests, part 5 of 6 (real gates, usage barriers on reviews, recorded review verdicts). The loop tests are spread over six files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { data, finished, fixture, type Fixture, recordGate, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

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
it("resumes no attempt before the latest account-wide reset and does not acknowledge future waits", async () => {
  const f = fixture(2); const limited = new Set<string>(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), released = new Promise<void>((r) => { release = r; });
  f.setBody(async (input) => { const id = /Task: (T\d+)/.exec(input.prompt)![1]!; if (limited.has(id)) return finished(); limited.add(id); return { ...finished("usage-limited"), resetAt: id === "T1" ? 2 : 5 }; });
  const sleep = async (ms: number) => { if (ms > 1000) { entered(); await released; } await f.sleep(ms); };
  const pending = runLoop({ ...f.options, sleep });
  await waiting; await new Promise((r) => setTimeout(r, 20)); const callsBeforeLastReset = f.calls.length; release();
  await pending; expect(callsBeforeLastReset).toBe(2); expect(f.calls).toHaveLength(4);
});
describe("recorded review verdicts (review service)", () => {
  // The service appends its own review_result; the loop must not add a second one.
  const recordingReview = (f: Fixture, statuses: ("pass" | "fail" | "investigate" | "error")[]) => vi.fn(async (r: { taskId: string; attemptId: string; revision: string }) => {
    const status = statuses.shift() ?? "pass";
    f.ledger.append({ kind: "review_result", actor: "runner", task_id: r.taskId, attempt_id: r.attemptId, data: { reviewer: "code", revision: r.revision, status } });
    return { status, recorded: true as const };
  });
  const reviewEntries = (f: Fixture) => f.ledger.entries().filter((e) => e.kind === "review_result");

  it("passes on a recorded pass without recording a second verdict", async () => {
    const f = fixture(); const review = recordingReview(f, ["pass"]);
    expect((await runLoop({ ...f.options, review })).done).toEqual(["T1"]);
    expect(reviewEntries(f)).toHaveLength(1);
  });

  it("retries a review infrastructure error once, without a builder repair", async () => {
    const f = fixture(); const review = recordingReview(f, ["error", "pass"]);
    expect((await runLoop({ ...f.options, review })).done).toEqual(["T1"]);
    expect(review).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(1);
  });

  it("blocks after a second review error, still without a builder repair", async () => {
    const f = fixture(); const review = recordingReview(f, ["error", "error", "pass"]);
    expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]);
    expect(review).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(1);
  });

  it("blocks for a person when the review needs investigation", async () => {
    const f = fixture(); const review = recordingReview(f, ["investigate"]);
    expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]);
    expect(f.calls).toHaveLength(1);
    expect(f.ledger.entries().some((e) => e.kind === "blocked" && /investigation/.test(String(data(e).reason)))).toBe(true);
  });

  it("refuses a recorded verdict that the ledger doesn't show", async () => {
    const f = fixture(); const review = vi.fn(async () => ({ status: "pass" as const, recorded: true as const }));
    expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]);
    expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
  });
});
