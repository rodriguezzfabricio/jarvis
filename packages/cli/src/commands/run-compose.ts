/**
 * The production composition of `jarvis run` (architecture §3.4): protected checks from the approved
 * store, the plan judged against the runner's copy of the approved spec and the installed checks
 * (decision 91), the Claude task harness, intake recovery and the reviewer (decision 88), the project's
 * broker hosted for the run's duration (§3.6), the runner's notifier (decision 50) and phone approvals
 * of the broker's pending requests (backlog 99, decision 117).
 */
import { createHash } from "node:crypto";
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
import { canonical, Ledger } from "../ledger/ledger.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { NtfyOptions } from "../notify/ntfy.ts";
import { approvedDesign, designMaterialFor, designOnBranch } from "../review/design-material.ts";
import { createDesignReviewService, type DesignReviewServiceOptions } from "../review/design-service.ts";
import { CODEX_API_DOMAINS } from "../review/confine.ts";
import { createCodexReviewer, createReviewService, DEFAULT_REVIEW_ROUTING, type DesignReviewService, type ReviewMaterial, type ReviewService } from "../review/index.ts";
import { planFileHash, planReviewStatus } from "../review/plan-resolve.ts";
import { readApprovedChecks, type AuthoredCheck } from "../runner/checks-author.ts";
import type { TaskTier } from "../runner/harness.ts";
import { createFootprintLog } from "../runner/footprint.ts";
import type { LoopPlan, RunLoopOptions, RunLoopResult } from "../runner/loop.ts";
import { BUG_EXIT_CONDITION, bugRequestPlan, planTasks, readPlan, readSessionPlan, type Plan, type PlanTask, type SessionPlanKind } from "../runner/plan.ts";
import {
  commitReportOnly, DEFAULT_REVIEW_REPORT, readReviewOutput, recordedFixYes, reportTargetProblem, ReviewOutputError, reviewFixPlan, runReviewFixes,
  type ReviewFixPlan, type ReviewOutput,
} from "../runner/review-fix.ts";
import { notifierSummary } from "../runner/report.ts";
import { rebuildState } from "../runner/state.ts";
import { checkSpec, type Spec } from "../spec/index.ts";
import { prepareRelease, type ReleaseSeams } from "../release/run.ts";
import { runApprovals } from "./run-approvals.ts";
import { runNotifications, type RunNotifications } from "./run-notify.ts";
import { releaseDrive } from "./run-release.ts";
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
  /** Design factory seam; production keeps the calibrated, confined Codex design route. */
  createDesignReview?: (options: DesignReviewServiceOptions) => DesignReviewService;
  /** Test seam for the notifier built from ~/.jarvis/notify.json; production uses the ntfy adapter. */
  createNotifier?: (config: NtfyOptions) => Notifier;
  /** Where the run says a notification wasn't delivered (default stderr: the detached runner's log). */
  warn?: (text: string) => void;
  /** The process whose exit and signals tear the hosted broker down (default: this one). */
  signals?: SignalHost;
  /** Test seams for the task harness (the fake claude): the session runner, the binary check, the parent environment. */
  harness?: Pick<ClaudeHarnessOptions, "session" | "binaryRealpath" | "parentEnv">;
  /** Test seams for the release step (decision 157): a fake provider CLI and pins, the smoke test's fetch. */
  release?: ReleaseSeams;
}
export interface ReviewDeps {
  tier: TaskTier;
  context: RunContext;
  ledger: Ledger;
  workRoot: string;
  cacheRoot: string;
  spec: ApprovedSpec | undefined;
  git: (args: readonly string[]) => string;
  preflight: () => Promise<boolean>;
  /** The runner-generated bug task and its original report. */
  bugRequest?: { request: string; tasks: ReadonlyMap<string, PlanTask> };
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
  const reviewTier = Math.max(deps.tier, task?.definition.riskTier ?? 0) as TaskTier;
  // The diff is against the candidate's first parent: its workspace base, or the head a runner merge was made on.
  const baseRevision = deps.git(["rev-parse", "--verify", `${revision}^1`]);
  if (task?.definition.reviewKind) return {
    repoPath: deps.context.repoPath, baseRevision, tier: task.definition.reviewKind === "review-report" ? task.definition.riskTier ?? 1 : reviewTier,
    spec: `Goal: ${task.definition.goal}\nExit condition: ${task.definition.exitCondition}`,
    acceptanceCriteria: [task.definition.exitCondition],
    ...(task.definition.reviewKind === "bug" ? { kind: "bug" as const } : {}),
  };
  const bug = deps.bugRequest?.tasks.get(taskId);
  if (bug) return { repoPath: deps.context.repoPath, baseRevision, tier: reviewTier, ...(bug.exitCondition === BUG_EXIT_CONDITION ? { kind: "bug" as const } : {}),
    spec: `Request, as typed: ${deps.bugRequest!.request}\nGoal: ${bug.goal}\nExit condition: ${bug.exitCondition}`, acceptanceCriteria: [bug.exitCondition] };
  if (deps.reviewFix) {
    const def = task?.definition ?? deps.reviewFix.tasks.get(taskId);
    return {
      repoPath: deps.context.repoPath, baseRevision, tier: deps.reviewFix.bugTasks.has(taskId) ? 2 : reviewTier,
      spec: `Request, as typed: ${deps.reviewFix.request}\nGoal: ${def?.goal ?? "-"}\nExit condition: ${def?.exitCondition ?? "-"}`,
      acceptanceCriteria: def?.exitCondition ? [def.exitCondition] : [],
      ...(deps.reviewFix.bugTasks.has(taskId) ? { kind: "bug" as const } : {}),
    };
  }
  if ((!deps.spec || task?.definition.inputMode === "free") && task) return {
    repoPath: deps.context.repoPath, baseRevision, tier: reviewTier,
    spec: `Goal: ${task.definition.goal}\nExit condition: ${task.definition.exitCondition}`,
    acceptanceCriteria: task.definition.exitCondition ? [task.definition.exitCondition] : [],
  };
  return { repoPath: deps.context.repoPath, baseRevision, tier: reviewTier, spec: deps.spec?.text ?? "", acceptanceCriteria: task?.definition.acceptanceCriteria ?? [] };
}

/**
 * `jarvis run --plan review` (decision 126): the interactive review session wrote its report and
 * .jarvis/review/findings.json in the checkout. The report path is the run's own (`--report`, else REVIEW.md),
 * never the findings' (Codex security review, round 1). Both are read with the bounded no-follow reader (no
 * report, a symlink, a path outside the checkout, or a file that builds, agents or Jarvis read refuses the run
 * before anything is hosted). The runner commits the report alone on the run branch, since every fix starts
 * from it and promotion needs a clean checkout, and plans one bug task per finding after the ledger's own tasks.
 */
export function reviewRunFor(repoPath: string, report: string, ledger: Ledger, checks: readonly { name: string }[], git: (args: readonly string[]) => string, optIn: { fix: RunContext["reviewFix"]; limits: readonly string[] }, inputHash?: string): { output: ReviewOutput; fix: ReviewFixPlan } {
  // The explicit opt-in comes first (round 3): the flag, or the user's recorded yes to the review-fix question.
  if (!optIn.fix) throw new Error("a review's fixes start only on an explicit opt-in: --fix, or --fix-answer <answerSeq>:review-fix (decision 126)");
  if (optIn.fix.by === "answer" && !recordedFixYes(ledger.entries(), optIn.fix.ref)) throw new Error(`--fix-answer ${optIn.fix.ref} names no recorded user answer of yes to the review-fix question`);
  // A tree path, not a pathspec: `HEAD:<file>` is never read as a pattern.
  const inHead = (file: string) => { try { git(["cat-file", "-e", `HEAD:${file}`]); return true; } catch { return false; } };
  const output = readReviewOutput(repoPath, report, { inCheckout: inHead });
  // The ungated report commit never replaces a file the run branch has, whoever wrote it (rounds 2 and 3). A report
  // the branch already has as it stands (a rerun) commits nothing, so it replaces nothing.
  const changes = git(["status", "--porcelain", "--untracked-files=all", "--", `:(literal)${report}`]) !== "";
  const target = changes ? reportTargetProblem(report, inHead(report)) : undefined;
  if (target) throw new ReviewOutputError("report-refused", target);
  commitReportOnly(git, report, `review report ${report} (written by the review session)`);
  const existing = Object.values(rebuildState(ledger.entries(), { now: Date.now() }).tasks).map((t) => ({ id: t.id, ...t.definition }));
  // The limits come from the opt-in (`--limit`), never from the request's words.
  return { output, fix: reviewFixPlan(output, checks, existing, optIn.limits, inputHash) };
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
  if (checked.spec.status === "draft") throw new Error(`${path} is draft; finish confirmation before running`);
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
  const spec = context.request === undefined && context.planKind === undefined ? approvedSpec(git, runBranch) : undefined;
  const verifiedInputs = new ChecksStore(context.projectDir).verify(ledger);
  if (!verifiedInputs.ok || !verifiedInputs.lockHash) throw new Error("protected checks changed during composition");
  const inputMode = context.request !== undefined || context.planKind !== undefined || !spec ? "free" as const : "spec" as const;
  const inputHashFor = (mode: "spec" | "free" | undefined): string | undefined => mode === undefined ? undefined
    : createHash("sha256").update(canonical({ spec: mode === "spec" ? spec?.text ?? null : null, checks: verifiedInputs.lockHash })).digest("hex");
  const inputHash = inputHashFor(inputMode)!;
  // A review's fixes (decision 126): read and committed before anything is hosted, so a refusal hosts nothing.
  const reviewRun = context.planKind === "review" ? reviewRunFor(context.repoPath, context.reviewReport ?? DEFAULT_REVIEW_REPORT, ledger, checks, git, { fix: context.reviewFix, limits: context.reviewLimits ?? [] }, inputHash) : undefined;
  if (context.request !== undefined && context.planKind !== undefined) throw new Error("--request cannot be combined with --plan");
  const existing = Object.values(rebuildState(ledger.entries(), { now: Date.now() }).tasks).map((t) => ({ id: t.id, ...t.definition }));
  const plan = context.request !== undefined ? bugRequestPlan(context.request, checks, existing, context.requestHandoff, inputHash)
    : reviewRun ? reviewRun.fix.plan ?? undefined : planFor(context.repoPath, context.planKind, spec, checks);
  if (!plan && context.request === undefined && context.planKind === undefined && existing.some(task => task.inputMode === "free")) {
    throw new Error("Resume this workflow with the original --request or --plan command, retaining --local and review options; a plain run cannot restore its remaining phases or release policy");
  }
  // The Goldfish gate (decision 170): an architect's plan builds only after a counted plan review at its hash passed, or every
  // blocker and major it found was resolved with nothing escalated still open. Session plans and bug requests are not plans it judges.
  if (plan && context.request === undefined && context.planKind === undefined) {
    const status = planReviewStatus(ledger.entries(), planFileHash(context.repoPath));
    if (!status.ok) throw new Error(status.reason);
  }
  const bugRequest = context.request !== undefined ? { request: context.request, tasks: new Map(plan!.tasks.map((t) => [t.id, t])) } : undefined;
  const preflight = options.preflight ?? (async () => doctorExitCode(await runDoctor({ home, repoPath: context.repoPath })) === 0);
  const reprobe = options.reprobe ?? (async () => allowsUnattended(await runDoctor({ home, repoPath: context.repoPath, live: true })));
  const reviewFix = reviewRun ? { request: reviewRun.output.request, tasks: new Map((reviewRun.fix.plan?.tasks ?? []).map((t) => [t.id, t])), bugTasks: new Set(reviewRun.fix.taskIds) } : undefined;
  const reviewDeps: ReviewDeps = { context, ledger, workRoot, cacheRoot, spec, tier: plan?.tier ?? 1, git, preflight, ...(reviewFix ? { reviewFix } : {}), ...(bugRequest ? { bugRequest } : {}) };
  const review = options.createReview ? options.createReview(reviewDeps) : defaultReview(reviewDeps, {
    home, runBranch, ...(options.createDesignReview ? { createDesignReview: options.createDesignReview } : {}),
  });
  const localLog = options.warn ?? console.error;
  const notifications: RunNotifications = context.local ? {
    blocked: async (n) => { localLog(`${n.taskId} blocked: ${n.reason}. See REPORT.md.`); },
    usageWait: async (n) => { localLog(`${n.taskId}: usage wait until ${new Date(n.resumeAt).toISOString()}.`); },
    finished: async (n) => { localLog(`Local run ${n.status}. See REPORT.md.`); },
  } : runNotifications({
    configPath: join(context.jarvisHome, "notify.json"), project: context.projectId,
    ...(options.createNotifier ? { createNotifier: options.createNotifier } : {}), ...(options.warn ? { warn: options.warn } : {}),
  });
  // A release setup (decision 157) puts the deploy adapters in the broker; a session plan (review, onboard, sweep) or a bug request never releases.
  const release = !context.local && context.planKind === undefined && context.request === undefined
    ? await prepareRelease({ projectId: context.projectId, projectDir: context.projectDir, workRoot, worktreeRoot, repoPath: context.repoPath, home, ledger }, options.release)
    : undefined;
  const broker = projectBroker({ jarvisHome: context.jarvisHome, projectDir: context.projectDir, project: context.projectId, ledger, ...(release ? { deploy: release.adapters } : {}) });
  // Before hosting: a notifier host that a session could reach refuses the run (backlog 99).
  const approvals = context.local ? { start() {}, close: async () => {} } : runApprovals({
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
    worktreeRoot, workRoot, gitHome: home, tier: plan?.tier ?? 1, inputHash, inputMode, inputHashFor,
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
    ...(plan ? { plan: { tasks: toLoopPlan(plan).tasks.map((task) => ({ ...task,
      ...(reviewFix?.bugTasks.has(task.id) || (bugRequest && task.exitCondition === BUG_EXIT_CONDITION) ? { reviewKind: "bug" as const } : {}),
    })) } } : {}),
    // A review run may touch only the tasks it created (decision 126): never the project's other unfinished work.
    ...(reviewRun ? { only: [...reviewRun.fix.taskIds] } : plan ? { only: plan.tasks.map(task => task.id) } : {}),
  };
  approvals.start();
  const fix = reviewRun?.fix;
  return {
    loop,
    // A review's fixes, then the report update with what the runner's records say happened (decision 126).
    ...(reviewRun && fix ? {
      drive: async (run: (options: RunLoopOptions) => Promise<RunLoopResult>) => (await runReviewFixes({
        output: reviewRun.output, fix,
        runFixes: () => run(loop),
        // The whole review's ids: its fix tasks are done or blocked by now, so only the update can run, and the result covers the review.
        runUpdate: (task) => run({ ...loop, tier: 1, plan: { tasks: [{ ...task, reviewKind: "review-report" }] }, only: [...fix.taskIds, task.id] }),
        state: () => rebuildState(ledger.entries(), { now: Date.now() }),
        changedFiles: (revision) => git(["diff", "--name-only", "-z", `${revision}^1`, revision]).split("\0").filter(Boolean),
      })).update,
    } : release ? {
      // The build loop, then the release step on the revision it last promoted (decision 157).
      drive: releaseDrive({ loop, release, broker, ledger, context, checks, git, runBranch, home, workRoot, worktreeRoot, tier: plan?.tier ?? 1,
        notify: (text) => notifications.blocked({ taskId: "release", reason: text }), ...(options.release ? { seams: options.release } : {}) }),
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

/**
 * The review services, each recording its own review_result: "code" always, "design" when the run branch has a
 * DESIGN.md (decision 156). Its material is read per review from the run branch's committed objects and the
 * approved store, so a bad DESIGN.md or a missing PRODUCT.md is a recorded design review error, never a run
 * that refuses to start or a design review that is skipped.
 */
function defaultReview(deps: ReviewDeps, designOptions: {home: string; runBranch: string; createDesignReview?: ComposeOptions["createDesignReview"]}): RunLoopOptions["review"] {
  const service = createReviewService({
    ledger: deps.ledger, projectDir: deps.context.projectDir, workRoot: deps.workRoot, routing: DEFAULT_REVIEW_ROUTING,
    claude: createClaudeReviewer({ jarvisHome: deps.context.jarvisHome, workRoot: deps.workRoot, cacheRoot: deps.cacheRoot, preflight: async () => ({ ok: await deps.preflight() }) }),
    codex: createCodexReviewer(),
    resolveMaterial: async (request) => reviewMaterialFor(deps, request.taskId, request.revision),
  });
  const design = designOnBranch(deps.git, designOptions.runBranch)
    ? (designOptions.createDesignReview ?? createDesignReviewService)({
      ledger: deps.ledger, projectDir: deps.context.projectDir, workRoot: deps.workRoot,
      home: designOptions.home, jarvisHome: deps.context.jarvisHome,
      resolveMaterial: async () => {
        const snapshot = approvedDesign(deps.git, designOptions.runBranch);
        if (!snapshot) throw new Error("approved DESIGN.md is missing from the run branch");
        return designMaterialFor({repoPath:deps.context.repoPath, snapshot, store:new ChecksStore(deps.context.projectDir), ledger:deps.ledger});
      },
    }) : undefined;
  return reviewDispatch(service, design);
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
