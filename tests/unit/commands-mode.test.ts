import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readMode, register as registerMode } from "../../packages/cli/src/commands/mode.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";
import { buildRunHeader } from "../../packages/cli/src/runner/prompt.ts";

const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "jarvis-mode-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const program = () => new Command().exitOverride().configureOutput({ writeErr: () => undefined });
const run = async (jarvisHome: string, args: string[], seams: { cwd?: string; env?: Record<string, string> } = {}) => {
  const output: string[] = []; const cli = program();
  registerMode(cli, { jarvisHome, env: seams.env ?? {}, ...(seams.cwd ? { cwd: seams.cwd } : {}), output: (s) => output.push(s) });
  await cli.parseAsync(["mode", ...args], { from: "user" });
  return output.join("\n");
};
const task = {
  taskId: "T1", goal: "Fix the parser", exitCondition: "AC1 passes", acceptanceCriteria: ["AC1"], decisions: [],
  specPath: "docs/spec/v2.md", mayNotTouch: [], maxTurns: 8, runId: "run-1", specVersion: 2,
};

describe("jarvis mode explain|quiet (decision 32)", () => {
  it("persists the mode in the runner-owned project folder, owner-only, with no temp files left", async () => {
    const jarvisHome = fresh(); const dir = join(jarvisHome, "projects", "demo");
    expect(await run(jarvisHome, ["explain", "--project", "demo"])).toMatch(/explain/);
    expect(readMode(dir)).toBe("explain");
    expect(statSync(join(dir, "mode.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["mode.json"]);
    await run(jarvisHome, ["quiet"], { env: { JARVIS_PROJECT: "demo" } });
    expect(readMode(dir)).toBe("quiet");
    expect(JSON.parse(readFileSync(join(dir, "mode.json"), "utf8"))).toEqual({ mode: "quiet" });
    expect(readdirSync(dir)).toEqual(["mode.json"]);
  });

  it("prints the current mode without an argument; quiet until set", async () => {
    const jarvisHome = fresh();
    expect(await run(jarvisHome, ["--project", "demo"])).toMatch(/quiet/);
    expect(existsSync(join(jarvisHome, "projects"))).toBe(false);
    await run(jarvisHome, ["explain", "--project", "demo"]);
    expect(await run(jarvisHome, ["--project", "demo"])).toMatch(/explain/);
  });

  it("refuses an unknown mode or project id and writes nothing", async () => {
    const jarvisHome = fresh();
    await expect(run(jarvisHome, ["loud", "--project", "demo"])).rejects.toThrow(/explain.*quiet/);
    await expect(run(jarvisHome, ["explain", "--project", "../escape"])).rejects.toThrow(/project id/i);
    expect(readdirSync(jarvisHome)).toEqual([]);
  });

  it("derives the project from the repo (decision 90)", async () => {
    const repo = fresh(); mkdirSync(join(repo, ".git")); const jarvisHome = fresh();
    await run(jarvisHome, ["explain"], { cwd: repo });
    expect(readMode(join(jarvisHome, "projects", projectId(repo)))).toBe("explain");
  });

  it("reads quiet from a missing, corrupt, unknown or symlinked mode file", () => {
    const home = fresh(); const dir = join(home, "p"); mkdirSync(dir);
    expect(readMode(join(home, "missing"))).toBe("quiet");
    writeFileSync(join(dir, "mode.json"), "{not json"); expect(readMode(dir)).toBe("quiet");
    writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: "loud" })); expect(readMode(dir)).toBe("quiet");
    rmSync(join(dir, "mode.json"));
    const planted = join(home, "planted.json"); writeFileSync(planted, JSON.stringify({ mode: "explain" }));
    symlinkSync(planted, join(dir, "mode.json"));
    expect(readMode(dir)).toBe("quiet");
  });

  it("adds the teach-me instruction to the run header only in explain mode", () => {
    expect(buildRunHeader({ ...task, mode: "explain" })).toMatch(/Teach-me mode/);
    expect(buildRunHeader({ ...task, mode: "quiet" })).not.toMatch(/Teach-me/);
    expect(buildRunHeader(task)).not.toMatch(/Teach-me/);
  });
});
