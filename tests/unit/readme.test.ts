import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The README's command tables match the real `jarvis --help` (stage 7: a friend installs from the README alone). */
const root = fileURLToPath(new URL("../../", import.meta.url));
const readme = readFileSync(`${root}README.md`, "utf8");

function helpCommands(): string[] {
  const r = spawnSync(process.execPath, [`${root}packages/cli/src/cli.ts`, "--help"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const section = r.stdout.split("Commands:\n")[1] ?? "";
  return [...section.matchAll(/^ {2}([a-z][a-z-]*)/gm)].map((m) => m[1] as string).filter((c) => c !== "help");
}
/** The commands named in the first column of the table that follows `heading`. */
function tableCommands(heading: string): string[] {
  const after = readme.split(heading)[1] ?? "";
  const table = after.split("\n\n").find((block) => block.trimStart().startsWith("|")) ?? "";
  const firstCells = table.split("\n").slice(2).map((row) => row.split("|")[1] ?? "");
  return firstCells.flatMap((cell) => [...cell.matchAll(/`jarvis ([a-z][a-z-]*)/g)].map((m) => m[1] as string));
}

describe("README commands", () => {
  const built = helpCommands();
  const available = tableCommands("From `jarvis --help` today:");
  const coming = tableCommands("Coming:");

  it("lists every command jarvis --help shows", () => {
    expect(built.length).toBeGreaterThan(5);
    for (const c of built) expect(available, c).toContain(c);
  });

  it("lists only real commands as available, and the rest as coming", () => {
    for (const c of available) expect(built, c).toContain(c);
    expect(coming.length).toBeGreaterThan(0);
    // `eval` exists with only its baseline subcommand; `jarvis eval <task>` is the part still coming.
    for (const c of coming.filter((x) => x !== "eval")) expect(built, `${c} is built now; move it out of "Coming"`).not.toContain(c);
  });
});
