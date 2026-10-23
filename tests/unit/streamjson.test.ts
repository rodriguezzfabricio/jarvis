import { describe, expect, it } from "vitest";
import { hitRateLimitError, parseStreamJson, rateLimits, usageWaitUntil } from "../../packages/cli/src/harness/claude/streamjson.ts";

const ev = (status: string, five: number, seven: number) =>
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: 1000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: five, resetsAt: 1000 }, seven_day: { utilization: seven, resetsAt: 9000 } } } });

describe("usage limits (decision 62)", () => {
  it("keeps each window's own reset time", () => {
    const [r] = rateLimits(parseStreamJson(ev("allowed", 0.1, 0.2)));
    expect(r?.windows).toEqual({ five_hour: { utilization: 0.1, resetsAt: 1000 }, seven_day: { utilization: 0.2, resetsAt: 9000 } });
  });

  it("waits for the window that is actually over the threshold", () => {
    expect(usageWaitUntil(rateLimits(parseStreamJson(ev("allowed", 0.1, 0.2))))).toBeUndefined();
    expect(usageWaitUntil(rateLimits(parseStreamJson(ev("allowed", 0.9, 0.2))))).toBe(1000);
    expect(usageWaitUntil(rateLimits(parseStreamJson(ev("allowed", 0.1, 0.95))))).toBe(9000);
    expect(usageWaitUntil(rateLimits(parseStreamJson(ev("allowed", 0.9, 0.95))))).toBe(9000);
  });

  it("treats a rejected event or an assistant rate_limit error as a limit", () => {
    expect(usageWaitUntil(rateLimits(parseStreamJson(ev("rejected", 0.5, 0.2))))).toBe(1000);
    const events = parseStreamJson(JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [] } }));
    expect(hitRateLimitError(events)).toBe(true);
    expect(usageWaitUntil([], { limitedByError: true })).toBeGreaterThan(Date.now() / 1000);
  });
});
