import { describe, expect, it } from "vitest";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { runCanaryProbe } from "../../packages/cli/src/doctor/canary.ts";

// Runs the real, pinned Claude Code (a few cents of plan usage). Only with JARVIS_LIVE=1.
describe.skipIf(process.env.JARVIS_LIVE !== "1")("live canary probe on the pinned Claude Code", () => {
  it("holds: secret unreadable, network closed, runner folder protected, worktree usable", async () => {
    const r = await runCanaryProbe({ claudeBin: pinnedClaudeBin() });
    for (const c of r.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  }, 300_000);
});
