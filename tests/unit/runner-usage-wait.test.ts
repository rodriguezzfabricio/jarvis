import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { activeUsageWait, waitForUsage } from "../../packages/cli/src/runner/usage-wait.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const result = (extra: Partial<TaskOutcome> = {}): TaskOutcome => ({ status: "finished", exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined, ...extra } as TaskOutcome);
function setup() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-wait-")); roots.push(root);
  const ledger = Ledger.open(root);
  let time = 1_000_000;
  const calls: string[] = [];
  const sleep = vi.fn(async (ms: number) => { calls.push("sleep"); time += ms; });
  const notify = vi.fn(async () => { calls.push("notify"); });
  const reprobe = vi.fn(async () => { calls.push("probe"); return true; });
  return { ledger, calls, sleep, notify, reprobe, now: () => time };
}

describe("usage waits", () => {
  it("logs before waiting, adds a reset margin, re-probes, and never ends an attempt", async () => {
    const s = setup();
    const sleep = async (ms: number) => {
      expect(s.ledger.entries()).toHaveLength(1);
      expect(s.ledger.entries()[0]).toMatchObject({ kind: "usage_wait", actor: "runner", task_id: "T1", attempt_id: "A1" });
      await s.sleep(ms);
    };
    expect(await waitForUsage({ outcome: result({ status: "usage-limited", resetAt: 1060 }), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, { ...s, sleep, marginMs: 30_000 })).toBe("resume");
    expect(s.now()).toBe(1_090_000);
    expect(s.calls.at(-1)).toBe("probe");
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.ledger.entries().map((e) => e.kind)).toEqual(["usage_wait"]);
    expect(s.ledger.entries()[0]?.data).toMatchObject({ until: 1_090_000, resumeAt: 1_090_000, reason: "usage-limited", countsAsFailure: false });
  });

  it("waits proactively after a finished session near its usage window", async () => {
    const s = setup();
    expect(await waitForUsage({ outcome: result({ usageWaitUntil: 1060 }), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, { ...s, marginMs: 0 })).toBe("resume");
    expect(s.now()).toBe(1_060_000);
  });

  it.each([undefined, 999, Number.NaN, Number.POSITIVE_INFINITY])("uses bounded backoff for a missing, past or invalid reset %j", async (resetAt) => {
    const s = setup();
    await waitForUsage({ outcome: result({ status: "usage-limited", resetAt }), ledger: s.ledger, taskId: "T1", attemptId: "A1", backoffAttempt: 1000 }, { ...s, marginMs: 0 });
    expect(s.now() - 1_000_000).toBe(300_000);
    expect(s.reprobe).toHaveBeenCalledOnce();
  });

  it.each([[7200, false], [7201, true]] as const)("only notifies for waits longer than two hours (%s seconds)", async (seconds, notified) => {
    const s = setup();
    await waitForUsage({ outcome: result({ status: "usage-limited", resetAt: 1000 + seconds }), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, { ...s, marginMs: 0 });
    expect(s.notify).toHaveBeenCalledTimes(notified ? 1 : 0);
    expect(s.sleep.mock.calls.every(([ms]) => ms <= 60_000)).toBe(true);
  });

  it("continues after a notifier failure but refuses resume if the canary fails", async () => {
    const s = setup();
    const notify = vi.fn(async () => { throw new Error("offline"); });
    await expect(waitForUsage({ outcome: result({ status: "usage-limited", resetAt: 9000 }), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, { ...s, notify, reprobe: async () => false })).rejects.toThrow(/probe/i);
    expect(s.now()).toBe(9_030_000);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not sleep, notify, re-probe or log when usage permits dispatch", async () => {
    const s = setup();
    expect(await waitForUsage({ outcome: result(), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, s)).toBe("continue");
    expect(s.calls).toEqual([]);
    expect(s.ledger.entries()).toEqual([]);
  });

  it("stops before sleeping if the ledger cannot durably record the wait", async () => {
    const s = setup();
    const ledger = { append: () => { throw new Error("disk full"); } };
    await expect(waitForUsage({ outcome: result({ status: "usage-limited", resetAt: 1060 }), ledger, taskId: "T1", attemptId: "A1" }, s)).rejects.toThrow("disk full");
    expect(s.calls).toEqual([]);
  });

  it("checks the clock again after an early sleep return", async () => {
    const s = setup();
    let time = s.now();
    const sleep = vi.fn(async (ms: number) => { time += Math.min(ms, 10_000); });
    await waitForUsage({ outcome: result({ status: "usage-limited", resetAt: 1030 }), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, { ...s, now: () => time, sleep, marginMs: 0 });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(time).toBe(1_030_000);
  });
});


describe("account-wide usage pause", () => {
  it("continues immediately when a proactive reset is already past", async () => {
    const s = setup();
    expect(await waitForUsage({ outcome: result({ usageWaitUntil: 999 }), ledger: s.ledger, taskId: "T1", attemptId: "A1" }, s)).toBe("continue");
    expect(s.calls).toEqual([]);
    expect(s.ledger.entries()).toEqual([]);
  });

  it("holds all tasks until the latest unexpired account-wide wait", async () => {
    const s = setup();
    s.ledger.append({ kind: "usage_wait", actor: "runner", task_id: "T1", data: { until: 1_500_000 } });
    s.ledger.append({ kind: "usage_wait", actor: "runner", task_id: "T2", data: { until: 1_300_000 } });
    s.ledger.append({ kind: "usage_wait", actor: "runner", task_id: "T3", data: { until: 999_000 } });
    s.ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T4", data: { until: 9_000_000 } });
    expect(activeUsageWait(s.ledger.entries(), s.now())).toBe(1_500_000);
    expect(activeUsageWait(s.ledger.entries(), 1_500_000)).toBeUndefined();
    expect(activeUsageWait([], s.now())).toBeUndefined();
  });

  it("ignores malformed wait records", () => {
    const s = setup();
    for (const data of [null, { until: "forever" }, {}, { until: Number.NaN }, { until: Number.POSITIVE_INFINITY }]) s.ledger.append({ kind: "usage_wait", actor: "runner", data });
    expect(activeUsageWait(s.ledger.entries(), s.now())).toBeUndefined();
  });
});
