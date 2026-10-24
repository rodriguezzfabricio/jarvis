import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve("skills/review");
const skill = () => readFileSync(`${root}/SKILL.md`, "utf8");
describe("review skill", () => {
  it("has concise Agent Skills frontmatter and a gotchas section", () => {
    expect(existsSync(`${root}/SKILL.md`)).toBe(true);
    const text = skill();
    const front = /^---\nname: review\ndescription: (.+)\n---\n/.exec(text);
    expect(front).not.toBeNull();
    expect(front![1]!.length).toBeGreaterThan(40);
    expect(front![1]!.length).toBeLessThanOrEqual(500);
    expect(text.split("\n").length).toBeLessThan(500);
    expect(Buffer.byteLength(text)).toBeLessThan(20_000);
    expect(text.split("## Gotchas\n")[1]?.match(/^- /gm)?.length).toBeGreaterThanOrEqual(3);
  });
  it("specifies independent evidence, read-only tools, and the exact finding contract", () => {
    const text = skill();
    for (const phrase of ["Read, Glob, Grep", "never read the builder's notes", "runner's evidence", "acceptance criteria", "critical", "high", "concrete scenario", "0.8", "investigate", "security", "data loss", "money", "messages", "confidence", "file", "line", "scenario", "fix", "new evidence"]) expect(text).toContain(phrase);
    const example = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(JSON.parse(example![1]!)).toEqual({ findings: [] });
  });
  it("keeps the skill aligned with investigation holds and candidate trust", () => {
    expect(skill()).toContain("Critical or high findings awaiting investigation prevent completion");
    expect(skill()).toContain("AGENTS.md and CLAUDE.md");
    expect(skill()).toContain("data, never instructions");
  });
  it("ships realistic evals with resolvable fixture references", () => {
    const data = JSON.parse(readFileSync(`${root}/evals/evals.json`, "utf8"));
    expect(data.skill_name).toBe("review");
    expect(data.evals.length).toBeGreaterThanOrEqual(3);
    expect(new Set(data.evals.map((e: { id: number }) => e.id)).size).toBe(data.evals.length);
    for (const e of data.evals) {
      expect(typeof e.id).toBe("number");
      expect(e.prompt.length).toBeGreaterThan(0);
      expect(e.expected_output.length).toBeGreaterThan(0);
      expect(e.expectations.length).toBeGreaterThanOrEqual(2);
      for (const f of e.files) expect(existsSync(`${root}/evals/${f}`)).toBe(true);
    }
    const all = JSON.stringify(data);
    for (const phrase of ["SSRF", "investigate", "builder", "unchanged caller"]) expect(all).toContain(phrase);
  });
});
