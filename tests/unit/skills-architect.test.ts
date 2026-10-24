import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
const path = new URL("../../skills/architect/", import.meta.url);
const read = () => readFileSync(new URL("SKILL.md", path), "utf8");
function prose() { return read().replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^```[^\n]*\n[\s\S]*?^```/gm, ""); }
function section(name: string) { return prose().split(`## ${name}\n`)[1]?.split(/^## /m)[0] ?? ""; }
describe("architect skill", () => {
  it("uses portable name/description frontmatter and stays under size limits", () => {
    const text = read(); const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]!;
    expect(fm.split("\n").map((s) => s.split(":")[0]).sort()).toEqual(["description", "name"]); expect(fm).toContain("name: architect");
    expect(text.split("\n").length).toBeLessThan(500); expect(Buffer.byteLength(text)).toBeLessThan(20480);
  });
  it.each([
    ["Read the contract", ["PRODUCT.md", "DESIGN.md", "docs/spec/vN.md", "jarvis decide", "--why"]],
    ["Write the plan", [".jarvis/plan.json", "exitCondition", "acceptanceCriteria", "dependencies", "requiredChecks", "requiredReviews", "mayTouch", "every AC", "small tasks"]],
    ["Author protected checks", [".jarvis/checks/", "black box", "fixtures/", "expected/", "verify", "JARVIS-CHECK-COMPLETE", "JARVIS_COMPLETION_FILE", "no candidate imports", "never runnable unit tests", "no expectations in fixtures"]],
    ["Hand off", ["never writes product code", "review", "notes", "claims", "runner", "hashes", "new review"]],
  ])("keeps decision requirements in %s", (heading, phrases) => { for (const phrase of phrases) expect(section(heading), phrase).toContain(phrase); });
  it("has at least three gotchas and shows no compound session shell commands", () => {
    expect((section("Gotchas").match(/^- /gm) ?? []).length).toBeGreaterThanOrEqual(3);
    for (const m of read().matchAll(/^```(?:sh|bash|shell)\n([\s\S]*?)^```/gm)) expect(m[1]).not.toMatch(/&&|\|\||;|\$\(|\||<</);
  });
  it("ships at least three checkable evals covering planning, gaming and spec-free routing", () => {
    const data = JSON.parse(readFileSync(new URL("evals/evals.json", path), "utf8")) as { skill_name: string; evals: { id: number; prompt: string; expected_output: string; expectations: string[]; files: string[] }[] };
    expect(data.skill_name).toBe("architect"); expect(data.evals.length).toBeGreaterThanOrEqual(3); expect(new Set(data.evals.map((e) => e.id)).size).toBe(data.evals.length);
    for (const e of data.evals) { expect(e.prompt.length).toBeGreaterThan(0); expect(e.expected_output.length).toBeGreaterThan(0); expect(e.expectations.length).toBeGreaterThanOrEqual(2); for (const f of e.files) expect(existsSync(new URL(`evals/${f}`, path))).toBe(true); }
    expect(JSON.stringify(data)).toContain("black box"); expect(JSON.stringify(data)).toContain("bug"); expect(JSON.stringify(data)).toContain("AC1");
  });
});
