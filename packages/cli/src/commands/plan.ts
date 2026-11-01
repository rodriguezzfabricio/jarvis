/**
 * `jarvis plan review|resolve|accept` (decisions 170 and 172): the Goldfish plan review between the architect
 * session and `jarvis run`. The review composes the production read-only Claude reviewer on the strong tier;
 * resolve and accept are runner-side validation with no model.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { ChecksStore } from "../checks/store.ts";
import { projectRoot, resolveProject } from "../config/project.ts";
import { DecisionRegister } from "../decisions/store.ts";
import { allowsUnattended, runDoctor } from "../doctor/doctor.ts";
import { safeGit } from "../eval/git.ts";
import { createClaudeReviewer } from "../harness/claude/review.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readPlanningFile } from "../runner/checks-author.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { acceptEscalation, canonicalPlan, planHashOf, planReviewStatus, resolvePlanReview } from "../review/plan-resolve.ts";
import { createPlanReviewService, savePlanCalibration, type PlanFixture, type PlanReviewMaterial, type PlanReviewResult } from "../review/plan-service.ts";
import { DEFAULT_REVIEW_ROUTING } from "../review/routing.ts";
import type { Reviewer } from "../review/types.ts";
import { approvedSpec, runBranchOf } from "./run-compose.ts";
import type { RunContext } from "./run.ts";

export interface PlanCommandOptions {
  home?: string;
  reviewer?: Reviewer;
  git?: typeof safeGit;
  /** Where the calibration fixtures live (default: the install's tests/fixtures/plan-review). */
  fixturesDir?: string;
  out?: (text: string) => void;
}

function contextFor(repo: string | undefined, home: string): RunContext {
  const cwd = resolve(repo ?? process.cwd());
  const projectId = resolveProject({ env: process.env, cwd });
  const jarvisHome = join(home, ".jarvis");
  return { projectId, projectDir: runnerProjectDir(projectId, jarvisHome), jarvisHome, repoPath: projectRoot(cwd) };
}

/** The run branch's committed register text, or empty when the project has none yet. */
function committedRegister(git: (args: readonly string[]) => string, branch: string): string {
  try { return git(["show", `refs/heads/${branch}:docs/decisions.md`]); } catch { return ""; }
}

function materialFor(context: RunContext, git: (args: readonly string[]) => string, store: ChecksStore): PlanReviewMaterial {
  const branch = runBranchOf(git);
  const spec = approvedSpec(git, branch);
  if (!spec) throw new Error("plan review needs an approved spec (docs/spec/vN.md) on the run branch");
  const planText = readPlanningFile(context.repoPath, ".jarvis/plan.json");
  const plan = canonicalPlan(planText);
  const parsed = JSON.parse(plan) as { tier?: 0 | 1 | 2 };
  return { repoPath: context.repoPath, revision: git(["rev-parse", "HEAD"]), plan, planHash: planHashOf(planText), spec: spec.text, decisions: committedRegister(git, branch), checksSource: store.checksDir, checksRoot: ".jarvis/checks", tier: parsed.tier ?? 1 };
}

const FIXTURES = new URL("../../../../tests/fixtures/plan-review/", import.meta.url);

export async function planReview(repo: string | undefined, deps: PlanCommandOptions, calibrate?: PlanFixture): Promise<PlanReviewResult> {
  const home = deps.home ?? homedir(), context = contextFor(repo, home);
  const runGit = deps.git ?? safeGit;
  const git = (args: readonly string[]) => runGit(context.repoPath, args, { home }).toString().trim();
  const workRoot = join(home, ".jarvis-work"), cacheRoot = join(workRoot, "caches", context.projectId);
  for (const dir of [workRoot, cacheRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(context.projectDir), store = new ChecksStore(context.projectDir);
  const reviewer = deps.reviewer ?? createClaudeReviewer({
    jarvisHome: context.jarvisHome, home, workRoot, cacheRoot,
    preflight: async () => ({ ok: allowsUnattended(await runDoctor({ home, repoPath: context.repoPath, live: true })) }),
  });
  const service = createPlanReviewService({ ledger, projectDir: context.projectDir, workRoot, routing: DEFAULT_REVIEW_ROUTING, claude: reviewer, home, git: runGit, jarvisHome: context.jarvisHome });
  if (calibrate) return service.review(calibrationMaterial(calibrate, deps, home, workRoot, store, runGit), { fixture: calibrate });
  return service.review(materialFor(context, git, store));
}

/** The fixture's repo, committed once under the work root, with its own plan, spec and checks. */
function calibrationMaterial(fixture: PlanFixture, deps: PlanCommandOptions, home: string, workRoot: string, store: ChecksStore, runGit: typeof safeGit): PlanReviewMaterial {
  const source = deps.fixturesDir ? join(deps.fixturesDir, fixture) : join(realpathSync(FIXTURES), fixture);
  for (const name of ["repo", "plan.json", "spec.md"]) if (!existsSync(join(source, name))) throw new Error(`calibration fixture ${fixture} lacks ${name} at ${source}`);
  const dir = join(workRoot, "plan-calibration", `${fixture}-${Date.now()}`), repo = join(dir, "repo");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  runGit(dir, ["-c", "protocol.file.allow=always", "clone", "--quiet", "--no-local", "--", join(source, "repo"), repo], { home });
  const revision = runGit(repo, ["rev-parse", "HEAD"], { home }).toString().trim();
  const planText = readPlanningFile(source, "plan.json"), spec = readPlanningFile(source, "spec.md");
  const decisions = existsSync(join(source, "repo", "docs", "decisions.md")) ? readPlanningFile(source, "repo/docs/decisions.md") : "";
  const checksSource = existsSync(join(source, "checks")) ? join(source, "checks") : store.checksDir;
  return { repoPath: repo, revision, plan: canonicalPlan(planText), planHash: planHashOf(planText), spec, decisions, checksSource, checksRoot: ".jarvis/checks", tier: 2 };
}

export function register(program: Command, deps: PlanCommandOptions = {}): void {
  const out = deps.out ?? ((text: string) => console.log(text));
  const plan = program.command("plan").description("The Goldfish plan review between the architect and the build loop (decision 170)");
  plan.command("review").description("Review .jarvis/plan.json with three fresh read-only lenses; writes .jarvis/plan-review/findings.json")
    .option("--repo <dir>", "project repository (default: current directory)")
    .option("--calibrate <fixture>", "run the negative control on the bad or good fixture instead of the project's plan")
    .option("--save-calibration <badHash>:<goodHash>", "publish a verified pair of control entries as the shared calibration record")
    .action(async (options: { repo?: string; calibrate?: string; saveCalibration?: string }) => {
      try {
        if (options.saveCalibration !== undefined) {
          const m = /^([a-f0-9]{64}):([a-f0-9]{64})$/.exec(options.saveCalibration);
          if (!m) throw new Error("--save-calibration takes <badHash>:<goodHash>, two ledger entry hashes");
          const home = deps.home ?? homedir(), context = contextFor(options.repo, home);
          savePlanCalibration({ jarvisHome: context.jarvisHome, ledger: Ledger.open(context.projectDir), routing: DEFAULT_REVIEW_ROUTING, calibration: { bad: m[1]!, good: m[2]! } });
          out("Plan calibration saved for this model and policy."); return;
        }
        if (options.calibrate !== undefined && options.calibrate !== "bad" && options.calibrate !== "good") throw new Error("--calibrate takes bad or good");
        const result = await planReview(options.repo, deps, options.calibrate as PlanFixture | undefined);
        const overall = result.entries.at(-1);
        out(`Plan review ${result.verdict}${result.counts ? "" : " (does not count: no passing negative control)"}; ${result.findings.length} finding(s)${options.calibrate ? `; control entry ${overall?.hash ?? "?"}` : "; findings in .jarvis/plan-review/findings.json"}`);
        for (const f of result.findings) out(`  ${f.id} [${f.severity}] ${f.scope}: ${f.finding}`);
        if (result.error) { out(result.error); process.exitCode = 1; }
        else if (result.verdict !== "pass") process.exitCode = 1;
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  plan.command("resolve").description("Record .jarvis/plan-review/resolution.json: contest with evidence, fix, escalate or decline each finding")
    .option("--repo <dir>", "project repository (default: current directory)")
    .action((options: { repo?: string }) => {
      try {
        const home = deps.home ?? homedir(), context = contextFor(options.repo, home);
        const register = DecisionRegister.open(context.repoPath).read().entries;
        const result = resolvePlanReview(context.repoPath, Ledger.open(context.projectDir), register);
        out(`Resolution recorded (${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"})${result.escalations.length ? `; waiting for the user on ${result.escalations.join(", ")}` : ""}`);
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  plan.command("accept").description("Answer an escalated plan-review finding as the user")
    .argument("<id>", "the finding id, as in findings.json")
    .requiredOption("--answer <text>", "your answer, recorded once")
    .option("--repo <dir>", "project repository (default: current directory)")
    .action((id: string, options: { answer: string; repo?: string }) => {
      try {
        const home = deps.home ?? homedir(), context = contextFor(options.repo, home);
        const entry = acceptEscalation(Ledger.open(context.projectDir), id, options.answer);
        out(`Answer recorded for ${id} (ledger seq ${entry.seq}). Record the decision it settles with jarvis decide --by jarvis --why "user answer to ${id}: …".`);
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  plan.command("status").description("Whether jarvis run would accept the current plan")
    .option("--repo <dir>", "project repository (default: current directory)")
    .action((options: { repo?: string }) => {
      try {
        const home = deps.home ?? homedir(), context = contextFor(options.repo, home);
        const status = planReviewStatus(Ledger.open(context.projectDir).entries(), planHashOf(readPlanningFile(context.repoPath, ".jarvis/plan.json")));
        out(status.ok ? "The plan has a counted Goldfish review: jarvis run may build it." : status.reason);
        if (!status.ok) process.exitCode = 1;
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
}
