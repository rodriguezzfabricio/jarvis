import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanReviewService, PLAN_POLICY_HASH, PLANTED_SCOPES, readPlanCalibration, savePlanCalibration } from "../../packages/cli/src/review/plan-service.ts";
import { planReviewStatus } from "../../packages/cli/src/review/plan-resolve.ts";
import { PLAN_LENSES } from "../../packages/cli/src/review/plan-verdict.ts";
import { clean, removePlanFixtureRoots, setupPlanFixture, withFindings, type PlanFixture } from "./helpers/plan-review-fixture.ts";

afterEach(removePlanFixtureRoots);
const planReviews = (f: PlanFixture) => f.ledger.entries().filter((e) => e.kind === "plan_review").map((e) => e.data as Record<string, unknown>);

/** Two counted controls under the current policy: the bad fixture fails naming every planted scope, the good one passes. */
async function calibrate(f: PlanFixture) {
  const service = createPlanReviewService(f.options);
  f.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: plantedAnswers(/Skeptical/.test(input.prompt) ? "zoom-out" : /Critic/.test(input.prompt) ? "critic" : "readiness") }));
  const bad = await service.review(f.material, { fixture: "bad" });
  f.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: clean(/Skeptical/.test(input.prompt) ? "zoom-out" : /Critic/.test(input.prompt) ? "critic" : "readiness") }));
  const good = await service.review(f.material, { fixture: "good" });
  return { bad, good };
}
const plantedAnswers = (lens: "zoom-out" | "critic" | "readiness") => lens === "zoom-out" ? withFindings(lens, [{ severity: "major", scope: "T2" }])
  : lens === "critic" ? withFindings(lens, [{ severity: "blocker", scope: "D3" }]) : withFindings(lens, [{ severity: "major", scope: "T3" }]);

describe("plan review service (decision 170)", () => {
  it("runs the three lenses in order on the strong tier, appends one entry per lens and an overall record, and writes findings.json", async () => {
    const f = setupPlanFixture();
    await calibrate(f);
    const result = await createPlanReviewService(f.options).review(f.material);
    expect(result).toMatchObject({ verdict: "pass", counts: true, findings: [] });
    const entries = planReviews(f).filter((d) => d.purpose === "review");
    expect(entries.map((d) => d.lens)).toEqual([...PLAN_LENSES, "overall"]);
    expect(entries.every((d) => d.planHash === f.material.planHash && d.policyHash === PLAN_POLICY_HASH && d.revision === f.revision && d.counts === true)).toBe(true);
    expect(f.calls.slice(-3).map((c) => [c.model, c.effort, c.maxTurns, c.timeoutMs])).toEqual(PLAN_LENSES.map(() => ["claude-opus-5-5", "high", 40, 900_000]));
    const findings = JSON.parse(readFileSync(join(f.repoPath, ".jarvis", "plan-review", "findings.json"), "utf8"));
    expect(findings).toMatchObject({ planHash: f.material.planHash, verdict: "pass", counts: true, findings: [] });
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toEqual({ ok: true });
    expect(readdirSync(f.workRoot)).toEqual([]);
  });
  it("the reviewer sees the committed code, the plan and the runner's checks, but never the author's reasoning, notes, history or workspace edits", async () => {
    const f = setupPlanFixture();
    writeFileSync(join(f.repoPath, "src", "app.mjs"), "DIRTY-WORKSPACE-EDIT");
    await createPlanReviewService(f.options).review(f.material);
    for (const seen of f.seen) {
      expect(seen).toContain(".jarvis/plan.json"); expect(seen).toContain(".jarvis/checks/unit.check.json"); expect(seen).toContain("src/app.mjs"); expect(seen).toContain("docs/decisions.md");
      expect(seen.some((p) => p.startsWith(".git/") || p.startsWith("docs/intake/") || p.startsWith("docs/research/") || p.startsWith(".jarvis/notes/") || p.startsWith(".jarvis/intake/") || p.startsWith(".jarvis/mockups/"))).toBe(false);
    }
    for (const call of f.calls) { expect(call.prompt).not.toContain("AUTHOR-REASONING-SECRET"); expect(call.prompt).toContain(f.material.planHash); }
    expect(readFileSync(join(f.calls[0]!.workspace, "..", "..", "..", "repo", "src", "app.mjs"), "utf8")).toBe("DIRTY-WORKSPACE-EDIT");
  });
  type F = { severity: "blocker" | "major" | "nit"; scope: string };
  const precedence: [string, Record<string, F[]>, string][] = [
    ["a blocker in one lens fails", { critic: [{ severity: "blocker", scope: "T1" }] }, "fail"],
    ["a major alone needs resolution", { readiness: [{ severity: "major", scope: "T1" }] }, "resolve"],
    ["nits alone pass", { "zoom-out": [{ severity: "nit", scope: "T1" }] }, "pass"],
    ["a blocker outranks a major in another lens", { critic: [{ severity: "major", scope: "T1" }], readiness: [{ severity: "blocker", scope: "AC1" }] }, "fail"],
  ];
  it.each(precedence)("verdict precedence: %s", async (_name, perLens, expected) => {
    const f = setupPlanFixture();
    await calibrate(f);
    f.reviewer.mockImplementation(async (input) => { const lens = /Skeptical/.test(input.prompt) ? "zoom-out" : /Critic/.test(input.prompt) ? "critic" : "readiness"; const list = perLens[lens]; return { reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: list ? withFindings(lens, list) : clean(lens) }; });
    const result = await createPlanReviewService(f.options).review(f.material);
    expect(result.verdict).toBe(expected);
    expect(result.findings.map((x) => x.id)).toEqual(Object.entries(perLens).flatMap(([lens, list]) => list.map((_item, i) => `${lens}-${i + 1}`)));
    expect(planReviews(f).at(-1)).toMatchObject({ lens: "overall", verdict: expected, counts: true });
  });
  it("a lens that did not report its checks, or returned garbage, makes the review an error, never a pass", async () => {
    const f = setupPlanFixture((lens) => lens === "critic" ? '{"findings":[],"checked":["alternatives"]}' : clean(lens));
    await calibrate(f);
    f.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: /Critic/.test(input.prompt) ? "garbage" : clean(/Skeptical/.test(input.prompt) ? "zoom-out" : "readiness") }));
    const result = await createPlanReviewService(f.options).review(f.material);
    expect(result.verdict).toBe("error");
    expect(planReviews(f).filter((d) => d.purpose === "review" && d.lens === "critic").at(-1)).toMatchObject({ verdict: "error", valid: false });
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash).ok).toBe(false);
  });
  it("a reviewer that writes into its read-only checkout fails the review as an error and records nothing further", async () => {
    const f = setupPlanFixture();
    await calibrate(f);
    f.reviewer.mockImplementation(async (input) => { writeFileSync(join(input.workspace, "src", "app.mjs"), "tampered"); return { reviewer: "claude", model: input.model, rawOutput: "w", rawVerdict: clean("zoom-out") }; });
    const result = await createPlanReviewService(f.options).review(f.material);
    expect(result.verdict).toBe("error"); expect(result.error).toContain("checkout changed");
    const review = planReviews(f).filter((d) => d.purpose === "review");
    expect(review.map((d) => d.lens)).toEqual(["overall"]);
    expect(review[0]!.error).toContain("checkout changed");
  });
  it("a reviewer that throws makes an error entry for that lens and the review", async () => {
    const f = setupPlanFixture();
    await calibrate(f);
    f.reviewer.mockRejectedValue(new Error("session exploded"));
    const result = await createPlanReviewService(f.options).review(f.material);
    expect(result.verdict).toBe("error");
    expect(planReviews(f).filter((d) => d.purpose === "review").map((d) => [d.lens, d.verdict])).toEqual([["zoom-out", "error"], ["critic", "error"], ["readiness", "error"], ["overall", "error"]]);
    expect(existsSync(join(f.repoPath, ".jarvis", "plan-review", "findings.json"))).toBe(false);
  });
  it("without a passing negative control the verdict is recorded but does not count, and the result is an error", async () => {
    const f = setupPlanFixture();
    const result = await createPlanReviewService(f.options).review(f.material);
    expect(result).toMatchObject({ verdict: "error", counts: false });
    expect(result.error).toContain("no passing negative control");
    expect(planReviews(f).at(-1)).toMatchObject({ lens: "overall", verdict: "pass", counts: false });
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toMatchObject({ ok: false, reason: expect.stringContaining("negative control") });
  });
  it("calibration: the bad fixture must fail naming every planted scope and the good one must pass; a later failed control withdraws the pass; a policy change needs a new control", async () => {
    const f = setupPlanFixture(plantedAnswers);
    const service = createPlanReviewService(f.options);
    const bad = await service.review(f.material, { fixture: "bad" });
    expect(bad).toMatchObject({ verdict: "fail", counts: false });
    expect(planReviews(f).at(-1)).toMatchObject({ purpose: "calibration", fixture: "bad", planted: [...PLANTED_SCOPES] });
    expect((await service.review(f.material)).counts).toBe(false);
    f.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: clean(/Skeptical/.test(input.prompt) ? "zoom-out" : /Critic/.test(input.prompt) ? "critic" : "readiness") }));
    await service.review(f.material, { fixture: "good" });
    expect((await service.review(f.material)).counts).toBe(true);
    // A bad control that passes (the reviewer missed the planted faults) withdraws the calibration.
    await service.review(f.material, { fixture: "bad" });
    expect((await service.review(f.material)).counts).toBe(false);
    // A bad control that names only two planted scopes does not calibrate either.
    f.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: /Skeptical/.test(input.prompt) ? withFindings("zoom-out", [{ severity: "blocker", scope: "T2" }, { severity: "major", scope: "T3" }]) : clean(/Critic/.test(input.prompt) ? "critic" : "readiness") }));
    await service.review(f.material, { fixture: "bad" });
    expect((await service.review(f.material)).counts).toBe(false);
    // Named hashes must be the counted pair.
    const entries = f.ledger.entries().filter((e) => (e.data as { purpose?: string }).purpose === "calibration" && (e.data as { lens?: string }).lens === "overall");
    expect(() => savePlanCalibration({ jarvisHome: f.jarvisHome, ledger: f.ledger, routing: f.options.routing, calibration: { bad: entries[0]!.hash, good: entries[1]!.hash } })).toThrow(/calibration/);
  });
  it("a shared runner-home record calibrates another project's review only for the same model and policy", async () => {
    const f = setupPlanFixture(plantedAnswers);
    const { bad, good } = await calibrate(f);
    const badHash = bad.entries.at(-1)!.hash, goodHash = good.entries.at(-1)!.hash;
    savePlanCalibration({ jarvisHome: f.jarvisHome, ledger: f.ledger, routing: f.options.routing, calibration: { bad: badHash, good: goodHash } });
    expect(readPlanCalibration(f.jarvisHome)?.record).toMatchObject({ model: "claude-opus-5-5", policyHash: PLAN_POLICY_HASH, bad: badHash, good: goodHash });
    const other = setupPlanFixture();
    expect((await createPlanReviewService({ ...other.options, jarvisHome: f.jarvisHome }).review(other.material)).counts).toBe(true);
    expect((await createPlanReviewService(other.options).review(other.material)).counts).toBe(false);
    other.options.routing.tiers.strong.model = "claude-sonnet-5-5";
    expect((await createPlanReviewService({ ...other.options, jarvisHome: f.jarvisHome }).review(other.material)).counts).toBe(false);
  });
  it("refuses a plan hash that does not match the plan, and a work root inside runner-owned data", async () => {
    const f = setupPlanFixture();
    await calibrate(f);
    const bad = await createPlanReviewService(f.options).review({ ...f.material, planHash: "0".repeat(64) });
    expect(bad.verdict).toBe("error"); expect(bad.error).toContain("hash");
    const inside = await createPlanReviewService({ ...f.options, workRoot: f.projectDir }).review(f.material);
    expect(inside.verdict).toBe("error"); expect(inside.error).toContain("overlaps");
  });
});
