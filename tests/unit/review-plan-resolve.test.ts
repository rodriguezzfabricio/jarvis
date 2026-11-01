import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptEscalation, canonicalPlan, contestEvidence, planFileHash, planHashOf, planReviewStatus, resolvePlanReview } from "../../packages/cli/src/review/plan-resolve.ts";
import { createPlanReviewService } from "../../packages/cli/src/review/plan-service.ts";
import { clean, PLAN_TEXT, removePlanFixtureRoots, seedCalibration, setupPlanFixture, withFindings, type PlanFixture } from "./helpers/plan-review-fixture.ts";

afterEach(removePlanFixtureRoots);
const register = [{ id: 1, status: { kind: "active" } }, { id: 2, status: { kind: "superseded" } }];
type F = { severity: "blocker" | "major" | "nit"; scope: string };
const lensOf = (prompt: string) => /Skeptical/.test(prompt) ? "zoom-out" as const : /Critic/.test(prompt) ? "critic" as const : "readiness" as const;

/** A counted review whose findings are `perLens`; returns the fixture with its ledger holding the review. */
async function reviewed(perLens: Partial<Record<"zoom-out" | "critic" | "readiness", F[]>>): Promise<PlanFixture> {
  const f = setupPlanFixture();
  const service = createPlanReviewService(f.options);
  seedCalibration(f.ledger);
  f.reviewer.mockImplementation(async (input) => { const lens = lensOf(input.prompt); const list = perLens[lens]; return { reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: list ? withFindings(lens, list) : clean(lens) }; });
  await service.review(f.material);
  return f;
}
function writeResolution(f: PlanFixture, resolutions: unknown[], planHash = f.material.planHash) {
  mkdirSync(join(f.repoPath, ".jarvis", "plan-review"), { recursive: true });
  writeFileSync(join(f.repoPath, ".jarvis", "plan-review", "resolution.json"), JSON.stringify({ planHash, resolutions }));
}
const resolutions = (f: PlanFixture) => f.ledger.entries().filter((e) => e.kind === "plan_review" && (e.data as { purpose: string }).purpose !== "review" && (e.data as { purpose: string }).purpose !== "calibration").map((e) => e.data as Record<string, unknown>);

describe("plan hash", () => {
  it("is the sha256 of the parsed plan's canonical JSON, so key order and whitespace do not change it", () => {
    const reordered = JSON.stringify({ tasks: JSON.parse(PLAN_TEXT).tasks, notes: ["Reuse the store."], tier: 1 }, null, 2);
    expect(planHashOf(reordered)).toBe(planHashOf(PLAN_TEXT));
    expect(canonicalPlan(reordered)).toBe(canonicalPlan(PLAN_TEXT));
    expect(planHashOf(PLAN_TEXT.replace('"tier":1', '"tier":2'))).not.toBe(planHashOf(PLAN_TEXT));
    const f = setupPlanFixture();
    expect(planFileHash(f.repoPath)).toBe(f.material.planHash);
  });
});

describe("plan review resolution (decision 172)", () => {
  it("records a complete resolution: a major contested with a file:line, another fixed on a changed plan, a nit declined", async () => {
    const f = await reviewed({ critic: [{ severity: "major", scope: "T1" }, { severity: "nit", scope: "T1" }], readiness: [{ severity: "major", scope: "AC1" }] });
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toMatchObject({ ok: false, reason: expect.stringContaining("critic-1, readiness-1") });
    writeFileSync(join(f.repoPath, ".jarvis", "plan.json"), PLAN_TEXT.replace('"tier":1', '"tier":2'));
    writeResolution(f, [{ id: "critic-1", action: "contest", evidence: "src/app.mjs:2" }, { id: "readiness-1", action: "fix" }, { id: "critic-2", action: "decline" }]);
    const result = resolvePlanReview(f.repoPath, f.ledger, register);
    expect(result.escalations).toEqual([]);
    expect(resolutions(f)).toMatchObject([{ purpose: "resolution", planHash: f.material.planHash, resolutions: [{ id: "critic-1", action: "contest" }, { id: "readiness-1", action: "fix" }, { id: "critic-2", action: "decline" }] }]);
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toEqual({ ok: true });
    // The fixed plan has a new hash with no review of its own.
    expect(planReviewStatus(f.ledger.entries(), planFileHash(f.repoPath))).toMatchObject({ ok: false, reason: expect.stringContaining("no Goldfish review") });
  });
  it.each([
    ["a major without a resolution", [{ id: "critic-1", action: "contest", evidence: "src/app.mjs" }], /missing: readiness-1/],
    ["a resolution for a finding the review did not make", [{ id: "critic-1", action: "contest", evidence: "src/app.mjs" }, { id: "readiness-1", action: "fix" }, { id: "zoom-out-3", action: "decline" }], /names no finding/],
    ["two resolutions for one finding", [{ id: "critic-1", action: "contest", evidence: "src/app.mjs" }, { id: "critic-1", action: "fix" }, { id: "readiness-1", action: "fix" }], /more than one/],
    ["a declined major", [{ id: "critic-1", action: "decline" }, { id: "readiness-1", action: "fix" }], /decline is for nits only/],
    ["a contested nit", [{ id: "critic-1", action: "contest", evidence: "src/app.mjs" }, { id: "readiness-1", action: "fix" }, { id: "critic-2", action: "contest", evidence: "src/app.mjs" }], /may only be fixed or declined/],
    ["\"this was intentional\" as evidence", [{ id: "critic-1", action: "contest", evidence: "this was intentional" }, { id: "readiness-1", action: "fix" }], /not evidence/],
    ["evidence naming no file", [{ id: "critic-1", action: "contest", evidence: "src/missing.mjs" }, { id: "readiness-1", action: "fix" }], /names no file/],
    ["evidence naming a line the file lacks", [{ id: "critic-1", action: "contest", evidence: "src/app.mjs:99" }, { id: "readiness-1", action: "fix" }], /line the file does not have/],
    ["evidence outside the repo", [{ id: "critic-1", action: "contest", evidence: "../etc/passwd" }, { id: "readiness-1", action: "fix" }], /repo-relative/],
    ["a superseded decision as evidence", [{ id: "critic-1", action: "contest", evidence: "D2" }, { id: "readiness-1", action: "fix" }], /not an active decision/],
    ["a blank escalation question", [{ id: "critic-1", action: "escalate", question: " " }, { id: "readiness-1", action: "fix" }], /./],
    ["an unknown action", [{ id: "critic-1", action: "accept" }, { id: "readiness-1", action: "fix" }], /./],
  ] as const)("refuses %s and appends nothing", async (_name, list, message) => {
    const f = await reviewed({ critic: [{ severity: "major", scope: "T1" }, { severity: "nit", scope: "T1" }], readiness: [{ severity: "major", scope: "AC1" }] });
    writeFileSync(join(f.repoPath, ".jarvis", "plan.json"), PLAN_TEXT.replace('"tier":1', '"tier":2'));
    writeResolution(f, [...list]);
    expect(() => resolvePlanReview(f.repoPath, f.ledger, register)).toThrow(message);
    expect(resolutions(f)).toEqual([]);
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash).ok).toBe(false);
  });
  it("a fix needs a changed plan", async () => {
    const f = await reviewed({ readiness: [{ severity: "major", scope: "AC1" }] });
    writeResolution(f, [{ id: "readiness-1", action: "fix" }]);
    expect(() => resolvePlanReview(f.repoPath, f.ledger, register)).toThrow(/changed .jarvis\/plan.json/);
    expect(resolutions(f)).toEqual([]);
  });
  it("a blocker is contested only with an active decision id; a file is not enough", async () => {
    const f = await reviewed({ critic: [{ severity: "blocker", scope: "D1" }] });
    writeResolution(f, [{ id: "critic-1", action: "contest", evidence: "src/app.mjs:1" }]);
    expect(() => resolvePlanReview(f.repoPath, f.ledger, register)).toThrow(/only with an active decision/);
    writeResolution(f, [{ id: "critic-1", action: "contest", evidence: "D1" }]);
    resolvePlanReview(f.repoPath, f.ledger, register);
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toEqual({ ok: true });
  });
  it("an escalation blocks the run until the user answers it in the terminal, once", async () => {
    const f = await reviewed({ "zoom-out": [{ severity: "major", scope: "T1" }] });
    writeResolution(f, [{ id: "zoom-out-1", action: "escalate", question: "Keep SQLite or move to Postgres? The plan assumes SQLite." }]);
    expect(resolvePlanReview(f.repoPath, f.ledger, register).escalations).toEqual(["zoom-out-1"]);
    expect(resolutions(f).map((d) => d.purpose)).toEqual(["resolution", "escalation"]);
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toMatchObject({ ok: false, reason: expect.stringContaining("zoom-out-1") });
    expect(() => acceptEscalation(f.ledger, "critic-9", "SQLite")).toThrow(/no escalation/);
    expect(() => acceptEscalation(f.ledger, "zoom-out-1", "  ")).toThrow(/1 to 2000/);
    const answer = acceptEscalation(f.ledger, "zoom-out-1", "Keep SQLite.");
    expect(answer.data).toMatchObject({ purpose: "escalation_answer", id: "zoom-out-1", answer: "Keep SQLite.", by: "user", planHash: f.material.planHash });
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toEqual({ ok: true });
    expect(() => acceptEscalation(f.ledger, "zoom-out-1", "Again")).toThrow(/already answered/);
  });
  it("a resolution against another plan hash, or a review that does not count, is refused", async () => {
    const f = await reviewed({ readiness: [{ severity: "major", scope: "AC1" }] });
    writeResolution(f, [{ id: "readiness-1", action: "contest", evidence: "D1" }], "0".repeat(64));
    expect(() => resolvePlanReview(f.repoPath, f.ledger, register)).toThrow(/no plan review at hash/);
    const g = setupPlanFixture((lens) => lens === "readiness" ? withFindings(lens, [{ severity: "major", scope: "AC1" }]) : clean(lens));
    await createPlanReviewService(g.options).review(g.material);
    writeResolution(g, [{ id: "readiness-1", action: "contest", evidence: "D1" }]);
    expect(() => resolvePlanReview(g.repoPath, g.ledger, register)).toThrow(/does not count/);
  });
  it("a passing review needs no resolution; a failed one needs its blocker resolved", async () => {
    const f = await reviewed({});
    expect(planReviewStatus(f.ledger.entries(), f.material.planHash)).toEqual({ ok: true });
    const g = await reviewed({ critic: [{ severity: "blocker", scope: "T1" }] });
    expect(planReviewStatus(g.ledger.entries(), g.material.planHash)).toMatchObject({ ok: false, reason: expect.stringContaining("critic-1") });
  });
  it("contestEvidence accepts a file, a file with a line it has, or an active decision", () => {
    const f = setupPlanFixture();
    expect(contestEvidence(f.repoPath, "src/app.mjs", register)).toBe("file");
    expect(contestEvidence(f.repoPath, "src/app.mjs:2", register)).toBe("file");
    expect(contestEvidence(f.repoPath, "D1", register)).toBe("decision");
    expect(() => contestEvidence(f.repoPath, ".jarvis/plan.json", register)).toThrow(/plain repo-relative/);
    expect(() => contestEvidence(f.repoPath, "/etc/hosts", register)).toThrow(/plain repo-relative/);
  });
});
