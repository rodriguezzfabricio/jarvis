import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, confirmation, limitText, shouldSend } from "../../packages/cli/src/notify/notifier.ts";
import { LedgerTamperError } from "../../packages/cli/src/ledger/ledger.ts";
import { waitForIntake } from "../../packages/cli/src/notify/intake.ts";

describe("notification messages", () => {
  it("keeps text strictly under 4 KiB without splitting Unicode and points to REPORT.md", () => {
    const text = limitText("🙂é".repeat(2000));
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
    expect(text).not.toContain("�");
    expect(text).toMatch(/REPORT\.md/);
    expect(limitText("hello")).toBe("hello");
    expect(limitText("a".repeat(4096))).toMatch(/REPORT\.md/);
  });
  it("builds the fixed question and approval choices and confirmations", () => {
    expect(actionsFor("question", "q", "nonce")).toEqual([{ answer: "defaults", requestId: "q", nonce: "nonce", label: "Use defaults" }]);
    expect(actionsFor("approval", "a", "nonce").map((a) => a.label)).toEqual(["Approve", "Reject"]);
    expect(actionsFor("blocked", "b", "nonce")).toEqual([]);
    expect(confirmation("approve", "a")).toEqual({ kind: "confirmation", text: "Got it: Approve (request a)" });
  });
  it("sends usage waits only when strictly longer than two hours", () => {
    expect(shouldSend({ kind: "usage-wait", text: "wait", waitMs: 7_200_000 })).toBe(false);
    expect(shouldSend({ kind: "usage-wait", text: "wait", waitMs: 7_200_001 })).toBe(true);
    expect(shouldSend({ kind: "finished", text: "Preview ready" })).toBe(true);
  });
});

describe("intake wait", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });
  function clock() {
    const sleeps: number[] = [];
    return { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Honors abort by ending the sleep early. It resolves rather than rejects, so a mutation that
        // drops the deadline race cannot leave an unhandled rejection in place of a failed assertion.
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }, sleeps };
  }

  it("returns defaults (unconfirmed) at fifteen minutes without real sleeps", async () => {
    const c = clock();
    const result = waitForIntake(async () => [], { clock: c });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ status: "defaults (unconfirmed)" });
    expect(c.now()).toBe(900_000);
  });
  it("returns answers and uses a configurable timeout without overshooting", async () => {
    const c = clock();
    expect(await waitForIntake(async () => ["Use defaults"], { clock: c })).toEqual({ status: "answers", answers: ["Use defaults"] });
    expect(vi.getTimerCount()).toBe(0);
    c.sleeps.length = 0;
    const result = waitForIntake(async () => [], { clock: c, timeoutMs: 25, pollMs: 10 });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ status: "defaults (unconfirmed)" });
    expect(c.sleeps).toEqual([25, 10, 10, 5]);
    expect(c.now()).toBe(25);
  });
  it("does not count an answer that arrives at or after the deadline", async () => {
    const c = clock();
    const result = waitForIntake(async () => { await c.sleep(30); return ["late"]; }, { clock: c, timeoutMs: 30 });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ status: "defaults (unconfirmed)" });
    await expect(waitForIntake(async () => [], { clock: c, pollMs: 0 })).rejects.toThrow();
  });
  it("returns at the deadline even when polling never settles", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const c = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
      let settled: unknown;
      void waitForIntake(async () => new Promise<string[]>(() => {}), { clock: c, timeoutMs: 25 }).then((value) => { settled = value; });
      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toEqual({ status: "defaults (unconfirmed)" });
    } finally { vi.useRealTimers(); }
  });

  it("rethrows ledger tampering instead of returning unconfirmed defaults", async () => {
    const c = clock();
    const error = new LedgerTamperError("tampered");
    const outcome = waitForIntake(async () => { throw error; }, { clock: c, timeoutMs: 25 }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses a five-second default polling interval", async () => {
    const c = clock();
    let calls = 0;
    const result = waitForIntake(async () => ++calls === 2 ? ["answer"] : [], { clock: c });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ status: "answers", answers: ["answer"] });
    expect(c.sleeps).toEqual([900_000, 5000]);
    expect(c.now()).toBe(5000);
  });

});
