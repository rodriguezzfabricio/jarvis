import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/spec/command.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const source = readFileSync(new URL("../fixtures/spec/v1.md", import.meta.url), "utf8");
const root = mkdtempSync(join(tmpdir(), "jarvis-spec-cli-"));
const priorExitCode = process.exitCode;
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { process.exitCode = priorExitCode; vi.restoreAllMocks(); });
let n = 0;
function fresh(text?: string): string {
  const repo = join(root, `repo ${++n}`);
  mkdirSync(join(repo, "docs", "spec"), { recursive: true });
  if (text !== undefined) writeFileSync(join(repo, "docs", "spec", "v1.md"), text);
  return repo;
}
function run(args: string[]): { stdout: string; stderr: string; exitCode: typeof process.exitCode } {
  let stdout = "";
  let stderr = "";
  const program = new Command().name("jarvis").exitOverride().configureOutput({ writeOut: (s) => { stdout += s; }, writeErr: (s) => { stderr += s; } });
  register(program);
  program.parse(args, { from: "user" });
  return { stdout, stderr, exitCode: process.exitCode };
}

describe("jarvis spec check", () => {
  it("registers the command and exits zero for a valid explicitly selected repo", () => {
    const repo = fresh(source);
    process.exitCode = 1;
    const result = run(["spec", "check", "--repo", repo]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/valid|ok/i);
    expect(result.stderr).toBe("");
  });

  it("defaults to the current repo and accepts an unconfirmed spec", () => {
    vi.spyOn(process, "cwd").mockReturnValue(fresh(source));
    expect(run(["spec", "check"]).exitCode).toBe(0);
  });

  it("lists all problems as file:line messages with exit one", () => {
    const repo = fresh(source.replace("status: unconfirmed", "status: invalid").replace("**AC1 (S1):**", "**AC1 (S99):**"));
    const result = run(["spec", "check", "--repo", repo]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${join(repo, "docs", "spec", "v1.md")}:4:`);
    expect(result.stderr).toContain("unknown story S99");
    expect(result.stderr).toContain("S1 has no acceptance criterion");
    expect(result.stdout).toBe("");
  });

  it("fails with a line-numbered message when no specs exist", () => {
    const result = run(["spec", "check", "--repo", fresh()]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("spec:1:");
  });

  it("checks the full history and reports version gaps", () => {
    const repo = fresh(source);
    writeFileSync(join(repo, "docs", "spec", "v3.md"), source.replace("spec: 1", "spec: 3").replace("Spec v1", "Spec v3").replace("supersedes: none", "supersedes: 2"));
    expect(run(["spec", "check", "--repo", repo]).stderr).toContain("Missing v2.md");
  });

  it.each([[true, 0], [false, 1]] as const)("returns a real process exit code for valid=%s", (valid, expected) => {
    const repo = fresh(valid ? source : source.replace("WHEN I save", "IF I save"));
    const script = `import { createRequire } from 'node:module';
import { register } from ${JSON.stringify(new URL("../../packages/cli/src/spec/command.ts", import.meta.url).href)};
const { Command } = createRequire(${JSON.stringify(new URL("../../packages/cli/package.json", import.meta.url).href)})('commander');
register(new Command()).parse(process.argv.slice(1), { from: 'user' });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", "spec", "check", "--repo", repo], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(expected);
    expect(result.error).toBeUndefined();
  });
});
