import { describe, expect, it } from "vitest";
import { evaluateVerdict, VerdictSchema } from "../../packages/cli/src/review/verdict.ts";

const finding = (patch: Record<string, unknown> = {}) => ({
  severity: "high", confidence: 0.9, impact: "other", file: "src/send.ts", line: 12,
  scenario: "A retry sends the same message twice", fix: "Keep an idempotency key", ...patch,
});
const checked = ["spec-criteria", "data-flow", "error-paths", "unchanged-callers"];
const evaluate = (...findings: unknown[]) => evaluateVerdict(JSON.stringify({ checked, findings }));

describe("review verdict policy", () => {
  it.each(checked)("refuses a verdict missing the %s check and names it", (name) => {
    const result = evaluateVerdict(JSON.stringify({ findings: [], checked: checked.filter((check) => check !== name) }));
    expect(result).toMatchObject({ valid: false, verdict: "fail" });
    expect(result.error).toContain(`review did not report its checks: ${name}`);
  });
  it("requires checked even with empty findings", () => {
    expect(evaluateVerdict('{"findings":[]}')).toMatchObject({ valid: false, verdict: "fail" });
  });
  it("requires the bug brief inputs for bug reviews", () => {
    const result = evaluateVerdict(JSON.stringify({ checked, findings: [] }), { kind: "bug" });
    expect(result).toMatchObject({ valid: false, verdict: "fail" });
    expect(result.error).toContain("bug-brief-inputs");
    expect(evaluateVerdict(JSON.stringify({ checked: [...checked, "bug-brief-inputs"], findings: [] }), { kind: "bug" })).toMatchObject({ valid: true, verdict: "pass" });
  });
  it("allows duplicate check names within the bound", () => {
    expect(evaluateVerdict(JSON.stringify({ checked: [...checked, ...checked], findings: [] }))).toMatchObject({ valid: true, verdict: "pass" });
  });
  it.each([{ names: [...checked, ...checked, "spec-criteria"] }, { names: [...checked, "invented-check"] }])("refuses invalid or oversized checks %j", ({ names }) => {
    expect(evaluateVerdict(JSON.stringify({ checked: names, findings: [] }))).toMatchObject({ valid: false, verdict: "fail" });
  });
  it("accepts an empty verdict", () => expect(evaluate().verdict).toBe("pass"));
  it.each(["critical", "high"])("fails %s with concrete evidence", (severity) => {
    expect(evaluate(finding({ severity })).verdict).toBe("fail");
  });
  it("fails critical even without a scenario", () => expect(evaluate(finding({ severity: "critical", scenario: "" })).verdict).toBe("fail"));
  it("keeps high without a scenario advisory", () => expect(evaluate(finding({ scenario: "  " })).verdict).toBe("pass"));
  it.each(["medium", "low"])("keeps %s advisory", (severity) => {
    expect(evaluate(finding({ severity })).verdict).toBe("pass");
  });
  it("drops low confidence ordinary findings", () => {
    expect(evaluate(finding({ confidence: 0.79 })).findings).toEqual([]);
    expect(evaluate(finding({ confidence: 0.79 })).investigate).toEqual([]);
  });
  it.each(["security", "data_loss", "money", "messages"])("routes uncertain %s findings to investigation", (impact) => {
    const result = evaluate(finding({ confidence: 0.1, impact }));
    expect(result.verdict).toBe("investigate");
    expect(result.findings).toEqual([]);
    expect(result.investigate).toHaveLength(1);
  });
  it.each(["critical", "high"])("holds uncertain high-impact %s findings for investigation", (severity) => {
    expect(evaluate(finding({ severity, confidence: 0.4, impact: "security" })).verdict).toBe("investigate");
  });
  it.each(["medium", "low"])("keeps uncertain %s findings advisory while recording investigation", (severity) => {
    expect(evaluate(finding({ severity, confidence: 0.4, impact: "security" })).verdict).toBe("pass");
  });
  it("accepts confidence at the cutoff", () => expect(evaluate(finding({ confidence: 0.8 })).verdict).toBe("fail"));
  it.each(["garbage", "{}", '{"findings":null}', '{"findings":[],"verdict":"pass"}'])("fails closed for malformed output %s", (raw) => {
    expect(evaluateVerdict(raw)).toMatchObject({ verdict: "fail", valid: false });
  });
  it.each([{ confidence: -0.1 }, { confidence: 1.1 }, { severity: "warning" }, { line: 0 }, { line: 1.5 }, { file: "" }, { fix: "" }, { impact: "unknown" }])("rejects invalid finding %j", (patch) => {
    expect(VerdictSchema.safeParse({ checked, findings: [finding(patch)] }).success).toBe(false);
    expect(evaluate(finding(patch)).verdict).toBe("fail");
  });
});
