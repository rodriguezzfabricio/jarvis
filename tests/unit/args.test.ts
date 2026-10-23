import { describe, expect, it } from "vitest";
import { assertSafeTaskArgs, buildTaskArgs } from "../../packages/cli/src/harness/claude/args.ts";

const base = { prompt: "do it", settingsPath: "/s.json", mcpConfigPath: "/m.json", model: "claude-sonnet-5-5", maxTurns: 30 };

describe("task args: permanent requirements (decisions 59, 60, 61)", () => {
  it("passes --setting-sources project exactly once", () => {
    const a = buildTaskArgs(base);
    expect(a.filter((x) => x === "--setting-sources")).toHaveLength(1);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("rejects args without --setting-sources project, with user sources, or with it twice", () => {
    const a = buildTaskArgs(base);
    const i = a.indexOf("--setting-sources");
    const without = [...a.slice(0, i), ...a.slice(i + 2)];
    expect(() => assertSafeTaskArgs(without)).toThrow(/setting-sources/);
    const user = [...a];
    user[i + 1] = "user,project";
    expect(() => assertSafeTaskArgs(user)).toThrow(/setting-sources/);
    expect(() => assertSafeTaskArgs([...a, "--setting-sources", "project"])).toThrow(/exactly one/);
    expect(() => assertSafeTaskArgs([...without, "--setting-sources=user"])).toThrow(/setting-sources/);
  });

  it("always runs dontAsk with prompts off, so a dropped settings file fails closed", () => {
    const a = buildTaskArgs(base);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--permission-prompts") + 1]).toBe("none");
  });

  it("isolates MCP and session history", () => {
    const a = buildTaskArgs(base);
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--no-session-persistence");
  });

  it("refuses model aliases", () => {
    for (const m of ["haiku", "sonnet", "opus", "fable"]) expect(() => buildTaskArgs({ ...base, model: m })).toThrow(/alias/);
    expect(() => buildTaskArgs({ ...base, model: "claude-haiku-5-5" })).not.toThrow();
  });

  it("refuses permission bypasses and bare mode", () => {
    const a = buildTaskArgs(base);
    for (const f of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--bare", "--add-dir"]) {
      expect(() => assertSafeTaskArgs([...a, f])).toThrow();
    }
  });
});
