import { describe, expect, it } from "vitest";
import { assertSafeTaskArgs, buildTaskArgs } from "../../packages/cli/src/harness/claude/args.ts";

const base = { prompt: "do it", settingsPath: "/s.json", mcpConfigPath: "/m.json", model: "claude-sonnet-5-5", maxTurns: 30 };
const without = (a: string[], flag: string, n = 1) => {
  const i = a.indexOf(flag);
  return [...a.slice(0, i), ...a.slice(i + 1 + n)];
};

describe("task args: permanent requirements (decisions 59, 60, 61, 68)", () => {
  it("passes --restricted exactly once with an explicit build tool list", () => {
    const a = buildTaskArgs(base);
    expect(a.filter((x) => x === "--restricted")).toHaveLength(1);
    expect(a[a.indexOf("--tools") + 1]).toBe("Bash,Read,Edit,Write,Glob,Grep");
  });

  it("refuses args without --restricted, or with it twice", () => {
    const a = buildTaskArgs(base);
    expect(() => assertSafeTaskArgs(without(a, "--restricted", 0))).toThrow(/restricted/);
    expect(() => assertSafeTaskArgs([...a, "--restricted"])).toThrow(/restricted/);
  });

  it("refuses --setting-sources, which loads project hooks that run outside the sandbox", () => {
    const a = buildTaskArgs(base);
    expect(() => assertSafeTaskArgs([...a, "--setting-sources", "project"])).toThrow(/setting-sources/);
    expect(() => assertSafeTaskArgs([...a, "--setting-sources=user"])).toThrow(/setting-sources/);
  });

  it("refuses tools beyond the build set, and a missing or duplicated list", () => {
    const a = buildTaskArgs(base);
    const i = a.indexOf("--tools");
    for (const bad of ["Bash,WebFetch", "default", "Bash,Task", ""]) {
      const b = [...a];
      b[i + 1] = bad;
      expect(() => assertSafeTaskArgs(b)).toThrow(/tools/);
    }
    expect(() => assertSafeTaskArgs(without(a, "--tools"))).toThrow(/tools/);
    expect(() => assertSafeTaskArgs([...a, "--tools", "Bash"])).toThrow(/tools/);
    expect(() => buildTaskArgs({ ...base, tools: ["Read", "Grep"] })).not.toThrow();
  });

  it("always runs dontAsk with prompts off, so a dropped settings file fails closed", () => {
    const a = buildTaskArgs(base);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(() => assertSafeTaskArgs(without(a, "--permission-mode"))).toThrow(/permission-mode/);
  });

  it("isolates MCP and session history", () => {
    const a = buildTaskArgs(base);
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--no-session-persistence");
  });

  it("refuses model aliases", () => {
    for (const m of ["haiku", "sonnet", "opus", "fable"]) expect(() => buildTaskArgs({ ...base, model: m })).toThrow(/alias/);
  });

  it("refuses permission bypasses and other escape hatches", () => {
    const a = buildTaskArgs(base);
    for (const f of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--bare", "--add-dir", "--allowedTools", "--agents", "--chrome"]) {
      expect(() => assertSafeTaskArgs([...a, f])).toThrow();
    }
  });
});
