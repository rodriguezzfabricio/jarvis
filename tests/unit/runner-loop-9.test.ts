// Runner loop tests, part 9 of 9 (usage resets across tasks, recorded review verdicts). The loop tests are spread over nine files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { data, finished, fixture, type Fixture, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

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
