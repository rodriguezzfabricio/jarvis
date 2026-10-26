import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { register } from "../../packages/cli/src/decisions/why.ts";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";
import type { DecisionInput } from "../../packages/cli/src/decisions/format.ts";

const root = shortTmp("jtw-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
let n = 0;
function repo() { const dir = join(root, `repo ${++n}`); mkdirSync(dir); writeFileSync(join(dir, "intake.md"), "# Intake\n"); return dir; }
/**
 * `jarvis ...args` run from `cwd`: the command's own registration on a fresh Commander program, in this process (it was a
 * fresh Node process per call, about 0.27 s of CPU each). Commander's exitOverride turns the exit the command asks for into a
 * thrown error that carries its exit code; stdout and stderr are what it would write. The command reads the working folder
 * when it registers (the default of --repo), so the folder is changed first.
 */
function run(args: string[], cwd: string) {
  let stdout = "", stderr = "", status = 0;
  const before = process.cwd();
  process.chdir(cwd);
  try {
    const program = new Command();
    program.name("jarvis"); program.exitOverride(); program.configureOutput({ writeOut: (text) => { stdout += text; }, writeErr: (text) => { stderr += text; } });
    register(program);
    program.parse(args, { from: "user" });
  } catch (error) {
    const exit = (error as { exitCode?: unknown }).exitCode;
    if (typeof exit === "number") status = exit; else { status = 1; stderr += String(error); }
  } finally { process.chdir(before); }
  return { status, stdout, stderr };
}
const input: DecisionInput = {
  date: "2026-10-20", decision: "No follow-ups", madeBy: "fabricio", source: "intake.md#one",
  class: "Taste", reversibility: "hard", why: "Avoid spam", alternatives: ["Reminders"], dependsOn: ["outreach"],
};
function seeded() {
  const dir = repo();
  const store = DecisionRegister.open(dir);
  store.add(input);
  store.supersede(1, { ...input, date: "2026-10-24", decision: "One reminder" }, "2026-10-24", "New workflow");
  store.add({ ...input, decision: "Use SQLite" });
  return dir;
}

describe("jarvis why registration", () => {
  it("registers why with a required query, --repo and --history", () => {
    const result = run(["why", "--help"], repo());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("why [options] <query>");
    expect(result.stdout).toContain("--repo <dir>");
    expect(result.stdout).toContain("--history");
    const missing = run(["why"], repo());
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing required argument");
  });

  it("prints active matches with their ID, date, source and reason from --repo", () => {
    const dir = seeded();
    const before = readFileSync(join(dir, "docs/decisions.md"), "utf8");
    const result = run(["why", "reminder", "--repo", dir], repo());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("D2");
    expect(result.stdout).toContain("2026-10-24");
    expect(result.stdout).toContain("One reminder");
    expect(result.stdout).toContain(input.source);
    expect(result.stdout).toContain(input.why);
    expect(result.stdout).not.toContain("D1");
    expect(readFileSync(join(dir, "docs/decisions.md"), "utf8")).toBe(before);
  });

  it("defaults to the current directory and supports an exact ID query", () => {
    const dir = seeded();
    const result = run(["why", "D3"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Use SQLite");
    expect(result.stdout).not.toContain("One reminder");
  });

  it("prints linked superseded history only with --history, including its date and reason", () => {
    const dir = seeded();
    const hidden = run(["why", "D1"], dir);
    expect(hidden.status).toBe(0);
    expect(hidden.stdout).toContain("No matching active decisions");
    const result = run(["why", "D1", "--history"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No follow-ups");
    expect(result.stdout).toContain("One reminder");
    expect(result.stdout).toContain("superseded by D2 on 2026-10-24: New workflow");
    expect(result.stdout).not.toContain("Use SQLite");
  });

  it("handles a missing register without creating it", () => {
    const dir = repo();
    const result = run(["why", "nothing"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No matching active decisions");
  });

  it("reports malformed rows with their line number and exits nonzero", () => {
    const dir = repo();
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/decisions.md"), "broken\n");
    const result = run(["why", "anything"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/line 1:/i);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("at parseRegister");
  });
});
