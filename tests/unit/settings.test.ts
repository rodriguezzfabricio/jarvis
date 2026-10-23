import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { absRule, assertSafeTaskSettings, buildTaskSettings, cacheEnv, writeTaskSettings } from "../../packages/cli/src/harness/claude/settings.ts";
import { shortTmp } from "../helpers.ts";

const ctx = {
  worktree: "/Users/f/.jarvis-work/worktrees/p/t1",
  jarvisHome: "/Users/f/.jarvis",
  cacheDir: "/Users/f/.jarvis-work/cache",
  brokerSocket: "/Users/f/.jarvis/run/broker.sock",
  allowedDomains: ["registry.npmjs.org"],
};
const clone = () => structuredClone(buildTaskSettings(ctx)) as Record<string, any>;

describe("task settings: permanent requirements (decisions 59, 60, 68, 69)", () => {
  it("sets sandbox.failIfUnavailable and refuses settings without it", () => {
    expect(buildTaskSettings(ctx).sandbox.failIfUnavailable).toBe(true);
    const s = clone();
    s.sandbox.failIfUnavailable = false;
    expect(() => assertSafeTaskSettings(s, ctx)).toThrow(/failIfUnavailable/);
    delete s.sandbox.failIfUnavailable;
    expect(() => assertSafeTaskSettings(s, ctx)).toThrow(/failIfUnavailable/);
  });

  it("turns auto-memory off and refuses settings that leave it on", () => {
    expect(buildTaskSettings(ctx).autoMemoryEnabled).toBe(false);
    const s = clone();
    s.autoMemoryEnabled = true;
    expect(() => assertSafeTaskSettings(s, ctx)).toThrow(/autoMemoryEnabled/);
  });

  it("blocks reads outside the working directories, reopening only the toolchain cache", () => {
    const s = buildTaskSettings(ctx);
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.sandbox.filesystem.allowRead).toEqual([ctx.cacheDir]);
    expect(s.sandbox.filesystem.allowWrite).toEqual([ctx.cacheDir]);
  });

  it("protects the runner folder, git hooks, git config and .claude from writes", () => {
    const w = buildTaskSettings(ctx).sandbox.filesystem.denyWrite;
    expect(w).toEqual([ctx.jarvisHome, `${ctx.worktree}/.git/hooks`, `${ctx.worktree}/.git/config`, `${ctx.worktree}/.claude`]);
  });

  it("denies the runner folder to the shell and the file tools, and has no web tools", () => {
    const s = buildTaskSettings(ctx);
    expect(s.sandbox.filesystem.denyRead).toEqual([ctx.jarvisHome]);
    expect(s.permissions.deny).toEqual(["Read(//Users/f/.jarvis/**)", "Edit(//Users/f/.jarvis/**)", "WebSearch", "WebFetch"]);
    expect(s.permissions.allow).toEqual(["Edit(//Users/f/.jarvis-work/worktrees/p/t1/**)"]);
  });

  // Codex review 1, medium: validation must check the policy, not just the shape.
  it("refuses settings whose protected paths or rules were swapped or widened", () => {
    const mutations: ((s: Record<string, any>) => void)[] = [
      (s) => (s.sandbox.filesystem.denyRead = ["/irrelevant"]),
      (s) => (s.sandbox.filesystem.denyWrite = ["/irrelevant"]),
      (s) => (s.sandbox.filesystem.allowRead = ["/Users"]),
      (s) => (s.sandbox.filesystem.allowWrite = ["/Users/f"]),
      (s) => (s.permissions.deny = ["Read(//irrelevant/**)"]),
      (s) => s.permissions.allow.push("Read", "Bash", "Edit(//**)"),
      (s) => s.sandbox.network.allowedDomains.push("evil.example"),
      (s) => (s.sandbox.network.allowUnixSockets = ["/var/run/docker.sock"]),
      (s) => (s.permissions.blockReadsOutsideWorkingDirectories = false),
      (s) => (s.hooks = {}),
    ];
    for (const m of mutations) {
      const s = clone();
      m(s);
      expect(() => assertSafeTaskSettings(s, ctx)).toThrow(/unsafe/);
    }
    expect(() => assertSafeTaskSettings(clone(), ctx)).not.toThrow();
  });

  it("refuses unsafe contexts", () => {
    expect(() => buildTaskSettings({ ...ctx, worktree: "/Users/f/.jarvis/worktrees/p/t1" })).toThrow(/outside/);
    expect(() => buildTaskSettings({ ...ctx, cacheDir: "/Users/f/.jarvis/cache" })).toThrow(/outside/);
    expect(() => buildTaskSettings({ ...ctx, brokerSocket: "/tmp/x/broker.sock" })).toThrow(/real path/);
    expect(() => buildTaskSettings({ ...ctx, brokerSocket: "/Users/f/elsewhere.sock" })).toThrow(/runner-owned/);
    expect(() => buildTaskSettings({ ...ctx, allowedDomains: ["*"] })).toThrow(/domain/);
  });

  it("allows no socket when no broker runs", () => {
    const { brokerSocket: _, ...noBroker } = ctx;
    expect(buildTaskSettings(noBroker).sandbox.network.allowUnixSockets).toEqual([]);
  });

  it("writes absolute permission paths with a leading //", () => {
    expect(absRule("/a/b")).toBe("//a/b");
    expect(() => absRule("a/b")).toThrow();
  });

  it("only writes policy-exact settings, owner-only", () => {
    const dir = shortTmp();
    const p = join(dir, "s.json");
    const bad = clone();
    bad.sandbox.filesystem.denyRead = ["/irrelevant"];
    expect(() => writeTaskSettings(p, ctx, bad)).toThrow(/unsafe/);
    writeTaskSettings(p, ctx);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(buildTaskSettings(ctx));
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("points toolchain caches at the cache folder", () => {
    const e = cacheEnv(ctx.cacheDir);
    for (const k of ["GOMODCACHE", "GOCACHE", "npm_config_cache", "npm_config_store_dir"]) expect(e[k]?.startsWith(ctx.cacheDir)).toBe(true);
  });
});
