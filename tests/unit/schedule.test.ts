import { describe, expect, it } from "vitest";
import type { BaselineRunResult, GoldenTask } from "../../packages/cli/src/eval/baseline.ts";
import { PreflightError, runSchedule, type ScheduleDeps } from "../../packages/cli/src/eval/schedule.ts";

const task = (id: string) => ({ id }) as GoldenTask;
const result = (over: Partial<BaselineRunResult> = {}) =>
  ({ started: true, exitCode: 0, timedOut: false, resultSubtype: "success", numTurns: 3, durationMs: 60_000, diffStat: "", usageLimited: false, usageWaitUntil: undefined, ...over }) as BaselineRunResult;

function deps(script: (id: string, call: number) => BaselineRunResult | Error): ScheduleDeps & { sleeps: number[]; calls: string[] } {
  let now = 1_000_000_000_000;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const counts = new Map<string, number>();
  return {
    calls,
    sleeps,
    loadTask: task,
    runOne: async (t) => {
      const n = (counts.get(t.id) ?? 0) + 1;
      counts.set(t.id, n);
      calls.push(t.id);
      const r = script(t.id, n);
      if (r instanceof Error) throw r;
      return r;
    },
    sleepUntil: async (s) => {
      sleeps.push(s);
      now = Math.max(now, s * 1000);
    },
    nowMs: () => now,
    log: () => {},
  };
}
const soon = () => Math.floor(1_000_000_000_000 / 1000) + 3600;

describe("baseline scheduling (decisions 3, 62; Codex review 2)", () => {
  it("retries a usage-limited task until it completes, without skipping it", async () => {
    const d = deps((id, n) => (id === "a" && n <= 4 ? result({ usageLimited: true, usageWaitUntil: soon() }) : result()));
    const out = await runSchedule(["a", "b"], 1, "", d);
    expect(d.calls).toEqual(["a", "a", "a", "a", "a", "b"]);
    expect(out.completed.map((c) => c.task)).toEqual(["a", "b"]);
    expect(out.stopped).toBeUndefined();
    expect(d.sleeps).toHaveLength(4);
  });

  it("waits when the preflight itself hits a usage limit, then runs the task", async () => {
    const d = deps((_id, n) => (n === 1 ? new PreflightError("probe limited", soon()) : result()));
    const out = await runSchedule(["a"], 1, "", d);
    expect(out.completed.map((c) => c.task)).toEqual(["a"]);
    expect(d.sleeps).toHaveLength(1);
  });

  it("stops the chain, recorded, when the preflight fails for any other reason", async () => {
    const d = deps(() => new PreflightError("sandbox did not hold"));
    const out = await runSchedule(["a", "b"], 1, "", d);
    expect(d.calls).toEqual(["a"]);
    expect(out.stopped?.task).toBe("a");
    expect(out.stopped?.reason).toMatch(/preflight failed/);
  });

  it("stops, recorded, instead of waiting longer than the cap", async () => {
    const d = deps(() => result({ usageLimited: true, usageWaitUntil: soon() + 3 * 86400 }));
    const out = await runSchedule(["a"], 1, "", d);
    expect(out.stopped?.reason).toMatch(/resets in/);
    expect(out.completed).toEqual([]);
  });

  it("stops, recorded, after too many consecutive usage waits", async () => {
    const d = deps(() => result({ usageLimited: true, usageWaitUntil: soon() }));
    const out = await runSchedule(["a"], 1, "", { ...d, maxUsageRetries: 3 });
    expect(out.stopped?.reason).toMatch(/still usage-limited/);
  });

  // Codex review 3, medium: nothing waits or "stops" after the last run.
  it("returns at once after the final task, even if usage is high or resets beyond the cap", async () => {
    for (const until of [soon(), soon() + 28 * 3600]) {
      const d = deps(() => result({ usageWaitUntil: until }));
      const out = await runSchedule(["a"], 1, "", d);
      expect(out.completed).toHaveLength(1);
      expect(out.stopped).toBeUndefined();
      expect(d.sleeps).toEqual([]);
    }
  });

  // Codex review 3, medium: a session that never started is not a recorded baseline.
  it("stops, recorded, when a session did not start, without counting it", async () => {
    const d = deps(() => result({ started: false }));
    const out = await runSchedule(["a", "b"], 1, "", d);
    expect(out.completed).toEqual([]);
    expect(out.stopped?.reason).toMatch(/did not start/);
  });

  it("stops, recorded, when the run itself throws (e.g. the binary vanished)", async () => {
    const d = deps(() => new Error("SessionStartError: could not start claude"));
    const out = await runSchedule(["a"], 1, "", d);
    expect(out.stopped?.reason).toMatch(/run error/);
  });

  it("finishes a run that only left usage high, then waits before the next task", async () => {
    const d = deps((id) => (id === "a" ? result({ usageWaitUntil: soon() }) : result()));
    const out = await runSchedule(["a", "b"], 1, "", d);
    expect(d.calls).toEqual(["a", "b"]);
    expect(out.completed).toHaveLength(2);
    expect(d.sleeps).toHaveLength(1);
  });
});
