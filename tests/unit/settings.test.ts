import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { absRule, assertSafeTaskSettings, buildTaskSettings, writeTaskSettings } from "../../packages/cli/src/harness/claude/settings.ts";
import { shortTmp } from "../helpers.ts";

const input = {
  worktree: "/Users/f/.jarvis/worktrees/p/t1",
  jarvisHome: "/Users/f/.jarvis",
  brokerSocket: "/Users/f/.jarvis/run/broker.sock",
  allowedDomains: ["registry.npmjs.org"],
};

describe("task settings: permanent requirements (decisions 59, 60)", () => {
  it("sets sandbox.failIfUnavailable to true", () => {
    expect(buildTaskSettings(input).sandbox.failIfUnavailable).toBe(true);
  });

  it("rejects settings where failIfUnavailable is missing or false", () => {
    const s = structuredClone(buildTaskSettings(input)) as Record<string, any>;
    s.sandbox.failIfUnavailable = false;
    expect(() => assertSafeTaskSettings(s)).toThrow(/failIfUnavailable/);
    delete s.sandbox.failIfUnavailable;
    expect(() => assertSafeTaskSettings(s)).toThrow(/failIfUnavailable/);
  });

  it("turns auto-memory off, and rejects settings that leave it on", () => {
    expect(buildTaskSettings(input).autoMemoryEnabled).toBe(false);
    const s = structuredClone(buildTaskSettings(input)) as Record<string, any>;
    delete s.autoMemoryEnabled;
    expect(() => assertSafeTaskSettings(s)).toThrow(/autoMemoryEnabled/);
    s.autoMemoryEnabled = true;
    expect(() => assertSafeTaskSettings(s)).toThrow(/autoMemoryEnabled/);
  });

  it("never allows unsandboxed commands", () => {
    const s = structuredClone(buildTaskSettings(input)) as Record<string, any>;
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    s.sandbox.allowUnsandboxedCommands = true;
    expect(() => assertSafeTaskSettings(s)).toThrow();
  });

  it("rejects unknown keys, since an invalid file is silently dropped by Claude Code", () => {
    const s = { ...buildTaskSettings(input), hooks: {} };
    expect(() => assertSafeTaskSettings(s)).toThrow();
  });

  it("denies the runner-owned folder to the shell and to the file tools", () => {
    const s = buildTaskSettings(input);
    expect(s.sandbox.filesystem.denyRead).toContain("/Users/f/.jarvis");
    expect(s.sandbox.filesystem.denyWrite).toContain("/Users/f/.jarvis");
    expect(s.permissions.deny).toContain("Read(//Users/f/.jarvis/**)");
    expect(s.permissions.deny).toContain("Edit(//Users/f/.jarvis/**)");
  });

  it("allows exactly one Unix socket, and only a real path", () => {
    expect(buildTaskSettings(input).sandbox.network.allowUnixSockets).toEqual(["/Users/f/.jarvis/run/broker.sock"]);
    expect(() => buildTaskSettings({ ...input, brokerSocket: "/tmp/x/broker.sock" })).toThrow(/real path/);
  });

  it("writes absolute permission paths with a leading //", () => {
    expect(absRule("/a/b")).toBe("//a/b");
    expect(() => absRule("a/b")).toThrow();
  });

  it("only ever writes validated settings, owner-only", () => {
    const dir = shortTmp();
    const p = join(dir, "s.json");
    expect(() => writeTaskSettings(p, { sandbox: { enabled: true } })).toThrow(/unsafe/);
    writeTaskSettings(p, buildTaskSettings(input));
    expect(JSON.parse(readFileSync(p, "utf8")).sandbox.failIfUnavailable).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
