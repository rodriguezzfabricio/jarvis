import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/lanes/index.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

it("registers read-only lane selection and prints scoped checks from JSON", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command().exitOverride(); register(program);
  await program.parseAsync(["lanes", "select", "--input", "tests/fixtures/qa/selection.json"], { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(expect.arrayContaining([expect.objectContaining({ lane: "API" })]));
  expect(process.exitCode ?? 0).toBe(0);
});

it("reports design lint findings with nonzero exit and makes no evidence claim", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command().exitOverride(); register(program);
  await program.parseAsync(["lanes", "lint", "--design", "tests/fixtures/qa/DESIGN.md", "--source", "tests/fixtures/qa/generic.html"], { from: "user" });
  const output = JSON.parse(String(log.mock.calls[0]?.[0]));
  expect(output.verified).toBe(false);
  expect(output.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "generic-copy" })]));
  expect(process.exitCode).toBe(1);
});

it("ships QA skill evals for the real targets, unavailable tools and the negative control", () => {
  const skill = readFileSync("skills/qa/SKILL.md", "utf8");
  expect(skill).toMatch(/^---\nname: qa\ndescription:/);
  const evals = JSON.parse(readFileSync("skills/qa/evals/evals.json", "utf8"));
  expect(evals.skill_name).toBe("qa");
  expect(evals.evals.length).toBeGreaterThanOrEqual(4);
  for (const e of evals.evals) {
    expect(e.prompt.length).toBeGreaterThan(30);
    expect(e.expectations.length).toBeGreaterThanOrEqual(3);
  }
});
