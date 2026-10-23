import { existsSync, readdirSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { isBuiltinPlugin, runCanaryProbe, type ProbeResult } from "../../packages/cli/src/doctor/canary.ts";
import { fakeClaudeBin, shortTmp } from "../helpers.ts";

const dir = shortTmp("jtc-");
const home = shortTmp("jth-");
const bin = fakeClaudeBin(dir);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function probe(mode: string, extra: Record<string, string> = {}): Promise<ProbeResult> {
  return runCanaryProbe({ claudeBin: bin, tmpRoot: dir, home, parentEnv: { HOME: home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: mode, ...extra } });
}
const failed = (r: ProbeResult) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("doctor live canary probe (decision 59), against a fake claude", () => {
  it("passes when the sandbox holds and the session can still work", async () => {
    const r = await probe("safe");
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails when the planted secret is readable", async () => {
    const r = await probe("leak-read");
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("secret_not_read");
  });

  it("fails when a non-allowlisted host is reachable", async () => {
    const r = await probe("leak-network");
    expect(failed(r)).toEqual(["network_blocked"]);
  });

  it("fails when the session can write the runner-owned folder", async () => {
    const r = await probe("escape-write");
    expect(failed(r)).toContain("jarvis_home_not_writable");
  });

  it("fails when the settings file was silently dropped (everything refused)", async () => {
    const r = await probe("dropped-settings");
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(expect.arrayContaining(["positive_bash_in_worktree", "positive_write_in_worktree", "positive_broker_socket"]));
  });

  it("fails as inconclusive when the model doesn't attempt the steps", async () => {
    const r = await probe("lazy");
    expect(failed(r)).toContain("all_steps_attempted");
  });

  it("fails when auto-memory is on", async () => {
    expect(failed(await probe("memory-on"))).toEqual(["auto_memory_off"]);
  });

  it("fails when user plugins load (setting sources not restricted)", async () => {
    expect(failed(await probe("user-plugins"))).toEqual(["setting_sources_project"]);
  });

  it("accepts Claude Code's built-in plugins but not look-alikes", () => {
    expect(isBuiltinPlugin({ name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" })).toBe(true);
    expect(isBuiltinPlugin({ name: "x", path: "/Users/f/.claude/plugins/x", source: "x@builtin" })).toBe(false);
    expect(isBuiltinPlugin({ name: "x", path: "builtin", source: "x@market" })).toBe(false);
    expect(isBuiltinPlugin(null)).toBe(false);
  });

  it("fails on a version other than the pin", async () => {
    expect(failed(await probe("safe", { FAKE_CLAUDE_VERSION: "2.1.270" }))).toEqual(["pinned_version"]);
  });

  it("cleans up after itself", async () => {
    await probe("escape-write");
    expect(readdirSync(dir).filter((n) => n.startsWith("jarvis-probe-"))).toEqual([]);
    expect(readdirSync(home).filter((n) => n.startsWith(".jarvis-probe-"))).toEqual([]);
    expect(existsSync(bin)).toBe(true);
  });
});
