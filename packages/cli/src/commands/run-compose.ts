/**
 * The production composition of `jarvis run` (architecture §3.4): protected checks from the approved
 * store, the plan judged against the runner's copy of the approved spec and the installed checks
 * (decision 91), the Claude task harness, intake recovery and the reviewer (decision 88).
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "../broker/broker.ts";
import { ChecksStore } from "../checks/store.ts";
import { allowsUnattended, doctorExitCode, runDoctor } from "../doctor/doctor.ts";
import { safeGit } from "../eval/git.ts";
import { createClaudeReviewer } from "../harness/claude/review.ts";
import { createClaudeHarness } from "../harness/claude/task.ts";
import { recoverIntakeRounds } from "../intake/round.ts";
import { Ledger } from "../ledger/ledger.ts";
import { createCodexReviewer, createReviewService, DEFAULT_REVIEW_ROUTING } from "../review/index.ts";
import { readApprovedChecks, type AuthoredCheck } from "../runner/checks-author.ts";
import { createFootprintLog } from "../runner/footprint.ts";
import type { LoopPlan, RunLoopOptions } from "../runner/loop.ts";
import { readPlan, readSessionPlan, type Plan, type SessionPlanKind } from "../runner/plan.ts";
import { rebuildState } from "../runner/state.ts";
import { checkSpec, type Spec } from "../spec/index.ts";
import type { RunContext } from "./run.ts";

export interface ApprovedSpec { version: number; path: string; text: string; spec: Spec }
export interface ComposeOptions {
  home?: string;
  /** Test seam for the runner's git calls in the main checkout. */
  git?: typeof safeGit;
  /** Per-session preflight; production runs the offline doctor checks before every session. */
  preflight?: () => Promise<boolean>;
  /** After a usage wait, before dispatch resumes; production runs the live canary probe. */
  reprobe?: () => Promise<boolean>;
  /**
   * THE REVIEWER HOOK (decision 88). Returns the loop's review function. Default: the review service
   * (review/service.ts) with fresh read-only Claude and Codex reviewers; it records its own verdicts.
   */
  createReview?: (deps: ReviewDeps) => RunLoopOptions["review"];
}
export interface ReviewDeps {
  context: RunContext;
  ledger: Ledger;
  workRoot: string;
  cacheRoot: string;
  spec: ApprovedSpec | undefined;
  git: (args: readonly string[]) => string;
  preflight: () => Promise<boolean>;
}

const PLUGIN_DIR = fileURLToPath(new URL("../../../../plugin", import.meta.url));

/** The newest committed docs/spec/vN.md on the run branch: committed and runner-gated, never a workspace copy. */
export function approvedSpec(git: (args: readonly string[]) => string, branch: string): ApprovedSpec | undefined {
  let names: string[];
  try { names = git(["ls-tree", "--name-only", `refs/heads/${branch}:docs/spec`]).split("\n").filter(Boolean); } catch { return undefined; }
  const versions = names.map((n) => /^v([1-9]\d{0,5})\.md$/.exec(n)).filter((m) => m !== null).map((m) => Number(m![1])).sort((a, b) => a - b);
  const version = versions.at(-1);
  if (version === undefined) return undefined;
  const path = `docs/spec/v${version}.md`;
  const text = git(["show", `refs/heads/${branch}:${path}`]);
  const checked = checkSpec(text, path);
  if (!checked.ok) throw new Error(`the approved spec ${path} does not check: ${checked.problems.map((p) => `line ${p.line} ${p.code}`).join("; ")}`);
  return { version, path, text, spec: checked.spec };
}

export function runBranchOf(git: (args: readonly string[]) => string): string {
  let branch: string;
  try { branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch { throw new Error("the project checkout must be on a branch (the run branch), not a detached HEAD"); }
  if (!branch || branch.startsWith("jarvis/candidates/")) throw new Error("the project checkout must be on the run branch");
  return branch;
}

/** Plan input: an explicitly named session plan, else the architect's .jarvis/plan.json, else the ledger's tasks. */
export function planFor(repoPath: string, kind: SessionPlanKind | undefined, spec: ApprovedSpec | undefined, checks: readonly AuthoredCheck[]): Plan | undefined {
  if (kind) return readSessionPlan(repoPath, kind, checks);
  if (!existsSync(join(repoPath, ".jarvis", "plan.json"))) return undefined;
  if (!spec) throw new Error(".jarvis/plan.json needs an approved spec (docs/spec/vN.md) on the run branch");
  return readPlan(repoPath, { spec: spec.spec, checks });
}

export async function prepareProductionRun(context: RunContext, options: ComposeOptions = {}): Promise<RunLoopOptions> {
  const home = options.home ?? homedir();
  const workRoot = join(home, ".jarvis-work");
  const worktreeRoot = join(workRoot, "worktrees");
  const cacheRoot = join(workRoot, "caches", context.projectId);
  for (const dir of [workRoot, worktreeRoot, cacheRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const runGit = options.git ?? safeGit;
  const git = (args: readonly string[]) => runGit(context.repoPath, args, { home }).toString().trim();
  const ledger = Ledger.open(context.projectDir);
  const checks = readApprovedChecks(new ChecksStore(context.projectDir), ledger);
  if (!checks.length) throw new Error("no approved protected checks: approve the checks before running");
  const runBranch = runBranchOf(git);
  const spec = approvedSpec(git, runBranch);
  const plan = planFor(context.repoPath, context.planKind, spec, checks);
  const preflight = options.preflight ?? (async () => doctorExitCode(await runDoctor({ home, repoPath: context.repoPath })) === 0);
  const reprobe = options.reprobe ?? (async () => allowsUnattended(await runDoctor({ home, repoPath: context.repoPath, live: true })));
  const review = (options.createReview ?? defaultReview)({ context, ledger, workRoot, cacheRoot, spec, git, preflight });
  const broker = new Broker({ ledger, project: context.projectId, adapters: [], secrets: { get: () => undefined } });
  return {
    projectId: context.projectId, projectDir: context.projectDir, jarvisHome: context.jarvisHome, repoPath: context.repoPath, runBranch,
    worktreeRoot, workRoot, gitHome: home,
    ...(options.git ? { git: options.git } : {}),
    checks: Object.fromEntries(checks.map((check) => [check.name, check])),
    createHarness: (routing) => createClaudeHarness({
      jarvisHome: context.jarvisHome, cacheRoot, worktreeRoot, allowedDomains: [], routing, home,
      ...(existsSync(PLUGIN_DIR) ? { pluginDir: PLUGIN_DIR } : {}),
      preflight: async () => ({ ok: await preflight() }),
    }),
    review, reprobe,
    footprint: createFootprintLog({ worktrees: worktreeRoot, caches: [cacheRoot], evidence: join(context.projectDir, "evidence") }),
    recoverIntake: (l) => { recoverIntakeRounds({ ledger: l, repoDir: context.repoPath, broker }); },
    ...(plan ? { plan: toLoopPlan(plan) } : {}),
  };
}

function toLoopPlan(plan: Plan): LoopPlan {
  return { tasks: plan.tasks.map((task) => ({ ...task })) };
}

/** The review service: one review_result per review, keyed "code", recorded by the service itself. */
function defaultReview(deps: ReviewDeps): RunLoopOptions["review"] {
  const service = createReviewService({
    ledger: deps.ledger, projectDir: deps.context.projectDir, workRoot: deps.workRoot, routing: DEFAULT_REVIEW_ROUTING,
    claude: createClaudeReviewer({ jarvisHome: deps.context.jarvisHome, workRoot: deps.workRoot, cacheRoot: deps.cacheRoot, preflight: async () => ({ ok: await deps.preflight() }) }),
    codex: createCodexReviewer(),
    resolveMaterial: async (request) => {
      const task = rebuildState(deps.ledger.entries(), { now: Date.now() }).tasks[request.taskId];
      // The diff is against the candidate's first parent: its workspace base, or the head a runner merge was made on.
      const baseRevision = deps.git(["rev-parse", "--verify", `${request.revision}^1`]);
      return { repoPath: deps.context.repoPath, baseRevision, tier: 1, spec: deps.spec?.text ?? "", acceptanceCriteria: task?.definition.acceptanceCriteria ?? [] };
    },
  });
  return async (input) => {
    // The service reviews as "code" only: another named reviewer gets no recorded verdict, so the loop blocks the task.
    if (input.reviewer !== "code") return { status: "error", recorded: true };
    const result = await service.reviewDetailed({ taskId: input.taskId, attemptId: input.attemptId, revision: input.revision });
    return { status: result.verdict, recorded: true };
  };
}
