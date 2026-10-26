import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkSpec } from "../../packages/cli/src/spec/parser.ts";
const skill = (name: string) => readFileSync(`plugin/skills/${name}/SKILL.md`, "utf8");
const section = (name: string, heading: string) => skill(name).split(`\n## ${heading}\n`)[1]?.split(/\n## /)[0] ?? "";
it("describes only actual delivery-backed timeouts, with no build promise", () => {
  for (const name of ["intake", "spec"]) {
    expect(skill(name)).toContain("deadline: null");
    expect(skill(name)).toContain("wait for an answer in the session");
    expect(skill(name)).not.toMatch(/still open after the second (?:call|wait).*continue as if|build (?:goes ahead|starts)/i);
  }
});
it("requires honest costs and core request preservation in defaults", () => {
  const text = section("intake", "Write the questions");
  expect(text).toContain("Name the known costs and limitations from research");
  expect(text).toContain("Never drop or replace the core of the user's request");
  expect(text).toContain("If no viable way was found, say so plainly and ask");
  expect(skill("intake")).toContain('"tradeOff"');
});
it("surfaces choices that rewrite or destroy past data for veto", () => {
  for (const name of ["intake", "spec"]) expect(skill(name)).toContain("rewrites or destroys the user's past data");
  expect(skill("intake")).toContain("a question or a listed assumption the user can veto in the round");
});
it("requires full project-document reads and research evidence before assumptions or questions", () => {
  const text = section("intake", "Inputs");
  for (const path of ["README", "IMPLEMENTATION", "ARCHITECTURE", "AGENTS.md", "CLAUDE.md", "existing specs"]) expect(text).toContain(path);
  expect(text).toContain("Read these documents in full");
  expect(text).toContain("A keyword grep is not a full read");
  expect(text).toContain("Research must finish before the round");
  expect(text).toContain('an explicit "not checked" line per unsupported claim');
});
it("quarantines missing-role research without generic agents or out-of-project reads", () => {
  const text = skill("research");
  expect(text).toContain("Never substitute Explore or another shell-capable agent");
  expect(text).toContain("Never read outside the project folder");
  expect(text).toContain("Missing research is not evidence that no solution exists");
});
it("keeps waits in the background and accepts session answers while pending", () => {
  for (const name of ["intake", "spec"]) {
    expect(skill(name)).toContain("run_in_background: true");
    expect(skill(name).toLowerCase()).toContain("while a wait is pending");
    expect(skill(name)).toContain("Never require Esc");
  }
});
it("requires verified answer references for user-attributed register writes", () => {
  expect(skill("intake")).toContain("--answer <answerSeq>:<questionId>");
  expect(skill("intake")).toContain("exact recorded answer");
  expect(skill("spec")).toContain("Do not split a confirmation into invented user decisions");
});
it("ships every referenced bundled template, matching the canonical format", () => {
  let count = 0;
  for (const entry of readdirSync("plugin/skills", { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const text = skill(entry.name);
    for (const match of text.matchAll(/`(templates\/[A-Za-z0-9._/-]+)`/g)) {
      const relative = match[1]!; const path = join("plugin/skills", entry.name, relative);
      expect(existsSync(path), path).toBe(true);
      const withoutComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "");
      expect(withoutComments(readFileSync(path, "utf8")), path).toBe(withoutComments(readFileSync(relative, "utf8"))); count++;
    }
  }
  expect(count).toBeGreaterThanOrEqual(3);
  const template = readFileSync("plugin/skills/spec/templates/spec.md", "utf8").replace("date: YYYY-MM-DD", "date: 2026-10-25");
  expect(checkSpec(template, "docs/spec/v1.md").ok).toBe(true);
});
it("requires portable shell patterns in the command and research skill", () => {
  for (const text of [skill("research"), readFileSync("plugin/commands/jarvis.md", "utf8")]) {
    expect(text).toContain("Quote globs"); expect(text).toContain("ugrep");
    expect(text).toContain("Do not rely on `jarvis <cmd> --help` exiting 0");
    expect(text).not.toMatch(/--include=\*\./);
  }
});
it("checks evidence-backed state and labels, and rereads the final spec against the register", () => {
  const text = skill("spec");
  for (const rule of ["the user confirming they did it and an outside service confirming it are distinct states", "inferred labels need evidence or lower confidence", "re-read the whole spec after the last fixes", "until a pass finds no blocking gaps", "no superseded citations", "no answered question left open", "decision header ranges are current", "do not reintroduce anything an active decision excludes"]) expect(text).toContain(rule);
});
