import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runBaseline, usageWaitUntil, type GoldenTask } from "../../packages/cli/src/eval/baseline.ts";
import { fakeClaudeBin, shortTmp } from "../helpers.ts";

const root = shortTmp("jtb-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const task: GoldenTask = {
  id: "11-habit-tracker",
  title: "Brand-new web product",
  prompt: "Build me a habit tracker.",
  model: "claude-opus-5-5",
  maxTurns: 200,
  timeoutMinutes: 1,
  allowedDomains: ["registry.npmjs.org"],
  webResearch: true,
};

describe("baseline runs (decision 47)", () => {
  it("runs on a fresh snapshot and records evidence outside the workspace", async () => {
    const jarvisHome = join(root, "jhome");
    mkdirSync(jarvisHome);
    const r = await runBaseline(task, {
      claudeBin: fakeClaudeBin(root),
      jarvisHome,
      workRoot: join(root, "work"),
      runId: "r1",
      parentEnv: { HOME: root, USER: "t" },
      extraEnv: { FAKE_CLAUDE_MODE: "baseline" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.workspace.startsWith(r.resultsDir)).toBe(false);
    expect(r.resultSubtype).toBe("success");
    expect(r.rateLimits.at(-1)?.utilization.five_hour).toBe(0.42);
    expect(r.diffStat).toContain("1 file changed");
    for (const f of ["manifest.json", "stream.jsonl", "stderr.txt", "summary.json", "settings.json"]) expect(existsSync(join(r.resultsDir, f))).toBe(true);
    const settings = JSON.parse(readFileSync(join(r.resultsDir, "settings.json"), "utf8"));
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.autoMemoryEnabled).toBe(false);
    const manifest = JSON.parse(readFileSync(join(r.resultsDir, "manifest.json"), "utf8"));
    expect(manifest.args).toContain("--setting-sources");
    expect(manifest.args).not.toContain("--plugin-dir");
  });

  it("waits for the reset when the plan is rejected or nearly used up (decision 62)", () => {
    const at = 1792790000;
    expect(usageWaitUntil([{ status: "allowed", resetsAt: at, rateLimitType: "five_hour", utilization: { five_hour: 0.3 } }])).toBeUndefined();
    expect(usageWaitUntil([{ status: "allowed", resetsAt: at, rateLimitType: "five_hour", utilization: { five_hour: 0.9 } }])).toBe(at);
    expect(usageWaitUntil([{ status: "rejected", resetsAt: at, rateLimitType: "five_hour", utilization: {} }])).toBe(at);
    expect(usageWaitUntil([])).toBeUndefined();
  });
});
