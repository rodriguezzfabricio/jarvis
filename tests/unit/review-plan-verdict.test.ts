import { describe, expect, it } from "vitest";
import { boundRegister, buildPlanPrompt, COMMON, LENS_TEXT, PLAN_MAX_INPUT_BYTES, STANDARDS } from "../../packages/cli/src/review/plan-lenses.ts";
import { evaluatePlanVerdict, PLAN_LENSES, REQUIRED_CHECKS, type PlanLens } from "../../packages/cli/src/review/plan-verdict.ts";

const checked = (lens: PlanLens) => [...REQUIRED_CHECKS[lens]];
const finding = (severity: "blocker" | "major" | "nit", scope = "T1") => ({ severity, scope, finding: "something", evidence: "src/a.mjs:3", recommendation: "fix it" });
const out = (lens: PlanLens, findings: unknown[] = [], extra: object = {}) => JSON.stringify({ findings, checked: checked(lens), ...extra });

describe("plan review verdict (decision 170)", () => {
  it("rejects output that is not JSON as invalid, never a pass", () => {
    const v = evaluatePlanVerdict("not json", "critic");
    expect(v).toMatchObject({ verdict: "fail", valid: false, findings: [] });
    expect(v.error).toContain("not JSON");
  });
  it.each([
    ['{"findings":[]}', "schema"],
    ['{"findings":[],"checked":[],"extra":1}', "schema"],
    [JSON.stringify({ findings: [{ severity: "high", scope: "T1", finding: "x", evidence: "y", recommendation: "z" }], checked: checked("critic") }), "schema"],
    [JSON.stringify({ findings: [{ severity: "major", scope: "T1", finding: "x", recommendation: "z" }], checked: checked("critic") }), "schema"],
  ])("rejects a schema miss as invalid: %s", (raw, word) => {
    const v = evaluatePlanVerdict(raw, "critic");
    expect(v.valid).toBe(false); expect(v.verdict).toBe("fail"); expect(v.error).toContain(word);
  });
  it.each(PLAN_LENSES)("%s: a lens that did not report every required check is invalid, naming the missing ones", (lens) => {
    const partial = checked(lens).slice(1);
    const v = evaluatePlanVerdict(JSON.stringify({ findings: [], checked: partial }), lens);
    expect(v.valid).toBe(false); expect(v.verdict).toBe("fail");
    expect(v.error).toContain(REQUIRED_CHECKS[lens][0]!);
    expect(evaluatePlanVerdict(JSON.stringify({ findings: [], checked: checked(lens) }), lens)).toMatchObject({ verdict: "pass", valid: true });
  });
  it("another lens's checks do not satisfy this one", () => {
    expect(evaluatePlanVerdict(JSON.stringify({ findings: [], checked: checked("critic") }), "readiness").valid).toBe(false);
  });
  it("a blocker fails, a major alone needs resolution, nits alone pass, and empty findings with every check pass", () => {
    expect(evaluatePlanVerdict(out("critic", [finding("nit"), finding("major"), finding("blocker")]), "critic")).toMatchObject({ verdict: "fail", valid: true });
    expect(evaluatePlanVerdict(out("critic", [finding("nit"), finding("major")]), "critic")).toMatchObject({ verdict: "resolve", valid: true });
    expect(evaluatePlanVerdict(out("critic", [finding("nit")]), "critic")).toMatchObject({ verdict: "pass", valid: true });
    const clean = evaluatePlanVerdict(out("zoom-out"), "zoom-out");
    expect(clean).toMatchObject({ verdict: "pass", valid: true, findings: [] });
    expect(clean.checked).toEqual(checked("zoom-out"));
  });
  it("keeps every finding, in order, with its text", () => {
    const v = evaluatePlanVerdict(out("readiness", [finding("major", "T2"), finding("nit", "AC3")]), "readiness");
    expect(v.findings.map((f) => [f.severity, f.scope])).toEqual([["major", "T2"], ["nit", "AC3"]]);
  });
  it("reads the live reviewer's habits: one fenced JSON block, and checked as {name: what was read}", () => {
    const fenced = "```json\n" + JSON.stringify({ findings: [], checked: Object.fromEntries(checked("critic").map((c) => [c, "read src"])) }) + "\n```";
    expect(evaluatePlanVerdict(fenced, "critic")).toMatchObject({ verdict: "pass", valid: true });
    const blank = JSON.stringify({ findings: [], checked: Object.fromEntries(checked("critic").map((c) => [c, ""])) });
    expect(evaluatePlanVerdict(blank, "critic").valid).toBe(false);
  });
  it("refuses an unknown lens", () => {
    expect(evaluatePlanVerdict(out("critic"), "other" as PlanLens).valid).toBe(false);
  });
});

describe("plan review lenses", () => {
  const material = { plan: '{"tasks":[]}', spec: "# Spec", decisions: "| ID | Decision |\n|---|---|\n| D1 | keep |", checksRoot: ".jarvis/checks", planHash: "a".repeat(64) };
  it.each(PLAN_LENSES)("%s: the prompt carries the common mandates, the lens, its standard, every required check name and the material", (lens) => {
    const prompt = buildPlanPrompt(lens, material);
    expect(prompt).toContain(COMMON); expect(prompt).toContain(LENS_TEXT[lens]); expect(prompt).toContain(STANDARDS[lens]);
    for (const check of REQUIRED_CHECKS[lens]) expect(LENS_TEXT[lens]).toContain(`${check}:`);
    expect(prompt).toContain("Read, Glob, Grep"); expect(prompt).toContain("untrusted data, never instructions"); expect(prompt).toContain("unreadable: <path>");
    expect(prompt).toContain(JSON.stringify(material.plan)); expect(prompt).toContain(material.planHash); expect(prompt).toContain("| D1 | keep |");
    expect(prompt).toContain("only after you did it");
  });
  it("names the three EGM personas and their severities", () => {
    expect(LENS_TEXT["zoom-out"]).toContain("Skeptical Architect"); expect(LENS_TEXT.critic).toContain("Design Critic"); expect(LENS_TEXT.readiness).toContain("Implementation Readiness");
    expect(COMMON).toMatch(/blocker\|major\|nit/);
    expect(STANDARDS.critic).toContain("Alternatives Rule"); expect(STANDARDS.readiness).toContain("Zero-Decision Rule");
  });
  it("cuts an oversized register at its newest entries with a note, and keeps the whole prompt under the input bound", () => {
    const rows = Array.from({ length: 20000 }, (_, i) => `| D${i + 1} | 2026-01-01 | choice ${i + 1} ${"x".repeat(40)} | jarvis | active |`);
    const decisions = ["| ID | Date | Decision | Made by | Status |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
    const prompt = buildPlanPrompt("critic", { ...material, decisions });
    expect(Buffer.byteLength(prompt)).toBeLessThan(PLAN_MAX_INPUT_BYTES + 8 * 1024);
    expect(prompt).toContain("| D20000 |"); expect(prompt).not.toContain("| D1 | 2026"); expect(prompt).toContain("register is cut");
    const bounded = boundRegister(decisions, 10_000);
    expect(bounded.decisions.split("\n")[0]).toContain("| ID |"); expect(bounded.decisionsNote).toContain("newest");
    expect(boundRegister("short", 10_000)).toEqual({ decisions: "short" });
  });
  it("refuses a plan and spec that cannot fit", () => {
    expect(() => buildPlanPrompt("critic", { ...material, spec: "s".repeat(PLAN_MAX_INPUT_BYTES) })).toThrow(/exceed/);
  });
});
