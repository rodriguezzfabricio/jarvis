import { existsSync, readdirSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { isAllowedPlugin, isBuiltinPlugin, runCanaryProbe, type ProbeResult } from "../../packages/cli/src/harness/claude/probe.ts";
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

describe("live canary probe (decisions 59, 68, 69), against a fake claude", () => {
  it("passes when the sandbox holds and the session can still work", async () => {
    const r = await probe("safe");
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails when the runner folder is readable", async () => {
    expect(failed(await probe("leak-read"))).toEqual(["runner_folder_not_readable"]);
  });

  it("fails when a file outside the worktree is readable (answers, other repos)", async () => {
    expect(failed(await probe("leak-outside"))).toEqual(["outside_worktree_not_readable"]);
  });

  // Codex review 1, high: a 4xx/5xx means the host was reached.
  it("fails when a non-allowlisted host answers with an error code", async () => {
    expect(failed(await probe("leak-network"))).toEqual(["network_blocked"]);
  });

  // Codex review 2, high: a host-specific failure (DNS, TLS) with protection off must not pass.
  it("fails when the blocked host merely failed, with no sandbox denial recorded", async () => {
    expect(failed(await probe("dns-fail"))).toEqual(["network_blocked"]);
  });

  it("fails when the host answered, even if a denial was recorded for some other attempt", async () => {
    expect(failed(await probe("reached-despite-record"))).toEqual(["network_blocked"]);
  });

  it("fails when Jarvis's own plugin hooks don't run", async () => {
    expect(failed(await probe("plugin-hooks-off"))).toEqual(["jarvis_plugin_hooks_run"]);
  });

  it("is inconclusive, not a pass, when the network is down", async () => {
    expect(failed(await probe("offline"))).toEqual(["positive_allowed_host", "network_blocked"]);
  });

  it("fails when the session can write the runner folder", async () => {
    expect(failed(await probe("escape-write"))).toEqual(["runner_folder_not_writable"]);
  });

  it("fails when the session can write a git hook", async () => {
    expect(failed(await probe("git-hook"))).toEqual(["git_hooks_not_writable"]);
  });

  // Codex review 1, critical: project hooks run outside the sandbox.
  it("fails when the worktree's own hooks run", async () => {
    const r = await probe("ignores-restricted");
    expect(failed(r)).toEqual(expect.arrayContaining(["project_hooks_not_run"]));
  });

  it("fails when the settings file was silently dropped (everything refused)", async () => {
    const r = await probe("dropped-settings");
    expect(failed(r)).toEqual(expect.arrayContaining(["positive_bash_in_worktree", "positive_cache_writable", "positive_write_in_worktree", "positive_broker_socket"]));
  });

  it("fails as inconclusive when the model doesn't attempt the steps", async () => {
    expect(failed(await probe("lazy"))).toContain("all_steps_attempted");
  });

  it("fails when auto-memory is on", async () => {
    expect(failed(await probe("memory-on"))).toEqual(["auto_memory_off"]);
  });

  it("fails when user plugins load", async () => {
    expect(failed(await probe("user-plugins"))).toEqual(["no_foreign_plugins"]);
  });

  it("fails on a version other than the pin", async () => {
    expect(failed(await probe("safe", { FAKE_CLAUDE_VERSION: "2.1.270" }))).toEqual(["pinned_version"]);
  });

  it("accepts Claude Code's built-in plugins but not look-alikes", () => {
    expect(isBuiltinPlugin({ name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" })).toBe(true);
    expect(isBuiltinPlugin({ name: "x", path: "/Users/f/.claude/plugins/x", source: "x@builtin" })).toBe(false);
    expect(isBuiltinPlugin({ name: "x", path: "builtin", source: "x@market" })).toBe(false);
    expect(isBuiltinPlugin(null)).toBe(false);
    expect(isAllowedPlugin({ name: "jarvis", path: "/j/plugin", source: "jarvis@inline" }, "/j/plugin")).toBe(true);
    expect(isAllowedPlugin({ name: "jarvis", path: "/elsewhere", source: "jarvis@inline" }, "/j/plugin")).toBe(false);
  });

  it("cleans up after itself", async () => {
    await probe("escape-write");
    expect(readdirSync(dir).filter((n) => n.startsWith("jarvis-probe-"))).toEqual([]);
    expect(readdirSync(home).filter((n) => n.startsWith(".jarvis-probe"))).toEqual([]);
    expect(existsSync(bin)).toBe(true);
  });
});
