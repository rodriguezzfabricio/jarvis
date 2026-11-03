// Shared fixture for the Goldfish plan review tests (tests/unit/review-plan-*.test.ts): a committed repo with
// author-only folders, a runner checks store, a ledger and a fake Claude reviewer answering each lens by name.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { safeGit } from "../../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../../packages/cli/src/ledger/ledger.ts";
import { DEFAULT_REVIEW_ROUTING } from "../../../packages/cli/src/review/routing.ts";
import { canonicalPlan, planHashOf } from "../../../packages/cli/src/review/plan-resolve.ts";
import { PLAN_LENSES, REQUIRED_CHECKS, type PlanLens } from "../../../packages/cli/src/review/plan-verdict.ts";
import { PLAN_POLICY_HASH, PLANTED_SCOPES, type PlanReviewMaterial, type PlanReviewServiceOptions } from "../../../packages/cli/src/review/plan-service.ts";
import type { ReviewerInput, ReviewerOutput } from "../../../packages/cli/src/review/types.ts";
import { initRepo } from "./git-repo.ts";

const roots: string[] = [];
export const removePlanFixtureRoots = () => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); };
export const LENS_MARKER: Record<PlanLens, string> = { "zoom-out": "Skeptical Architect", critic: "Design Critic", readiness: "Implementation Readiness" };
export const lensOf = (prompt: string): PlanLens => PLAN_LENSES.find((lens) => prompt.includes(LENS_MARKER[lens]))!;
export const clean = (lens: PlanLens) => JSON.stringify({ findings: [], checked: [...REQUIRED_CHECKS[lens]] });
export const withFindings = (lens: PlanLens, findings: { severity: "blocker" | "major" | "nit"; scope: string }[]) =>
  JSON.stringify({ findings: findings.map((f) => ({ ...f, finding: `${f.severity} at ${f.scope}`, evidence: "src/app.mjs:1", recommendation: "change it" })), checked: [...REQUIRED_CHECKS[lens]] });
export const PLAN_TEXT = JSON.stringify({ tier: 1, notes: ["Reuse the store."], tasks: [{ id: "T1", title: "t", goal: "g", exitCondition: "e", acceptanceCriteria: ["AC1"], storyIds: ["S1"], dependencies: [], priority: 1, requiredChecks: ["unit"], requiredReviews: ["code"] }] });

export interface PlanFixture {
  root: string; repoPath: string; projectDir: string; workRoot: string; jarvisHome: string; ledger: Ledger;
  revision: string; material: PlanReviewMaterial; options: PlanReviewServiceOptions;
  calls: ReviewerInput[]; reviewer: ReturnType<typeof vi.fn<(input: ReviewerInput) => Promise<ReviewerOutput>>>;
  /** What the fake reviewer saw in its checkout on each call: the sorted relative listing. */
  seen: string[][];
  git: (args: string[]) => string;
}

export function listing(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => e.isDirectory() ? listing(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
}

export function setupPlanFixture(answer: (lens: PlanLens, input: ReviewerInput) => string | ReviewerOutput = (lens) => clean(lens)): PlanFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-review-"))); roots.push(root);
  const repoPath = join(root, "repo"), workRoot = join(root, "work"), jarvisHome = join(root, "jarvis-home"), projectDir = join(jarvisHome, "projects", "p"), checksSource = join(projectDir, "checks");
  for (const d of [repoPath, workRoot, projectDir, jarvisHome, checksSource]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const git = (args: string[]) => safeGit(repoPath, args, { home: root }).toString().trim();
  initRepo(repoPath, { branch: "main" });
  mkdirSync(join(repoPath, "src")); writeFileSync(join(repoPath, "src", "app.mjs"), "export const a = 1;\nexport const b = 2;\n");
  mkdirSync(join(repoPath, "docs", "spec"), { recursive: true }); writeFileSync(join(repoPath, "docs", "spec", "v1.md"), "# Spec\n");
  writeFileSync(join(repoPath, "docs", "decisions.md"), "| ID | Decision |\n|---|---|\n| D1 | keep |\n");
  for (const dir of ["docs/intake", "docs/research", ".jarvis/notes", ".jarvis/intake", ".jarvis/mockups"]) { mkdirSync(join(repoPath, dir), { recursive: true }); writeFileSync(join(repoPath, dir, "secret.md"), "AUTHOR-REASONING-SECRET"); }
  writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n");
  git(["add", "-A"]); git(["commit", "--quiet", "-m", "base"]);
  const revision = git(["rev-parse", "HEAD"]);
  mkdirSync(join(repoPath, ".jarvis"), { recursive: true }); writeFileSync(join(repoPath, ".jarvis", "plan.json"), PLAN_TEXT);
  writeFileSync(join(checksSource, "unit.check.json"), JSON.stringify({ name: "unit", criteria: ["AC1"], cases: [{ id: "c", command: "node t.mjs" }], verify: "sh v.sh", timeoutMs: 1000 }));
  const ledger = Ledger.open(projectDir);
  const calls: ReviewerInput[] = [], seen: string[][] = [];
  const reviewer = vi.fn(async (input: ReviewerInput): Promise<ReviewerOutput> => {
    const lens = lensOf(input.prompt);
    const out = answer(lens, input);
    return typeof out === "string" ? { reviewer: "claude", model: input.model, rawOutput: `${lens}-raw`, rawVerdict: out } : out;
  });
  const material: PlanReviewMaterial = { repoPath, revision, plan: canonicalPlan(PLAN_TEXT), planHash: planHashOf(PLAN_TEXT), spec: "# Spec\n", decisions: "| D1 | keep |", checksSource, checksRoot: ".jarvis/checks", tier: 1 };
  // The recording wrapper stays whatever implementation a test gives the mock.
  const claude = async (input: ReviewerInput): Promise<ReviewerOutput> => { calls.push(input); seen.push(listing(input.workspace)); return reviewer(input); };
  const options: PlanReviewServiceOptions = { ledger, projectDir, workRoot, home: root, routing: structuredClone(DEFAULT_REVIEW_ROUTING), claude };
  return { root, repoPath, projectDir, workRoot, jarvisHome, ledger, revision, material, options, calls, reviewer, seen, git };
}

export const exists = (path: string) => existsSync(path);

/**
 * Two counted controls under the current policy, written as the service writes its overall calibration records
 * (bad failed naming every planted scope, good passed), so a test that is not about calibration skips six reviews.
 */
export function seedCalibration(ledger: Ledger, model = "claude-opus-5-5"): void {
  const base = { revision: "0".repeat(40), planHash: "0".repeat(64), policyHash: PLAN_POLICY_HASH, model, counts: false, findings: [], purpose: "calibration" };
  ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { ...base, lens: "overall", fixture: "bad", verdict: "fail", planted: [...PLANTED_SCOPES] } });
  ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { ...base, lens: "overall", fixture: "good", verdict: "pass", planted: [] } });
}
