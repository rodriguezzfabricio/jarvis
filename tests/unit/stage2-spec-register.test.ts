import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";
const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function setup() {
  const repo = mkdtempSync(join(tmpdir(), "jarvis-spec-register-")); dirs.push(repo); mkdirSync(join(repo, "docs")); writeFileSync(join(repo, "evidence.md"), "Evidence");
  const register = DecisionRegister.open(repo);
  const input = { date: "2026-10-25", decision: "One owner; no plan pricing", madeBy: "jarvis", source: "evidence.md", class: "Mechanical", reversibility: "easy", why: "Project rules", alternatives: [], dependsOn: [] } as const;
  register.add({ ...input, alternatives: [], dependsOn: [] });
  register.supersede(1, { ...input, alternatives: [], dependsOn: [], decision: "Personal tool, still no plan pricing" }, input.date, "Clarify");
  const { checkSpecRegister } = await import("../../packages/cli/src/decisions/spec-check.ts");
  return { repo, check: (text: string) => checkSpecRegister(repo, text) };
}
it("flags superseded and unknown decision citations with line numbers", async () => {
  const s = await setup(); const problems = s.check("# Spec\nRule from D1\nAlso D99");
  expect(problems).toEqual(expect.arrayContaining([expect.objectContaining({ line: 2, code: "superseded-decision" }), expect.objectContaining({ line: 3, code: "unknown-decision" })]));
});
it("validates decision header ranges against the complete current register", async () => {
  const s = await setup(); expect(s.check("Decisions: D1–D1\nUse D2")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "decision-range" })]));
  expect(s.check("Decisions: D1–D2\nUse D2")).toEqual([]);
});

it("extends repository checks on the latest spec while preserving historical versions", async () => {
  const s = await setup(); mkdirSync(join(s.repo, "docs/spec"));
  const template = readFileSync("templates/spec.md", "utf8").replace("date: YYYY-MM-DD", "date: 2026-10-25");
  writeFileSync(join(s.repo, "docs/spec/v1.md"), template.replace("<constraint>", "Rule from D1"));
  const { checkSpecRepository } = await import("../../packages/cli/src/decisions/spec-check.ts");
  expect(checkSpecRepository(s.repo).problems.some((p) => p.code === "superseded-decision")).toBe(true);
  const next = template.replace("spec: 1", "spec: 2").replace("supersedes: none", "supersedes: 1").replace("# Spec v1", "# Spec v2").replace("<constraint>", "Rule from D2");
  writeFileSync(join(s.repo, "docs/spec/v2.md"), next);
  expect(checkSpecRepository(s.repo)).toMatchObject({ ok: true, problems: [] });
});
