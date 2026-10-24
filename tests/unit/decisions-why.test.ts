import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";
import type { DecisionInput } from "../../packages/cli/src/decisions/format.ts";

const root = shortTmp("jtw-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const whyUrl = new URL("../../packages/cli/src/decisions/why.ts", import.meta.url).href;
const commanderUrl = pathToFileURL(fileURLToPath(new URL("../../packages/cli/node_modules/commander/index.js", import.meta.url))).href;
const script = `import { Command } from ${JSON.stringify(commanderUrl)};
import { register } from ${JSON.stringify(whyUrl)};
const program = new Command().name("jarvis");
register(program);
await program.parseAsync(process.argv.slice(1), { from: "user" });`;
let n = 0;
function repo() { const dir = join(root, `repo ${++n}`); mkdirSync(dir); writeFileSync(join(dir, "intake.md"), "# Intake\n"); return dir; }
function run(args: string[], cwd: string) { return spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", ...args], { cwd, encoding: "utf8" }); }
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
