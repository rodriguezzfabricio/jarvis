/**
 * The production composition of `jarvis run` (architecture §3.4): protected checks from the approved
 * store, the plan judged against the runner's copy of the approved spec and the installed checks
 * (decision 91), the Claude task harness, intake recovery and the reviewer (decision 88), the project's
 * broker hosted for the run's duration (§3.6), the runner's notifier (decision 50) and phone approvals
 * of the broker's pending requests (backlog 99, decision 117).
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostBroker, projectBroker, type SignalHost } from "../broker/host.ts";
import { brokerSocketIn } from "../broker/server.ts";
import { ChecksStore } from "../checks/store.ts";
import { privateDir } from "../config/private-file.ts";
import { allowsUnattended, doctorExitCode, runDoctor } from "../doctor/doctor.ts";
import { safeGit } from "../eval/git.ts";
import { CLAUDE_REVIEW_DOMAINS, createClaudeReviewer } from "../harness/claude/review.ts";
import { createClaudeHarness, type ClaudeHarnessOptions } from "../harness/claude/task.ts";
import { recoverIntakeRounds } from "../intake/round.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { NtfyOptions } from "../notify/ntfy.ts";
import { CODEX_API_DOMAINS } from "../review/confine.ts";
import { createCodexReviewer, createReviewService, DEFAULT_REVIEW_ROUTING, type DesignReviewService, type ReviewMaterial, type ReviewService } from "../review/index.ts";
import { readApprovedChecks, type AuthoredCheck } from "../runner/checks-author.ts";
import { createFootprintLog } from "../runner/footprint.ts";
import type { LoopPlan, RunLoopOptions, RunLoopResult } from "../runner/loop.ts";
import { planTasks, readPlan, readSessionPlan, type Plan, type PlanTask, type SessionPlanKind } from "../runner/plan.ts";
import { commitReportOnly, DEFAULT_REVIEW_REPORT, readReviewOutput, reviewFixPlan, runReviewFixes, type ReviewFixPlan, type ReviewOutput } from "../runner/review-fix.ts";
import { notifierSummary } from "../runner/report.ts";
import { rebuildState } from "../runner/state.ts";
import { checkSpec, type Spec } from "../spec/index.ts";
import { runApprovals } from "./run-approvals.ts";
import { runNotifications } from "./run-notify.ts";
import type { PreparedRun, RunContext } from "./run.ts";

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
  /** Test seam for the notifier built from ~/.jarvis/notify.json; production uses the ntfy adapter. */
  createNotifier?: (config: NtfyOptions) => Notifier;
  /** Where the run says a notification wasn't delivered (default stderr: the detached runner's log). */
  warn?: (text: string) => void;
  /** The process whose exit and signals tear the hosted broker down (default: this one). */
  signals?: SignalHost;
  /** Test seams for the task harness (the fake claude): the session runner, the binary check, the parent environment. */
  harness?: Pick<ClaudeHarnessOptions, "session" | "binaryRealpath" | "parentEnv">;
}
export interface ReviewDeps {
  context: RunContext;
  ledger: Ledger;
  workRoot: string;
  cacheRoot: string;
  spec: ApprovedSpec | undefined;
  git: (args: readonly string[]) => string;
  preflight: () => Promise<boolean>;
  /** `jarvis run --plan review` (decision 126): the request and the fix tasks, reviewed against their finding with the bug brief. */
  reviewFix?: { request: string; tasks: ReadonlyMap<string, PlanTask>; bugTasks: ReadonlySet<string> };
}

/**
 * What a reviewer gets for one task (decision 88). A review's fixes and its report update have no spec
 * criteria: their spec is the request, the goal and the exit condition, and a fix task is a bug fix,
 * reviewed against its finding (decisions 114, 126).
 */
export function reviewMaterialFor(deps: ReviewDeps, taskId: string, revision: string): ReviewMaterial {
  const task = rebuildState(deps.ledger.entries(), { now: Date.now() }).tasks[taskId];
  // The diff is against the candidate's first parent: its workspace base, or the head a runner merge was made on.
  const baseRevision = deps.git(["rev-parse", "--verify", `${revision}^1`]);
  if (deps.reviewFix) {
    const def = task?.definition ?? deps.reviewFix.tasks.get(taskId);
    return {
      repoPath: deps.context.repoPath, baseRevision, tier: 1,
      spec: `Request, as typed: ${deps.reviewFix.request}\nGoal: ${def?.goal ?? "-"}\nExit condition: ${def?.exitCondition ?? "-"}`,
      acceptanceCriteria: def?.exitCondition ? [def.exitCondition] : [],
      ...(deps.reviewFix.bugTasks.has(taskId) ? { kind: "bug" as const } : {}),
    };
  }
  return { repoPath: deps.context.repoPath, baseRevision, tier: 1, spec: deps.spec?.text ?? "", acceptanceCriteria: task?.definition.acceptanceCriteria ?? [] };
}

/**
 * `jarvis run --plan review` (decision 126): the interactive review session wrote its report and
 * .jarvis/review/findings.json in the checkout. The report path is the run's own (`--report`, else REVIEW.md),
 * never the findings' (Codex security review, round 1). Both are read with the bounded no-follow reader (no
 * report, a symlink, a path outside the checkout, or a file that builds, agents or Jarvis read refuses the run
 * before anything is hosted). The runner commits the report alone on the run branch, since every fix starts
 * from it and promotion needs a clean checkout, and plans one bug task per finding after the ledger's own tasks.
 */
export function reviewRunFor(repoPath: string, report: string, ledger: Ledger, checks: readonly { name: string }[], git: (args: readonly string[]) => string): { output: ReviewOutput; fix: ReviewFixPlan | null } {
  // A tree path, not a pathspec: `HEAD:<file>` is never read as a pattern.
  const output = readReviewOutput(repoPath, report, { inCheckout: (file) => { try { git(["cat-file", "-e", `HEAD:${file}`]); return true; } catch { return false; } } });
  commitReportOnly(git, report, `review report ${report} (written by the review session)`);
  const existing = Object.values(rebuildState(ledger.entries(), { now: Date.now() }).tasks).map((t) => ({ id: t.id, goal: t.definition.goal, exitCondition: t.definition.exitCondition }));
  return { output, fix: reviewFixPlan(output, checks, existing) };
}

/** The build sessions' network allowlist: none. The same value goes to the harness and the phone approvals' isolation check. */
const TASK_DOMAINS: readonly string[] = Object.freeze([]);

const PLUGIN_DIR = fileURLToPath(new URL("../../../../plugin", import.meta.url));
/** The Jarvis install whose CLI sessions run as `jarvis act` (its packages/cli/bin/jarvis launcher), reopened read-only. */
const INSTALL_DIR = realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)));

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
  if (kind === "review") throw new Error("a review's fixes are planned by reviewRunFor, not read as a plan");
  if (kind) return readSessionPlan(repoPath, kind, checks);
  if (!existsSync(join(repoPath, ".jarvis", "plan.json"))) return undefined;
  if (!spec) throw new Error(".jarvis/plan.json needs an approved spec (docs/spec/vN.md) on the run branch");
  return readPlan(repoPath, { spec: spec.spec, checks });
}

export async function prepareProductionRun(context: RunContext, options: ComposeOptions = {}): Promise<PreparedRun> {
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
  // A review's fixes (decision 126): read and committed before anything is hosted, so a refusal hosts nothing.
  const reviewRun = context.planKind === "review" ? reviewRunFor(context.repoPath, context.reviewReport ?? DEFAULT_REVIEW_REPORT, ledger, checks, git) : undefined;
  const plan = reviewRun ? reviewRun.fix?.plan : planFor(context.repoPath, context.planKind, spec, checks);
  const preflight = options.preflight ?? (async () => doctorExitCode(await runDoctor({ home, repoPath: context.repoPath })) === 0);
  const reprobe = options.reprobe ?? (async () => allowsUnattended(await runDoctor({ home, repoPath: context.repoPath, live: true })));
  const reviewFix = reviewRun?.fix ? { request: reviewRun.output.request, tasks: new Map(reviewRun.fix.plan.tasks.map((t) => [t.id, t])), bugTasks: new Set(Object.values(reviewRun.fix.taskOf)) } : undefined;
  const review = (options.createReview ?? defaultReview)({ context, ledger, workRoot, cacheRoot, spec, git, preflight, ...(reviewFix ? { reviewFix } : {}) });
  const notifications = runNotifications({
    configPath: join(context.jarvisHome, "notify.json"), project: context.projectId,
    ...(options.createNotifier ? { createNotifier: options.createNotifier } : {}), ...(options.warn ? { warn: options.warn } : {}),
  });
  const broker = projectBroker({ jarvisHome: context.jarvisHome, projectDir: context.projectDir, project: context.projectId, ledger });
  // Before hosting: a notifier host that a session could reach refuses the run (backlog 99).
  const approvals = runApprovals({
    configPath: join(context.jarvisHome, "notify.json"), project: context.projectId, ledger, broker,
    // Every session's effective network policy: the builder, the Claude reviewer and the Codex reviewer (and their subdomains).
    taskAllowlists: [TASK_DOMAINS, CLAUDE_REVIEW_DOMAINS, CODEX_API_DOMAINS],
    ...(options.createNotifier ? { createNotifier: options.createNotifier } : {}), ...(options.warn ? { warn: options.warn } : {}),
  });
  // Hosted last, once everything above has been accepted: nothing after this can fail before the loop owns it.
  const runDir = realpathSync(privateDir(join(context.jarvisHome, "run")));
  const hosted = await hostBroker(broker, brokerSocketIn(runDir, context.projectId), options.signals);
  if (hosted.reconciled) (options.warn ?? console.error)(`Marked ${hosted.reconciled} interrupted action(s) as unknown; they need a person (decision 41).`);
  const loop: RunLoopOptions = {
    projectId: context.projectId, projectDir: context.projectDir, jarvisHome: context.jarvisHome, repoPath: context.repoPath, runBranch,
    worktreeRoot, workRoot, gitHome: home,
    ...(options.git ? { git: options.git } : {}),
    checks: Object.fromEntries(checks.map((check) => [check.name, check])),
    createHarness: (routing) => createClaudeHarness({
      jarvisHome: context.jarvisHome, cacheRoot, worktreeRoot, allowedDomains: TASK_DOMAINS, routing, home,
      ...(existsSync(PLUGIN_DIR) ? { pluginDir: PLUGIN_DIR } : {}),
      // Sessions reach the run's broker at its bound address, and run `jarvis act` from the read-only install.
      brokerSocket: hosted.socketPath, installDir: INSTALL_DIR,
      preflight: async () => ({ ok: await preflight() }),
      ...options.harness,
    }),
    review, reprobe,
    notify: notifications.usageWait, notifyBlocked: notifications.blocked,
    footprint: createFootprintLog({ worktrees: worktreeRoot, caches: [cacheRoot], evidence: join(context.projectDir, "evidence") }),
    recoverIntake: (l) => { recoverIntakeRounds({ ledger: l, repoDir: context.repoPath, broker }); },
    ...(plan ? { plan: toLoopPlan(plan) } : {}),
  };
  approvals.start();
  const fix = reviewRun?.fix ?? null;
  return {
    loop,
    // A review's fixes, then the report update with what the runner's records say happened (decision 126).
    ...(reviewRun && fix ? {
      drive: async (run: (options: RunLoopOptions) => Promise<RunLoopResult>) => (await runReviewFixes({
        output: reviewRun.output, fix,
        runFixes: () => run(loop),
        runUpdate: (task) => run({ ...loop, plan: { tasks: [task] } }),
        state: () => rebuildState(ledger.entries(), { now: Date.now() }),
        changedFiles: (revision) => git(["diff", "--name-only", "-z", `${revision}^1`, revision]).split("\0").filter(Boolean),
      })).update,
    } : {}),
    // The broker stops taking requests first; then the poller flushes the last ones to the phone and stops.
    close: async () => {
      try { await hosted.close(); }
      finally { await approvals.close(); }
    },
    finished: (result) => notifications.finished(result ? { status: result.status, summary: summary(ledger) } : { status: "error" }),
  };
}

/** The report's one line for the notifier; a ledger that can't be read gives no summary, never a throw. */
function summary(ledger: Ledger): string {
  try {
    const entries = ledger.entries();
    return notifierSummary(rebuildState(entries, { now: Date.now() }), entries);
  } catch { return "REPORT.md on your Mac has the details."; }
}

/** The plan's top-level notes ride on every task (decision 113), so each build prompt shows them as planner claims. */
function toLoopPlan(plan: Plan): LoopPlan {
  return { tasks: planTasks(plan) };
}

/** The review service: one review_result per review, keyed "code", recorded by the service itself. */
function defaultReview(deps: ReviewDeps): RunLoopOptions["review"] {
  const service = createReviewService({
    ledger: deps.ledger, projectDir: deps.context.projectDir, workRoot: deps.workRoot, routing: DEFAULT_REVIEW_ROUTING,
    claude: createClaudeReviewer({ jarvisHome: deps.context.jarvisHome, workRoot: deps.workRoot, cacheRoot: deps.cacheRoot, preflight: async () => ({ ok: await deps.preflight() }) }),
    codex: createCodexReviewer(),
    resolveMaterial: async (request) => reviewMaterialFor(deps, request.taskId, request.revision),
  });
  // No design service yet: `jarvis run` has no runner-owned design material or calibration record (backlog 133).
  return reviewDispatch(service);
}

/**
 * The loop's review function by reviewer name. Each service records its own verdict, errors included (decision 111):
 * "code" goes to the code review service, "design" to the design review service when the run has one (decision 124),
 * whose verdicts are errors until its negative control passed (decision 56). Another name gets no recorded verdict,
 * so the loop blocks the task.
 */
export function reviewDispatch(code: Pick<ReviewService, "reviewDetailed">, design?: Pick<DesignReviewService, "reviewDetailed">): RunLoopOptions["review"] {
  return async (input) => {
    const request = { taskId: input.taskId, attemptId: input.attemptId, revision: input.revision };
    if (input.reviewer === "code") return { status: (await code.reviewDetailed(request)).verdict, recorded: true };
    if (input.reviewer === "design" && design) return { status: (await design.reviewDetailed(request)).verdict, recorded: true };
    return { status: "error", recorded: true };
  };
}
