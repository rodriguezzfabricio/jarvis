import { chmodSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROUTING, loadRouting, routeTask } from "../../packages/cli/src/runner/routing.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readFileSync: vi.fn(fs.readFileSync) };
});
const roots: string[] = [];
function project(override?: unknown): string {
  const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-routing-")); roots.push(root);
  if (override !== undefined) writeFileSync(join(root, ".jarvis-routing.json"), JSON.stringify(override));
  return root;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("task routing", () => {
  it("routes the complete architecture table with full model IDs and effort", () => {
    for (const role of ["intake", "spec", "architect", "review"] as const) {
      expect(routeTask(role, 2)).toMatchObject({ model: "claude-opus-5-5", effort: "high", modelTier: "strong" });
      for (const tier of [0, 1] as const) expect(routeTask(role, tier)).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    }
    for (const role of ["build", "debug"] as const) {
      for (const tier of [0, 1, 2] as const) expect(routeTask(role, tier)).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    }
    expect(routeTask("explore", 2)).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(routeTask("review", 2).crossModel).toBe("codex");
    expect(routeTask("build", 2).crossModel).toBeUndefined();
  });

  it.each(["gate_fail", "review_fail"] as const)("escalates on %s, and keeps exploration cheap", (failure) => {
    for (const role of ["build", "debug", "review", "intake", "spec", "architect"] as const) {
      expect(routeTask(role, 0, failure).modelTier).toBe("strong");
    }
    expect(routeTask("explore", 0, failure).modelTier).toBe("cheap");
  });

  it("merges a partial project JSON override without changing defaults", () => {
    const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-routing-")); roots.push(root);
    expect(loadRouting(root)).toEqual(DEFAULT_ROUTING);
    writeFileSync(join(root, ".jarvis-routing.json"), JSON.stringify({ tiers: { fast: { effort: "high" } }, roles: { build: { start: "strong" } } }));
    const table = loadRouting(root);
    expect(routeTask("build", 1, undefined, table).modelTier).toBe("strong");
    expect(routeTask("debug", 1, undefined, table)).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    expect(routeTask("debug", 1).effort).toBe("medium");
  });

  it.each([
    { tiers: { fast: { model: "sonnet" } } },
    { tiers: { fast: { effort: "ultra" } } },
    { roles: { build: { start: "unknown" } } },
    { roles: { review: { cross_model: "shell" } } },
    { roles: { review: { tier2: "cheap" } } },
    { roles: { surprise: { start: "cheap" } } },
    { tiers: { fast: { model: "claude-sonnet-5-5", command: "sh" } } },
    { escalate_on: ["timeout"] },
  ])("rejects invalid and unknown override fields: %j", (override) => {
    expect(() => loadRouting(project(override))).toThrow(/routing/i);
  });

  it("refuses malformed, oversized and unreadable routing instead of using defaults", () => {
    const root = project(); const path = join(root, ".jarvis-routing.json");
    writeFileSync(path, "{"); expect(() => loadRouting(root)).toThrow(/routing/i);
    writeFileSync(path, " ".repeat(65_537)); expect(() => loadRouting(root)).toThrow(/routing/i);
    chmodSync(path, 0o000); expect(() => loadRouting(root)).toThrow();
  });

  it.each(["FIFO", "symlink"])("refuses a %s without blocking or reading it", (kind) => {
    const root = project(); const path = join(root, ".jarvis-routing.json");
    if (kind === "FIFO") execFileSync("/usr/bin/mkfifo", [path]);
    else symlinkSync("/dev/urandom", path);
    const source = `import { loadRouting } from ${JSON.stringify(pathToFileURL(resolve("packages/cli/src/runner/routing.ts")).href)}; try { loadRouting(${JSON.stringify(root)}); process.stdout.write("accepted"); } catch { process.stdout.write("refused"); }`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { timeout: 1000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("refused");
  });

  it("checks an oversized file before opening or reading it", () => {
    const root = project(); writeFileSync(join(root, ".jarvis-routing.json"), " ".repeat(65_537));
    vi.mocked(openSync).mockClear(); vi.mocked(readFileSync).mockClear();
    expect(() => loadRouting(root)).toThrow(/routing/i);
    expect(openSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
