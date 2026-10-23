import { describe, expect, it } from "vitest";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { runCanaryProbe } from "../../packages/cli/src/harness/claude/probe.ts";

// Runs the real, pinned Claude Code (a few cents of plan usage). Only with JARVIS_LIVE=1.
describe.skipIf(process.env.JARVIS_LIVE !== "1")("live canary probe on the pinned Claude Code", () => {
  it("holds: runner folder and outside files unreadable, network closed, project hooks inert, worktree usable", async () => {
    const r = await runCanaryProbe({ claudeBin: pinnedClaudeBin() });
    for (const c of r.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  }, 300_000);

  it("negative control: started the old way (--setting-sources project), it catches the project hook", async () => {
    const r = await runCanaryProbe({
      claudeBin: pinnedClaudeBin(),
      negativeControlArgs: (a) => {
        const i = a.indexOf("--restricted");
        const j = a.indexOf("--tools");
        return a.filter((_, k) => k !== i && k !== j && k !== j + 1).concat(["--setting-sources", "project"]);
      },
    });
    for (const c of r.checks) console.log(`${c.ok ? "ok  " : "FAIL"} [negative control] ${c.name}: ${c.detail}`);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "project_hooks_not_run")?.ok).toBe(false);
  }, 300_000);
});
