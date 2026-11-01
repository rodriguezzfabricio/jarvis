import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checkRuntimePath, ChecksStore } from "../checks/store.ts";
import { readEvalDesignPlan, installEvalDesignChecks, captureDesignBaseline } from "../lanes/eval-design.ts";
import { installDesignLintChecks } from "../lanes/design-protected.ts";
import { designLintPath } from "../lanes/design-lint-driver.ts";
import { readPlanningFile } from "../runner/checks-author.ts";
import { approvedDesign, designMaterialFor, designOnBranch } from "../review/design-material.ts";
import { createDesignReviewService, type DesignReviewService, type DesignReviewServiceOptions } from "../review/design-service.ts";
import type { GateCheck, GateInput, GateResult } from "../checks/gate.ts";
import { createClaudeHarness, type ClaudeHarnessOptions } from "../harness/claude/task.ts";
import { checkSessionToolchain } from "../harness/claude/toolchain.ts";
import { createClaudeReviewer, type ClaudeReviewerOptions } from "../harness/claude/review.ts";
import { Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import { createReviewService, DEFAULT_REVIEW_ROUTING, type ReviewMaterial, type ReviewRequest } from "../review/index.ts";
import type { Harness, TaskOutcome, TaskTier } from "../runner/harness.ts";
import { PLAN_NOTES, planEntries, readPlan, singleTaskPlan, type Plan } from "../runner/plan.ts";
import {
  commitReportOnly, DEFAULT_REVIEW_REPORT, readReviewOutput, reportTargetProblem, reviewFixPlan, reviewStepEvidence, reviewStepHeader, reviewStepPrompt, reviewStepSkills, runReviewFixes, writeReportFile,
  type FindingOutcome, type ReviewOutput,
} from "../runner/review-fix.ts";
import { DEFAULT_ONBOARD_REPORT, onboardStepHeader, onboardStepPrompt, readOnboardOutput, type OnboardOutput } from "../runner/onboard-step.ts";
import { loadRouting, routeTask, type RoutingTable } from "../runner/routing.ts";
import { loadSkills } from "../runner/session-skills.ts";
import { rebuildState, repairsUsed, type RunState } from "../runner/state.ts";
import { recordSessionUsage, summarizeUsage, type UsageTotals } from "../runner/usage-log.ts";
import type { UsageWaitNotice } from "../runner/usage-wait.ts";
import { createWorkspace } from "../runner/worktrees.ts";
import { checkSpec, type Spec } from "../spec/index.ts";
import { triage, typedReport, type Triage } from "../triage/triage.ts";
import { checkEvalDomains, EXCLUDE, type GoldenTask } from "./baseline.ts";
import { safeGit } from "./git.ts";
import { assertHiddenAbsent, assertHiddenDisjoint, gradeRun, hiddenDir, installHiddenChecks, loadHiddenChecks, type Grade, type HiddenChecks } from "./hidden.ts";
import { PreflightError, type PreflightResult } from "./schedule.ts";
import { createSnapshot, type SnapshotManifest } from "./snapshot.ts";
import { evalGoFixture, evalToolchainDir, evalWritableRoots, recordToolchainRefusal } from "./toolchain.ts";
import { prepareGoToolchain, removeGoToolchain, type PreparedToolchain, type SessionToolchain, type ToolchainReport } from "../toolchain/go.ts";

/**
 * The Jarvis arm of `jarvis eval` (decisions 35, 47; architecture §3.10): each golden task runs through
 * Jarvis on a fresh sanitized snapshot made exactly as the baseline makes it, with the same live
 * preflight, settings, sandbox and network allowlist (decisions 59, 70, 79), and its results land in the
 * same per-run folder layout (~/.jarvis/evals/<task>/<run>/), so the two arms compare run for run.
 *
 * Bug and refactor tasks (golden tasks 4 and 5) go triage → singleTaskPlan → the build loop. An onboarding
 * request that also asks for edits (golden task 7) runs the onboarding step as one session, then the loop runs
 * the cleanup plan it wrote, as `jarvis run --plan onboard` would (decision 148). Feature and
 * new-product tasks (task 2) take the evals repo's written spec as the approved spec, run one planner
 * session, and read its plan against the runner's copy of that spec and the installed checks (decision
 * 91); a refused plan gets one corrective planner session with the refusal (decision 113). The loop's protected checks are the project's own suite from hidden/<task>/gate/ (decision 97),
 * installed in a runner-owned folder no session can read. The grading checks (hidden/<task>/checks/) never
 * enter the loop, its ledger or any prompt: they run only after the run ends, in their own folder, on
 * the final revision, exactly as for the baseline. Code reviews stay Claude-only; design uses the confined
 * Codex design service and its verified negative control (decisions 124, 156).
 */

// ---- The loop's interface (runner/loop.ts, integrated on another branch) ---------------------------
// A structural copy of the API in tests/integration/e2e.test.ts. The loop is injected, so this arm does
// not depend on loop.ts landing first; once it lands, these types can be imported from it instead.

export interface RunLoopOptions {
  projectId: string;
  /** ~/.jarvis/projects/<id>-shaped: ledger, checks, checks.lock, evidence. Here <results>/project. */
  projectDir: string;
  jarvisHome: string;
  /** The snapshot repo; promotion merges into runBranch and tags last-green. */
  repoPath: string;
  runBranch: string;
  worktreeRoot: string;
  workRoot: string;
  harness: Harness;
  checks: Readonly<Record<string, GateCheck>>;
  review: LoopReview;
  taskTimeoutMs?: number;
  maxTurns?: number;
  maxConcurrent?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  usageMarginMs?: number;
  tier?: TaskTier;
  reprobe?: () => Promise<boolean>;
  notify?: (n: UsageWaitNotice) => Promise<void>;
  gitHome?: string;
  /** The only task ids the run may touch (runner/loop.ts; decision 126: a review run touches only its own tasks). */
  only?: readonly string[];
}
export interface RunLoopResult { status: "complete" | "blocked"; done: string[]; blocked: string[]; leftAlone?: string[] }
export type RunLoop = (opts: RunLoopOptions) => Promise<RunLoopResult>;
/**
 * The loop's review function (runner/loop.ts's ReviewVerdict): a plain verdict, which the loop records,
 * or one the review service already recorded, whose "error" means no verdict (an infrastructure failure).
 */
export type LoopReview = (input: ReviewRequest & { reviewer?: string }) => Promise<"pass" | "fail" | { status: "pass" | "fail" | "investigate" | "error" | "usage-limited"; recorded: true }>;

// ---- Options and results ----------------------------------------------------------------------------

export const JARVIS_VARIANT = "jarvis";
/**
 * "review-failed": a review that asked for fixes left no usable report or findings, so no fix started (decision 126).
 * "onboard-failed": the onboarding step left no usable report or cleanup plan, so no cleanup started (decision 148).
 */
export type JarvisOutcome = "complete" | "blocked" | "crashed" | "plan-failed" | "review-failed" | "onboard-failed" | "usage-limited";
export type Pipeline = "single-task" | "spec" | "review-fix" | "onboard";

/** An onboarding run (decision 148): the report the step wrote, the runner's commit of it, and the cleanup tasks its plan named. */
export interface OnboardSummary { report: string; reportRevision: string | null; tasks: string[] }

/** A review-fix run (decision 126): the report, the review's counts, and what the runner's records say happened to each finding. */
export interface ReviewSummary {
  report: string;
  /** The runner's commit of the session's report on the run branch: the fixes' base revision. */
  reportRevision: string | null;
  findings: number;
  cleared: number;
  skipped: number;
  outcomes: FindingOutcome[];
  /** The report-update task passed: the report on the final revision says what happened. */
  updated: boolean;
}

/** Seams for the production Claude harness (tests point it at the fake claude). */
export type HarnessSeams = Partial<Pick<ClaudeHarnessOptions, "session" | "binaryRealpath" | "sessionTmpDir" | "home" | "parentEnv" | "cleanup">>;
/** Seams for the production Claude reviewer (tests point it at a fake reviewer process). */
export type ReviewerSeams = Partial<Pick<ClaudeReviewerOptions, "session" | "binaryRealpath" | "sessionTmpDir">>;

export interface JarvisEvalOptions {
  /** The same live preflight as the baseline (a live doctor); must pass before any session (decision 59). */
  preflight: () => Promise<PreflightResult>;
  /** The private jarvis-evals repo: tasks/<id>/ and hidden/<id>/. */
  evalsRepo: string;
  runLoop: RunLoop;
  /** Default: the production Claude harness, with the live preflight before every session. */
  harness?: Harness;
  harnessSeams?: HarnessSeams;
  reviewerSeams?: ReviewerSeams;
  /** Test seam for design composition; production uses the confined, pinned Codex adapter. */
  createDesignReview?: (options: DesignReviewServiceOptions) => Pick<DesignReviewService, "reviewDetailed">;
  /** Default: Claude code review plus calibrated Codex design review when the run branch has DESIGN.md. */
  review?: LoopReview;
  /** Base design capture seam; production uses runGate on a fresh checkout before any session. */
  designGate?: (input: GateInput) => Promise<GateResult>;
  /** Grading seam; production is the protected-check gate. */
  gate?: (input: GateInput) => Promise<GateResult>;
  jarvisHome?: string;
  workRoot?: string;
  runId?: string;
  /** HOME for the runner's git calls and sessions. */
  home?: string;
  pluginDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

export interface TaskSummary { id: string; status: string; attempts: number; repairs: number; blockedReason: string | null }
export interface JarvisMetrics {
  tasks: TaskSummary[];
  repairs: number;
  /** planner: the sessions before the loop (the planner, or a review-fix task's review step). review: the loop's reviewer sessions. */
  sessions: { planner: number; build: number; review: number; total: number };
  usageWaits: { count: number; waitMs: number };
  usage: UsageTotals;
  problems: string[];
}

export interface JarvisRunResult {
  arm: "jarvis";
  task: string;
  runId: string;
  resultsDir: string;
  /** The snapshot repo: the loop's repoPath, kept for grading and review. */
  workspace: string;
  pipeline: Pipeline;
  triage: { type: Triage["type"]; tier: Triage["tier"] };
  outcome: JarvisOutcome;
  error?: string;
  loop: RunLoopResult | null;
  /** What Jarvis reported: the loop said every task is done. A false done is this with a failing grade. */
  claimedDone: boolean;
  /** The revision the planner and the first task started from (the snapshot, plus the spec for task 2, or the review's report for a review-fix task). */
  baseRevision: string;
  /** A review-fix task's review (decision 126); null for every other pipeline, or when the review step left nothing usable. */
  review: ReviewSummary | null;
  /** An onboarding task's report and cleanup tasks (decision 148); null for every other pipeline, or when the step left nothing usable. */
  onboard: OnboardSummary | null;
  lastGreen: string | null;
  /** last-green, or the base revision when nothing was accepted: what Jarvis delivered. */
  finalCommit: string;
  diffStat: string;
  durationMs: number;
  metrics: JarvisMetrics;
  /** Recorded design verdicts, including infrastructure errors, retained in summary.json. */
  designReviews: { revision: string; status: string; counts: boolean }[];
  /** A design task's base capture (decision 125): "failed" means no baseline, so every axe finding fails the gate. */
  designBaseline?: "recorded" | "failed";
  grade: Grade | null;
  gradeError?: string;
  snapshot: SnapshotManifest;
  /** The sessions' Go (decision 123): the gate's pinned toolchain, or why they had the host's. */
  toolchain: ToolchainReport;
  // What the scheduler reads (eval/schedule.ts's ScheduledRun).
  started: boolean;
  usageLimited: boolean;
  usageWaitUntil: number | undefined;
  exitCode: number | null;
  timedOut: boolean;
  resultSubtype: string | undefined;
  numTurns: number | undefined;
}

// ---- Helpers ----------------------------------------------------------------------------------------

/** Task 2's Jarvis run starts from task 01's defaults; the baseline-only "don't ask" line can be left out here. */
export function jarvisRequest(evalsRepo: string, task: GoldenTask): string {
  const p = join(evalsRepo, "tasks", task.id, "jarvis-prompt.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : task.prompt;
}

/**
 * `reviewFix`: the task's runner-owned opt-in to fix a review's findings (decision 126, round 3). A review's fixes
 * never come from its request's words, so a review without it has no build-loop arm.
 * `question`: triage's read of a question. An onboarding question whose `then` (the edits it also asks for, decision
 * 89) is a refactor or a bug runs the onboarding step and then its cleanup plan (decision 148); a feature `then`
 * goes to the research skill, which the eval arm doesn't run.
 */
export function pipelineFor(type: Triage["type"], reviewFix = false, question?: { onboarding: boolean; then: Triage["type"] | null }): Pipeline {
  if (type === "bug" || type === "refactor") return "single-task";
  if (type === "question" && question?.onboarding === true && (question.then === "refactor" || question.then === "bug")) return "onboard";
  if (type === "question" && question?.onboarding === true && question.then === "feature") throw new Error("triage says question (onboarding) with a feature after it: that goes to the research skill, so it has no Jarvis build-loop arm");
  if (type === "feature" || type === "new-product") return "spec";
  if (type === "review" && reviewFix === true) return "review-fix";
  throw new Error(`triage says ${type}: not a build-loop task, so it has no Jarvis build-loop arm${type === "review" ? " (a review's fixes need the task's runner-owned reviewFix opt-in in task.json, decision 126)" : ""}`);
}

const ReviewFixOptIn = z.union([z.literal(true), z.object({ limits: z.array(z.string().trim().min(1).max(300)).min(1).max(10) }).strict()]);
/**
 * The task's runner-owned opt-in (task.json `reviewFix`): `true`, or `{ "limits": [...] }` whose limits ride on every
 * fix task. Null when absent. Anything else refuses the task before the preflight.
 */
export function reviewFixOptIn(task: GoldenTask): { limits: string[] } | null {
  const raw = (task as GoldenTask & { reviewFix?: unknown }).reviewFix;
  if (raw === undefined) return null;
  const parsed = ReviewFixOptIn.safeParse(raw);
  if (!parsed.success) throw new Error(`${task.id}: task.json's reviewFix must be true or { "limits": ["…"] } (decision 126)`);
  return parsed.data === true ? { limits: [] } : { limits: [...parsed.data.limits] };
}

/** Spec criteria that no check covers. */
function coverageGaps(spec: Spec, checks: HiddenChecks): string[] {
  const covered = new Set(Object.values(checks.criteria).flat());
  return spec.criteria.map((c) => c.id).filter((id) => !covered.has(id));
}

/** The approved spec for a spec-pipeline task: tasks/<id>/spec.md, checked, and covered by the loop's checks. */
export function loadApprovedSpec(evalsRepo: string, taskId: string, loopChecks: HiddenChecks): { text: string; spec: Spec } {
  const p = join(evalsRepo, "tasks", taskId, "spec.md");
  if (!existsSync(p)) throw new Error(`${taskId}: a feature task needs its written spec at tasks/${taskId}/spec.md (task 01's defaults, in the spec format)`);
  const text = readFileSync(p, "utf8");
  const checked = checkSpec(text, "v1.md"); // committed as docs/spec/v1.md, so it must say spec: 1
  if (!checked.ok) throw new Error(`${taskId}: spec.md does not check: ${checked.problems.map((q) => `line ${q.line}: ${q.message}`).join("; ")}`);
  if (checked.spec.status === "draft") throw new Error(`${taskId}: spec.md is a draft; the approved spec must be confirmed or unconfirmed`);
  const missing = coverageGaps(checked.spec, loopChecks);
  if (missing.length) throw new Error(`${taskId}: no installed check covers ${missing.join(", ")}; a plan could never cover them (decision 91)`);
  return { text, spec: checked.spec };
}

const PLAN_TASK = "plan";
/** One planner session, plus one corrective session when its plan is refused (decision 113). */
const PLANNER_TRIES = 2;
/** How much of a refusal the corrective prompt quotes: a schema error can list one issue per task. */
const REFUSAL_CHARS = 4000;

/** The plan's exact shape. The values are placeholders; the keys are the only ones PlanSchema accepts (it is strict). */
const PLAN_SKELETON = JSON.stringify({
  notes: ["<optional: a constraint every build session should know, such as where new code goes or what not to add>"],
  tasks: [{
    id: "T1", title: "<short title>", goal: "<one clear goal>", exitCondition: "<a measurable condition>",
    acceptanceCriteria: ["AC1"], storyIds: ["S1"], dependencies: [], priority: 1,
    requiredChecks: ["<a check name from the list below>"], requiredReviews: ["code"],
  }],
}, null, 2);

export function plannerPrompt(input: { request: string; specPath: string; checks: HiddenChecks; maxTurns: number; design?: boolean }): string {
  const list = Object.keys(input.checks.checks).sort().map((n) => `- ${n}: ${input.checks.criteria[n]!.join(", ") || "no criteria (project tests)"}`);
  return [
    "Plan this approved feature for Jarvis's build loop. You write a plan only: no product code, no checks, no commits.",
    `The request, as typed: ${input.request}`,
    `The approved spec is ${input.specPath}. It is confirmed: do not edit it or ask questions.`,
    `Write .jarvis/plan.json as one JSON object in exactly this shape (the values are placeholders):\n\`\`\`json\n${PLAN_SKELETON}\n\`\`\``,
    `Only these keys are accepted: "tasks" and the optional "notes" at the top, and the ten keys shown in each task. The runner refuses a plan with any other key, at the top or in a task (a feature name, a summary, comments). Put anything else the build sessions should know in notes: at most ${PLAN_NOTES.count} strings of at most ${PLAN_NOTES.chars} characters each, ${PLAN_NOTES.total} in all. Every build session sees them as your claims, not as evidence.`,
    "Task ids are T1, T2, ...; acceptanceCriteria are AC ids and storyIds are S ids from the spec; dependencies are task ids; priority is a number (higher runs first); requiredChecks are names from the list below; requiredReviews is [\"code\"]. Use small tasks in dependency order with no cycles. Cover every acceptance criterion in the spec, and link each task's criteria to its stories.",
    `Installed protected checks (names, and the criteria each covers; the runner owns them and you cannot read them). A task listing an AC must require a check that covers it:\n${list.join("\n")}`,
    ...(input.design ? ["This is a design task: the runner also requires its six protected design checks and a design review on every task; the plan cannot remove them."] : []),
    `Stop after ${input.maxTurns} turns. The runner reads only .jarvis/plan.json.`,
  ].join("\n\n");
}

/** The one corrective session (decision 113): the refusal, what to rewrite, then the full planning prompt (sessions don't persist). */
export function plannerRetryPrompt(input: Parameters<typeof plannerPrompt>[0], refusal: string): string {
  const quoted = refusal.length > REFUSAL_CHARS ? `${refusal.slice(0, REFUSAL_CHARS)}\n… (cut: ${refusal.length} characters in all)` : refusal;
  return [
    "Correct the plan. A planning session for this feature already wrote .jarvis/plan.json in this workspace, and the runner refused it:",
    quoted,
    "Rewrite .jarvis/plan.json only: fix what the refusal names, keep the rest of the plan where it is valid, and change no other file. This is the only corrective attempt. The planning instructions follow.",
    plannerPrompt(input),
  ].join("\n\n");
}

const revisionOf = (repo: string, ref: string, home: string): string | null => {
  try { return safeGit(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], { home }).toString().trim(); } catch { return null; }
};

/** Run metrics from the ledger. The legacy planner count is ignored: only recorded process starts count. */
export function jarvisMetrics(entries: readonly LedgerEntry[], now: number, _plannerSessions = 0): JarvisMetrics {
  const problems: string[] = [];
  let tasks: TaskSummary[] = [];
  try {
    const state = rebuildState(entries, { now });
    tasks = Object.values(state.tasks).map((t) => ({ id: t.id, status: t.status, attempts: t.attemptCount, repairs: repairsUsed(t), blockedReason: t.blockedReason }));
  } catch (e) {
    problems.push(`ledger replay failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const runner = entries.filter((e) => e.actor === "runner");
  const plannerSessions = runner.filter((e) => e.kind === "reconciled" && (e.data as { type?: unknown }).type === "eval_session_started").length;
  const build = runner.filter((e) => e.kind === "attempt_started" && typeof (e.data as { processGroup?: unknown }).processGroup === "number").length;
  const review = runner.filter((e) => e.kind === "reconciled" && (e.data as { type?: unknown }).type === "review_process_started").length;
  const waits = runner.filter((e) => e.kind === "usage_wait");
  const waitMs = waits.reduce((n, e) => {
    const ms = (e.data as { waitMs?: unknown } | null)?.waitMs;
    return n + (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0);
  }, 0);
  return {
    tasks,
    repairs: tasks.reduce((n, t) => n + t.repairs, 0),
    sessions: { planner: plannerSessions, build, review, total: plannerSessions + build + review },
    usageWaits: { count: waits.length, waitMs },
    usage: summarizeUsage(entries, { runId: null }).total,
    problems,
  };
}

interface Paths { home: string; jarvisHome: string; resultsDir: string; workspace: string; worktreeRoot: string; reviewRoot: string; cacheRoot: string; projectDir: string }

/** The same folders as the baseline (decision 67), plus the loop's worktrees and review checkouts beside the snapshot. */
function paths(task: GoldenTask, runId: string, opts: JarvisEvalOptions): Paths {
  const home = opts.home ?? homedir();
  const jarvisHome = realpathSync(opts.jarvisHome ?? join(homedir(), ".jarvis"));
  const workRoot = opts.workRoot ?? join(homedir(), ".jarvis-work");
  const resultsDir = join(jarvisHome, "evals", task.id, runId);
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(workRoot, "evals", task.id), { recursive: true, mode: 0o700 });
  const evalDir = realpathSync(join(workRoot, "evals", task.id));
  // A private, empty toolchain cache root per run, deleted afterwards (Codex review 2, as for the baseline).
  const cacheRoot = join(workRoot, "cache-runs", task.id, runId);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const worktreeRoot = join(evalDir, `${runId}.wt`);
  const reviewRoot = join(evalDir, `${runId}.review`);
  for (const d of [worktreeRoot, reviewRoot]) mkdirSync(d, { mode: 0o700 });
  return { home, jarvisHome, resultsDir, workspace: join(evalDir, runId), worktreeRoot, reviewRoot, cacheRoot: realpathSync(cacheRoot), projectDir: join(resultsDir, "project") };
}

/** The repo's Jarvis plugin, which `jarvis run` also loads (commands/run-compose.ts). */
export const JARVIS_PLUGIN_DIR = fileURLToPath(new URL("../../../../plugin", import.meta.url));

/**
 * The production harness, as the runner builds it: the live preflight before every session (decision 59),
 * and the Jarvis plugin, as `jarvis run` loads it (decision 114: the arm measures what production runs).
 */
export function productionHarness(task: GoldenTask, p: Paths, routing: RoutingTable, opts: JarvisEvalOptions, toolchain?: SessionToolchain): Harness {
  const pluginDir = opts.pluginDir ?? JARVIS_PLUGIN_DIR;
  if (!existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) throw new Error(`the Jarvis arm needs the Jarvis plugin at ${pluginDir}`);
  return createClaudeHarness({
    jarvisHome: p.jarvisHome,
    cacheRoot: p.cacheRoot,
    worktreeRoot: p.worktreeRoot,
    allowedDomains: task.allowedDomains,
    routing,
    home: p.home,
    pluginDir,
    // Decision 123: the gate's pinned Go, as the baseline's session gets it.
    ...(toolchain ? { toolchain } : {}),
    preflight: async () => {
      const pre = await opts.preflight();
      return { ok: pre.ok, ...(pre.waitUntil !== undefined ? { usageWaitUntil: pre.waitUntil } : {}) };
    },
    ...(opts.harnessSeams ?? {}),
  });
}

/** What the reviewer gets (decisions 49, 88): the runner's spec or request and the task's criteria, never builder notes. */
export function reviewMaterial(ledger: Ledger, input: { repoPath: string; baseRevision: string; tier: TaskTier; specText: string | undefined; spec: Spec | undefined; request: string; kind?: "bug" }, taskId: string, attemptId: string): ReviewMaterial {
  const entries = ledger.entries();
  const start = entries.filter((e) => e.actor === "runner" && e.kind === "attempt_started" && e.task_id === taskId && e.attempt_id === attemptId).at(-1);
  const base = (start?.data as { baseRevision?: unknown } | undefined)?.baseRevision;
  const created = entries.find((e) => e.actor === "runner" && e.kind === "task_created" && e.task_id === taskId);
  const def = (created?.data ?? {}) as { acceptanceCriteria?: string[]; goal?: string; exitCondition?: string };
  const criteria = (def.acceptanceCriteria ?? []).flatMap((id) => {
    const c = input.spec?.criteria.find((x) => x.id === id);
    return c ? [`${c.id}: ${c.text}`] : [];
  });
  return {
    repoPath: input.repoPath,
    baseRevision: typeof base === "string" ? base : input.baseRevision,
    tier: input.tier,
    spec: input.specText ?? `Request, as typed: ${input.request}\nGoal: ${def.goal ?? input.request}\nExit condition: ${def.exitCondition ?? "-"}`,
    acceptanceCriteria: criteria.length ? criteria : def.exitCondition ? [def.exitCondition] : [],
    ...(input.kind ? { kind: input.kind } : {}),
  };
}

/**
 * The review service as the loop takes it: the service records its own review_result and the loop reads
 * that verdict back, so an infrastructure "error" stays an error, retried and never a code failure
 * (decisions 100, 111). Design uses the same branch material, protected definitions and shared
 * calibration as `jarvis run`; code remains Claude-only (decision 97).
 */
function productionReview(p: Paths, ledger: Ledger, material: (taskId: string, attemptId: string) => ReviewMaterial, opts: JarvisEvalOptions): LoopReview {
  const service = createReviewService({
    ledger,
    projectDir: p.projectDir,
    workRoot: p.reviewRoot,
    routing: DEFAULT_REVIEW_ROUTING,
    home: p.home,
    resolveMaterial: async (r) => material(r.taskId, r.attemptId),
    // The Claude reviewer runs under the task-session settings: reads outside its checkout are blocked and the
    // runner-owned folder is denied. Decision 97 stays in force for code reviews.
    claude: createClaudeReviewer({ jarvisHome: p.jarvisHome, workRoot: p.reviewRoot, cacheRoot: p.cacheRoot, home: p.home, preflight: async () => { const pre = await opts.preflight(); return { ok: pre.ok, ...(pre.waitUntil !== undefined ? { usageWaitUntil: pre.waitUntil } : {}) }; }, ...(opts.reviewerSeams ?? {}) }),
    codex: null,
  });
  const git = (args: readonly string[]) => safeGit(p.workspace, args, { home: p.home }).toString();
  const design = designOnBranch(git, "main") ? (opts.createDesignReview ?? createDesignReviewService)({
    ledger, projectDir: p.projectDir, workRoot: p.reviewRoot, home: p.home, jarvisHome: p.jarvisHome,
    resolveMaterial: async () => {
      const snapshot = approvedDesign(git, "main");
      if (!snapshot) throw new Error("approved DESIGN.md is missing from the run branch");
      return designMaterialFor({ repoPath: p.workspace, snapshot, store: new ChecksStore(p.projectDir), ledger });
    },
  }) : undefined;
  return async input => {
    const request = { taskId: input.taskId, attemptId: input.attemptId, revision: input.revision };
    if (input.reviewer === "design" && design) return { status: (await design.reviewDetailed(request)).verdict, recorded: true };
    if (input.reviewer !== undefined && input.reviewer !== "code") return { status: "error", recorded: true };
    return { status: (await service.reviewDetailed(request)).verdict, recorded: true };
  };
}

const LintScope = z.object({
  designSource: z.enum(["existing", "new"]).default("new"),
  axeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z.array(z.string().refine(designLintPath, "invalid design lint path")).min(1).max(256),
  tokenFiles: z.array(z.string().refine(designLintPath, "invalid token file path")).max(256),
}).strict();

type DesignLintScope = z.infer<typeof LintScope>;
/**
 * A golden task is a design task when the evals repo gives it a lint scope, tasks/<id>/design-lint.json
 * (decision 162). Read before the preflight, like everything else from the evals repo.
 */
function designScopeOf(evalsRepo: string, task: GoldenTask): DesignLintScope | undefined {
  const taskDir = join(evalsRepo, "tasks", task.id);
  if (!existsSync(join(taskDir, "design-lint.json"))) return undefined;
  return LintScope.parse(JSON.parse(readPlanningFile(realpathSync(taskDir), "design-lint.json")));
}

/** Explicit eval-owned scope: inherited design tokens are definitions, not candidate raw-color violations. */
function installEvalDesignLint(task: GoldenTask, p: Paths, store: ChecksStore, ledger: Ledger, scope: DesignLintScope): void {
  const git = (args: readonly string[]) => safeGit(p.workspace, args, { home: p.home }).toString();
  const files = scope.files.filter(file => !scope.tokenFiles.includes(file));
  const design = git(["show", "refs/heads/main:DESIGN.md"]);
  installDesignLintChecks(store, { nodeBin: process.execPath, axeVersion: scope.axeVersion, designSource: scope.designSource, files, design });
  store.approve(ledger, `golden task ${task.id}: protected design lint from the eval-owned scope and committed design reference`);
}

/** The runner's axe record of the base revision (decision 125), reserved in the store (decision 162). */
const AXE_BASELINE = "expected/axe-base.json";
/** Whether a store holds that file in any letter case (APFS folds case), found by listing two folders, not hashing a gate. */
function shipsAxeBaseline(checksDir: string): boolean {
  const named = (dir: string, name: string) => readdirSync(dir).filter((entry) => entry.toLowerCase() === name).map((entry) => join(dir, entry));
  return named(checksDir, "expected").some((dir) => lstatSync(dir).isDirectory() && named(dir, "axe-base.json").length > 0);
}
const DESIGN_CHECKS = ["impeccable-source", "impeccable-url", "design-browser", "ai-tells", "token-lint", "design-md-lint"];
/** A design task cannot silently become code-only because the planner omitted the design gates. */
function requireDesignEvidence(plan: Plan, required: boolean): Plan {
  if (!required) return plan;
  return { ...plan, tasks: plan.tasks.map(task => ({ ...task,
    requiredChecks: [...new Set([...task.requiredChecks, ...DESIGN_CHECKS])],
    requiredReviews: [...new Set([...task.requiredReviews, "design"])],
  })) };
}

const ms = (minutes: number) => minutes * 60_000;

// ---- The run ----------------------------------------------------------------------------------------

export async function runJarvis(task: GoldenTask, opts: JarvisEvalOptions): Promise<JarvisRunResult> {
  checkEvalDomains(task.id, task.allowedDomains);
  // Everything read from the evals repo is checked before the preflight, so a bad task file costs no usage.
  const request = jarvisRequest(opts.evalsRepo, task);
  const t = triage({ request, folder: { empty: task.source === undefined, designMd: false } });
  const optIn = reviewFixOptIn(task);
  const pipeline = pipelineFor(t.type, optIn !== null, { onboarding: t.onboarding, then: t.then?.type ?? null });
  // The report the request names, else the default; the fixes and their limits come only from the task's opt-in.
  const reportPath = pipeline === "review-fix" ? t.review?.report ?? DEFAULT_REVIEW_REPORT : pipeline === "onboard" ? typedReport(request) ?? DEFAULT_ONBOARD_REPORT : null;
  const grading = loadHiddenChecks(hiddenDir(opts.evalsRepo, task.id, "checks"));
  const gateDir = hiddenDir(opts.evalsRepo, task.id, "gate");
  // Decision 97: the loop gates on the project's own suite; the hidden checks only grade, after the loop.
  if (!existsSync(gateDir)) throw new Error(`${task.id}: the Jarvis arm needs hidden/${task.id}/gate/ (the project's own suite, for the loop); hidden/${task.id}/checks/ only grades (decision 97)`);
  const loopChecks = loadHiddenChecks(gateDir);
  assertHiddenDisjoint(loopChecks, grading);
  const approved = pipeline === "spec" ? loadApprovedSpec(opts.evalsRepo, task.id, loopChecks) : undefined;
  if (pipeline === "single-task" && !loopChecks.checks.unit) throw new Error(`${task.id}: a ${t.type} task needs a gate check named "unit" (singleTaskPlan's required check)`);
  if (pipeline === "review-fix" && !loopChecks.checks.unit) throw new Error(`${task.id}: a review that asks for fixes needs a gate check named "unit" (its fix tasks' required check)`);
  if (pipeline === "onboard" && !loopChecks.checks.unit) throw new Error(`${task.id}: an onboarding cleanup needs a gate check named "unit" (the onboard skill's required check)`);
  const goFixture = evalGoFixture(opts.evalsRepo, task.id);
  const designScope = designScopeOf(opts.evalsRepo, task);
  const designRequired = designScope !== undefined;
  const designPlan = readEvalDesignPlan(opts.evalsRepo, task.id);
  // Design checks without the declaration that makes a design task would be installed for nothing and judged by nobody.
  if (designPlan && !designRequired) throw new Error(`${task.id}: tasks/${task.id}/design-checks.json needs tasks/${task.id}/design-lint.json, which declares a design task (decision 162)`);

  const pre = await opts.preflight();
  if (!pre.ok) throw new PreflightError("preflight failed (run `jarvis doctor --live`); no session was started", pre.waitUntil);
  const started = Date.now();
  const runId = opts.runId ?? `jarvis-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const p = paths(task, runId, opts);
  const log = opts.log ?? (() => {});

  const snapshot = await createSnapshot({
    dest: p.workspace,
    ...(task.source ? { sourceRepo: task.source.repo, rev: task.source.rev, revert: task.source.revert ?? [], allowSecretsIn: task.source.allowSecretsIn ?? [] } : {}),
  });
  writeFileSync(join(p.workspace, ".git", "info", "exclude"), `${EXCLUDE.join("\n")}\n`);
  assertHiddenAbsent(p.workspace, [grading.dir, loopChecks.dir]);

  let baseRevision = snapshot.commit;
  const specPath = "docs/spec/v1.md";
  if (approved) {
    // Intake's output for task 2: the approved spec, committed where the build skill reads it.
    if (existsSync(join(p.workspace, specPath))) throw new Error(`${task.id}: the snapshot already has ${specPath}`);
    mkdirSync(join(p.workspace, "docs", "spec"), { recursive: true });
    writeFileSync(join(p.workspace, specPath), approved.text);
    safeGit(p.workspace, ["add", "--", specPath], { home: p.home });
    safeGit(p.workspace, ["commit", "-q", "--no-verify", "-m", "approved spec (eval: the evals repo's written spec)"], { home: p.home, env: { GIT_AUTHOR_DATE: "2026-01-01T00:00:01Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:01Z" } });
    baseRevision = safeGit(p.workspace, ["rev-parse", "HEAD"], { home: p.home }).toString().trim();
  }

  const ledger = Ledger.open(p.projectDir);
  const gateStore = installHiddenChecks(p.projectDir, ledger, loopChecks, `golden task ${task.id}: the gate checks from the evals repo`);
  // Recheck the installed project suite, whole, before adding runner-pinned runtimes (the evals repo may have changed
  // since the first check): no project check or expectation may come from the grading suite.
  assertHiddenDisjoint(loadHiddenChecks(gateStore.checksDir), grading);
  // Only the runner's own base capture makes an axe baseline (decision 125); the evals repo can't ship one.
  if (shipsAxeBaseline(gateStore.checksDir)) throw new Error(`${task.id}: hidden/${task.id}/gate/ holds ${AXE_BASELINE}, the runner's axe baseline; only the runner's base capture writes it (decision 125)`);
  // The loop runs what was installed and locked, never the copy parsed before the preflight (the evals repo may
  // have changed since): re-parse the installed copy and re-check what the plan needs against it.
  if (designScope) {
    // A design task is judged against its committed reference (decision 162): without one it would finish on code review alone.
    if (!designOnBranch(args => safeGit(p.workspace, args, { home: p.home }).toString(), "main")) throw new Error(`${task.id}: a design task (tasks/${task.id}/design-lint.json) needs a committed DESIGN.md on the snapshot's main; there is none, so no design review could run (decision 162)`);
    installEvalDesignLint(task, p, gateStore, ledger, designScope);
    if (designPlan) {
      installEvalDesignChecks(gateStore, designPlan, designScope.axeVersion);
      gateStore.approve(ledger, `golden task ${task.id}: per-run protected design checks and pinned QA toolchain`);
    }
  }
  const gate = loadHiddenChecks(gateStore.checksDir);
  // Again after the protected installs: both arms may load the same pinned browser libraries, so only the runner's
  // runtime roots are left out; every definition, plan and expectation the installers wrote is checked (decision 167).
  assertHiddenDisjoint(gate, grading, checkRuntimePath);
  const missingDesign = designRequired ? DESIGN_CHECKS.filter((name) => !Object.hasOwn(gate.checks, name)) : [];
  // Every task would block at dispatch after the planner had spent its session: refuse before any session instead.
  if (missingDesign.length) throw new Error(`${task.id}: a design task needs the protected design checks installed; missing ${missingDesign.join(", ")} (decision 162)`);
  if (pipeline === "single-task" && !gate.checks.unit) throw new Error(`${task.id}: the installed gate checks have no "unit" check`);
  if (pipeline === "review-fix" && !gate.checks.unit) throw new Error(`${task.id}: the installed gate checks have no "unit" check`);
  if (pipeline === "onboard" && !gate.checks.unit) throw new Error(`${task.id}: the installed gate checks have no "unit" check`);
  if (approved && coverageGaps(approved.spec, gate).length) throw new Error(`${task.id}: the installed gate checks no longer cover ${coverageGaps(approved.spec, gate).join(", ")}`);
  // Last before any session, after every cheap refusal: the base revision is built, served and captured in the gate's
  // sandbox. A failed capture leaves no baseline, so axe stays strict (decision 125), and the summary says so.
  let designBaseline: JarvisRunResult["designBaseline"];
  if (designPlan && designScope) designBaseline = await captureDesignBaseline({
    ledger, store: gateStore, projectDir: p.projectDir, jarvisHome: p.jarvisHome,
    workRoot: realpathSync(opts.workRoot ?? join(homedir(), ".jarvis-work")), repoPath: p.workspace,
    revision: baseRevision, check: gate.checks["design-browser"]!, taskId: "design-base", attemptId: "base",
  }, designScope.axeVersion, opts.designGate) ? "recorded" : "failed";
  const routing = loadRouting(p.workspace); // once, before any session, on the runner's copy
  // Decision 123: the gate's pinned Go for every session, offline and read-only, as the baseline's session gets it.
  let go: PreparedToolchain | undefined;
  try {
    go = prepareGoToolchain({ workspace: p.workspace, fixture: goFixture, dest: evalToolchainDir(opts.workRoot ?? join(homedir(), ".jarvis-work"), task.id, runId) });
    // Never where any run's sessions write: the harness checks only this run's worktrees and caches.
    checkSessionToolchain(go.toolchain, [...evalWritableRoots(opts.workRoot ?? join(homedir(), ".jarvis-work")), p.jarvisHome]);
  } catch (e) {
    // Fail closed: a present but refused toolchain stops the run before any session, and summary.json says why.
    if (go?.dir) removeGoToolchain(go.dir);
    rmSync(p.cacheRoot, { recursive: true, force: true });
    recordToolchainRefusal(p.resultsDir, { arm: "jarvis", task: task.id, runId, resultsDir: p.resultsDir, workspace: p.workspace, pipeline, outcome: "crashed", snapshot }, e);
  }
  if (go.report.status === "unavailable") log(`${task.id} ${runId}: go toolchain unavailable: ${go.report.reason}`);
  let harness: Harness;
  try { harness = opts.harness ?? productionHarness(task, p, routing, opts, go.toolchain); } catch (e) { if (go.dir) removeGoToolchain(go.dir); throw e; }
  // A question has no tier of its own; an onboarding run's sessions take its edits' tier (the `then` pipeline's).
  let tier: TaskTier = (pipeline === "onboard" ? t.then?.tier : t.tier) ?? 1;
  // A review-fix task's fix tasks are bug fixes reviewed against their finding (decisions 114, 126); its report update is not.
  const fixTasks = new Set<string>();
  const material = (taskId: string, attemptId: string) => reviewMaterial(ledger, { repoPath: p.workspace, baseRevision, tier, specText: approved?.text, spec: approved?.spec, request, ...(fixTasks.has(taskId) ? { kind: "bug" as const } : {}), ...(t.type === "bug" ? { kind: "bug" as const } : {}) }, taskId, attemptId);
  const review = opts.review ?? productionReview(p, ledger, material, opts);
  writeFileSync(join(p.resultsDir, "manifest.json"), `${JSON.stringify({
    task: task.id, title: task.title, variant: JARVIS_VARIANT, runId, request, triage: { type: t.type, tier: t.tier, decidedBy: t.decidedBy }, pipeline,
    ...(t.review ? { review: t.review } : {}),
    ...(pipeline === "onboard" ? { onboard: { report: reportPath, then: t.then?.type } } : {}),
    checks: Object.keys(gate.checks).sort(), gradingChecks: Object.keys(grading.checks).sort(),
    budget: { maxTurnsPerSession: task.maxTurns, timeoutMinutesPerSession: task.timeoutMinutes }, allowedDomains: task.allowedDomains,
    workspace: p.workspace, worktreeRoot: p.worktreeRoot, baseRevision, snapshot, toolchain: go.report, startedAt: new Date(started).toISOString(),
  }, null, 2)}\n`);

  let outcome: JarvisOutcome = "crashed";
  let error: string | undefined;
  let loop: RunLoopResult | null = null;
  let plannerSessions = 0;
  let usageWaitUntil: number | undefined;
  let reviewed: ReviewSummary | null = null;
  let onboarded: OnboardSummary | null = null;
  const problems: string[] = [];
  const loopOptions = (): RunLoopOptions => ({
    projectId: `eval-${task.id}`.slice(0, 64), projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.workspace, runBranch: "main",
    worktreeRoot: p.worktreeRoot, workRoot: realpathSync(opts.workRoot ?? join(homedir(), ".jarvis-work")), harness, checks: gate.checks, review,
    taskTimeoutMs: ms(task.timeoutMinutes), maxTurns: task.maxTurns, gitHome: p.home, tier,
    reprobe: async () => (await opts.preflight()).ok,
    notify: async (n) => log(`${task.id} ${runId}: usage wait for ${Math.round(n.waitMs / 60_000)} min (task ${n.taskId})`),
    ...(opts.now ? { now: opts.now } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  try {
    let plan: Plan | undefined;
    if (pipeline === "single-task") plan = singleTaskPlan(t, request, Object.keys(gate.checks).map((name) => ({ name })));
    else if (pipeline === "review-fix") {
      // Decision 126: the review session writes the report in its checkout; the runner commits it, then fixes each finding.
      // The ungated report commit may never replace a file the snapshot already has: checked before any session (round 2).
      const target = reportTargetProblem(reportPath!, inRevision(p.workspace, baseRevision, reportPath!, p.home));
      const step: ReviewStepResult = target ? { kind: "failed", reason: `${target}; no review session was started`, sessions: 0 }
        : await runReviewStep({ harness, ledger, routing, tier, runId, task, request, report: reportPath!, security: t.review?.security ?? false, p, baseRevision });
      plannerSessions = step.sessions;
      if (step.kind === "usage-limited") { outcome = "usage-limited"; usageWaitUntil = step.until ?? Math.floor(Date.now() / 1000) + 3600; }
      else if (step.kind === "failed") { outcome = "review-failed"; error = step.reason; log(`${task.id} ${runId}: ${step.reason}`); }
      else {
        problems.push(...step.problems);
        const output = { ...step.output, request }; // the runner's copy of the request, not the session's
        const committed = commitReport(p.workspace, output.report, output.reportText, p.home);
        if (committed) baseRevision = committed;
        reviewed = { report: output.report, reportRevision: committed ?? null, findings: output.findings.length + output.skipped.length, cleared: output.cleared.length, skipped: output.skipped.length, outcomes: [], updated: false };
        const fix = reviewFixPlan(output, Object.keys(gate.checks).map((name) => ({ name })), [], optIn?.limits ?? []);
        {
          for (const id of fix.taskIds) fixTasks.add(id);
          log(`${task.id} ${runId}: ${fix.taskIds.length} finding(s) to fix${fix.plan ? "; starting the build loop" : "; only the report update runs"}`);
          const result = await runReviewFixes({
            output, fix,
            // Each loop run may touch only this review's own task ids (decision 126).
            runFixes: async () => { for (const e of planEntries(requireDesignEvidence(fix.plan!, designRequired))) ledger.append(e); return opts.runLoop({ ...loopOptions(), only: [...fix.taskIds] }); },
            runUpdate: async (update) => { for (const e of planEntries(requireDesignEvidence({ tasks: [update] }, designRequired))) ledger.append(e); return opts.runLoop({ ...loopOptions(), only: [...fix.taskIds, update.id] }); },
            state: () => { try { return rebuildState(ledger.entries(), { now: Date.now() }); } catch { return { tasks: {} } as unknown as RunState; } },
            changedFiles: (revision) => safeGit(p.workspace, ["diff", "--name-only", "-z", `${revision}^1`, revision], { home: p.home }).toString().split("\0").filter(Boolean),
          });
          loop = result.update;
          reviewed = { ...reviewed, outcomes: result.outcomes, updated: result.updated };
          outcome = result.fixes.status === "complete" && result.updated ? "complete" : "blocked";
        }
      }
    } else if (pipeline === "onboard") {
      // Decision 148: the onboarding step maps the repo and writes the report and the cleanup plan; the runner commits
      // the report, then runs the plan as `jarvis run --plan onboard` would. The report never replaces a snapshot file.
      const target = reportTargetProblem(reportPath!, inRevision(p.workspace, baseRevision, reportPath!, p.home));
      const step: OnboardStepResult = target ? { kind: "failed", reason: `${target.replace("a review's report", "an onboarding report").replace(" (--report <path>)", "")}; no onboarding session was started, so no cleanup was started`, sessions: 0 }
        : await runOnboardStep({ harness, ledger, routing, tier, runId, task, request, report: reportPath!, checks: Object.keys(gate.checks), p, baseRevision });
      plannerSessions = step.sessions;
      if (step.kind === "usage-limited") { outcome = "usage-limited"; usageWaitUntil = step.until ?? Math.floor(Date.now() / 1000) + 3600; }
      else if (step.kind === "failed") { outcome = "onboard-failed"; error = step.reason; log(`${task.id} ${runId}: ${step.reason}`); }
      else {
        problems.push(...step.problems);
        const reportRevision = commitReport(p.workspace, step.output.report, step.output.reportText, p.home);
        if (reportRevision) baseRevision = reportRevision;
        onboarded = { report: step.output.report, reportRevision: reportRevision ?? null, tasks: step.output.plan.tasks.map((x) => x.id) };
        plan = step.output.plan;
      }
    } else {
      const r = await runPlanner({ harness, ledger, routing, tier, runId, task, request, specPath, checks: gate, spec: approved!.spec, p, baseRevision, log, design: designRequired });
      plannerSessions = r.sessions;
      if (r.kind === "plan") plan = r.plan;
      else if (r.kind === "usage-limited") { outcome = "usage-limited"; usageWaitUntil = r.until ?? Math.floor(Date.now() / 1000) + 3600; }
      else { outcome = "plan-failed"; error = r.reason; }
    }
    if (plan) {
      tier = plan.tier ?? tier;
      for (const e of planEntries(requireDesignEvidence(plan, designRequired))) ledger.append(e);
      log(`${task.id} ${runId}: ${plan.tasks.length} task(s) planned; starting the build loop`);
      loop = await opts.runLoop(loopOptions());
      outcome = loop.status === "complete" ? "complete" : "blocked";
    }
  } catch (e) {
    outcome = "crashed";
    error = e instanceof Error ? e.message : String(e);
    log(`${task.id} ${runId}: the run crashed: ${error}`);
  } finally {
    rmSync(p.cacheRoot, { recursive: true, force: true });
    if (go.dir) removeGoToolchain(go.dir);
  }

  const metrics = jarvisMetrics(ledger.entries(), Date.now(), plannerSessions);
  metrics.problems.push(...problems);
  const lastGreen = revisionOf(p.workspace, "refs/tags/last-green", p.home);
  const finalCommit = lastGreen ?? baseRevision;
  const diffStat = safeGit(p.workspace, ["diff", "--shortstat", baseRevision, finalCommit], { home: p.home }).toString().trim();
  let grade: Grade | null = null;
  let gradeError: string | undefined;
  if (outcome !== "usage-limited") {
    try {
      grade = await gradeRun({ runDir: p.resultsDir, repoPath: p.workspace, revision: finalCommit, hidden: grading, jarvisHome: p.jarvisHome, workRoot: realpathSync(opts.workRoot ?? join(homedir(), ".jarvis-work")), ...(opts.gate ? { gate: opts.gate } : {}) });
    } catch (e) {
      gradeError = e instanceof Error ? e.message : String(e);
    }
  }
  const sessionsStarted = metrics.sessions.total > 0 || metrics.usage.sessions > 0;
  const out: JarvisRunResult = {
    arm: "jarvis", task: task.id, runId, resultsDir: p.resultsDir, workspace: p.workspace, pipeline, triage: { type: t.type, tier: t.tier },
    outcome, ...(error !== undefined ? { error } : {}), loop,
    claimedDone: outcome === "complete", baseRevision, review: reviewed, onboard: onboarded, lastGreen, finalCommit, diffStat, durationMs: Date.now() - started, metrics, grade, ...(gradeError !== undefined ? { gradeError } : {}), snapshot, toolchain: go.report,
    designReviews: ledger.entries().filter(entry => entry.kind === "review_result" && (entry.data as {reviewer?:string}).reviewer === "design").map(entry => {
      const data=entry.data as {revision?:string;status?:string;verdict?:string;counts?:boolean};
      return {revision:data.revision??"",status:data.status??data.verdict??"error",counts:data.counts===true};
    }),
    ...(designBaseline !== undefined ? { designBaseline } : {}),
    started: sessionsStarted, usageLimited: outcome === "usage-limited", usageWaitUntil, exitCode: null, timedOut: false, resultSubtype: outcome,
    numTurns: metrics.usage.sessions ? metrics.usage.turns : undefined,
  };
  writeFileSync(join(p.resultsDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** Persist the process start even when capture or parsing fails before a session returns. */
function recordEvalStart(ledger: Ledger, runId: string, taskId: string, attemptId: string): void {
  ledger.append({ kind: "reconciled", actor: "runner", task_id: taskId, attempt_id: attemptId, data: { type: "eval_session_started", runId } });
}

/** `sessions` counts the planner processes that started. */
type PlannerResult =
  | { kind: "plan"; plan: Plan; sessions: number }
  | { kind: "usage-limited"; until: number | undefined; sessions: number }
  | { kind: "failed"; reason: string; sessions: number };

/**
 * The planner session (decision 91), with one corrective attempt (decision 113): when a session finishes but
 * the runner refuses its plan (not JSON, the schema, or coverage), one more session in the same workspace gets
 * the refusal and rewrites .jarvis/plan.json. A session that didn't finish (usage-limited, refused, timed out,
 * crashed) is never retried. Each session has its own header, log and usage record (plan-a1, plan-a2).
 */
async function runPlanner(i: { harness: Harness; ledger: Ledger; routing: RoutingTable; tier: TaskTier; runId: string; task: GoldenTask; request: string; specPath: string; checks: HiddenChecks; spec: Spec; p: Paths; baseRevision: string; log: (m: string) => void; design: boolean }): Promise<PlannerResult> {
  const ws = createWorkspace({ repoPath: i.p.workspace, projectId: "eval", taskId: PLAN_TASK, attemptId: "a1", baseRevision: i.baseRevision, worktreeRoot: i.p.worktreeRoot, home: i.p.home });
  try {
    const sessionsDir = join(i.p.projectDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const promptInput = { request: i.request, specPath: i.specPath, checks: i.checks, maxTurns: i.task.maxTurns, design: i.design };
    const context = { spec: i.spec, checks: Object.keys(i.checks.checks).map((name) => ({ name, criteria: i.checks.criteria[name]! })) };
    const refusals: string[] = [];
    let sessions = 0;
    for (let n = 1; n <= PLANNER_TRIES; n++) {
      const attemptId = `a${n}`;
      const label = n > 1 ? "corrective attempt: " : "";
      const header = join(sessionsDir, `plan-${attemptId}.header.md`);
      writeFileSync(header, `Jarvis eval run: ${i.runId}\nRole: planner (architect). Golden task ${i.task.id}.${n > 1 ? " Corrective attempt: the runner refused the previous plan." : ""}\nPlans are claims, not evidence.\n`, { mode: 0o600 });
      const prompt = refusals.length ? plannerRetryPrompt(promptInput, refusals.at(-1)!) : plannerPrompt(promptInput);
      const outcome: TaskOutcome = await i.harness.runTask({ workspace: ws.path, prompt, runHeaderPath: header, role: "architect", tier: i.tier, maxTurns: i.task.maxTurns, timeoutMs: ms(i.task.timeoutMinutes), logPath: join(sessionsDir, `plan-${attemptId}.jsonl`), onSpawn: () => { recordEvalStart(i.ledger, i.runId, PLAN_TASK, attemptId); sessions++; return true; } });
      if (sessions >= n) recordSessionUsage(i.ledger, { runId: i.runId, taskId: PLAN_TASK, attemptId, role: "architect", tier: i.tier, route: routeTask("architect", i.tier, undefined, i.routing), outcome });
      if (outcome.status === "usage-limited") return { kind: "usage-limited", until: outcome.resetAt ?? outcome.usageWaitUntil, sessions };
      if (outcome.status !== "finished") return { kind: "failed", reason: [...refusals, `${label}planner session ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : "message" in outcome ? `: ${outcome.message}` : ""}`].join("; "), sessions };
      try {
        return { kind: "plan", plan: readPlan(ws.path, context), sessions };
      } catch (e) {
        refusals.push(`${label}invalid plan: ${e instanceof Error ? e.message : String(e)}`);
        if (n < PLANNER_TRIES) i.log(`${i.task.id} ${i.runId}: the runner refused the plan; one corrective planner session`);
      }
    }
    return { kind: "failed", reason: refusals.join("; "), sessions };
  } finally {
    rmSync(ws.path, { recursive: true, force: true });
  }
}

// ---- A review that asks for fixes (decision 126) ------------------------------------------------------

const REVIEW_TASK = "review";

type ReviewStepResult =
  | { kind: "review"; output: ReviewOutput; sessions: number; problems: string[] }
  | { kind: "usage-limited"; until: number | undefined; sessions: number }
  | { kind: "failed"; reason: string; sessions: number };

/**
 * The review step (decision 126): one session, as the reviewer, in a fresh checkout of the base revision,
 * with the review (and security) skills as text and the runner's static evidence. It writes the report and
 * the findings file; the runner reads both after it ends and keeps nothing else it changed. A session that
 * didn't finish, or left no usable report, starts no fixes. Never retried.
 */
async function runReviewStep(i: { harness: Harness; ledger: Ledger; routing: RoutingTable; tier: TaskTier; runId: string; task: GoldenTask; request: string; report: string; security: boolean; p: Paths; baseRevision: string }): Promise<ReviewStepResult> {
  const ws = createWorkspace({ repoPath: i.p.workspace, projectId: "eval", taskId: REVIEW_TASK, attemptId: "a1", baseRevision: i.baseRevision, worktreeRoot: i.p.worktreeRoot, home: i.p.home });
  try {
    const sessionsDir = join(i.p.projectDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    // The evidence comes from the runner-made checkout, before the session can change a byte of it.
    const evidence = reviewStepEvidence(ws.path, i.security);
    const header = join(sessionsDir, "review-a1.header.md");
    writeFileSync(header, reviewStepHeader({ runId: i.runId, label: `Golden task ${i.task.id}.`, skills: loadSkills(reviewStepSkills(i.security)) }), { mode: 0o600 });
    const prompt = reviewStepPrompt({ request: i.request, report: i.report, maxTurns: i.task.maxTurns, security: i.security, evidence });
    let sessions = 0;
    const outcome: TaskOutcome = await i.harness.runTask({ workspace: ws.path, prompt, runHeaderPath: header, role: "review", tier: i.tier, maxTurns: i.task.maxTurns, timeoutMs: ms(i.task.timeoutMinutes), logPath: join(sessionsDir, "review-a1.jsonl"), onSpawn: () => { recordEvalStart(i.ledger, i.runId, REVIEW_TASK, "a1"); sessions++; return true; } });
    if (sessions) recordSessionUsage(i.ledger, { runId: i.runId, taskId: REVIEW_TASK, attemptId: "a1", role: "review", tier: i.tier, route: routeTask("review", i.tier, undefined, i.routing), outcome });
    if (outcome.status === "usage-limited") return { kind: "usage-limited", until: outcome.resetAt ?? outcome.usageWaitUntil, sessions };
    if (outcome.status !== "finished") return { kind: "failed", reason: `review session ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : "message" in outcome ? `: ${outcome.message}` : ""}; no fixes were started`, sessions };
    try {
      const output = readReviewOutput(ws.path, i.report, { inCheckout: (file) => inRevision(i.p.workspace, i.baseRevision, file, i.p.home) });
      return { kind: "review", output, sessions, problems: strayEdits(ws.path, i.report, i.p.home) };
    } catch (e) {
      return { kind: "failed", reason: `${e instanceof Error ? e.message : String(e)}; no fixes were started`, sessions };
    }
  } finally {
    rmSync(ws.path, { force: true, recursive: true }); // the review checkout: only the report leaves it, through the runner
  }
}

/** True when `file` exists in `revision` (the review's base): a finding about a file that isn't there gets no fix task. */
function inRevision(repo: string, revision: string, file: string, home: string): boolean {
  try { safeGit(repo, ["cat-file", "-e", `${revision}:${file}`], { home }); return true; } catch { return false; }
}

/** What a review or onboarding session changed besides its report and runner metadata: discarded with its checkout, and said so. */
function strayEdits(workspace: string, report: string, home: string, step: "review" | "onboarding" = "review"): string[] {
  const raw = safeGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { home }).toString();
  const changed = raw.split("\0").filter(Boolean).map((row) => row.slice(3)).filter((path) => path !== report && !path.startsWith(".jarvis/"));
  if (!changed.length) return [];
  const shown = changed.length > 10 ? `${changed.slice(0, 10).join(", ")} and ${changed.length - 10} more` : changed.join(", ");
  return [`the ${step} session also changed ${shown}; discarded (the ${step} step writes only its report${step === "onboarding" ? " and its plan" : ""})`];
}

/**
 * The session's report, committed by the runner on the run branch of the runner-made snapshot: the
 * deliverable as the session wrote it, and the base every fix starts from. Undefined when the snapshot
 * already had exactly that report.
 */
function commitReport(repo: string, report: string, text: string, home: string): string | undefined {
  writeReportFile(repo, report, text);
  return commitReportOnly((args) => safeGit(repo, args, { home }).toString().trim(), report, `review report ${report} (written by the review session)`);
}


// ---- An onboarding request that also asks for edits (decision 148) ---------------------------------------

const ONBOARD_TASK = "onboard";

type OnboardStepResult =
  | { kind: "onboard"; output: OnboardOutput; sessions: number; problems: string[] }
  | { kind: "usage-limited"; until: number | undefined; sessions: number }
  | { kind: "failed"; reason: string; sessions: number };

/**
 * The onboarding step (decision 148): one session, as the architect, in a fresh checkout of the base revision,
 * with the onboard skill as text. It writes the report and the cleanup plan; the runner reads both after it ends,
 * the plan against the installed gate checks, and keeps nothing else it changed. A session that didn't finish,
 * or left no usable report or plan, starts no cleanup. Never retried.
 */
async function runOnboardStep(i: { harness: Harness; ledger: Ledger; routing: RoutingTable; tier: TaskTier; runId: string; task: GoldenTask; request: string; report: string; checks: readonly string[]; p: Paths; baseRevision: string }): Promise<OnboardStepResult> {
  const ws = createWorkspace({ repoPath: i.p.workspace, projectId: "eval", taskId: ONBOARD_TASK, attemptId: "a1", baseRevision: i.baseRevision, worktreeRoot: i.p.worktreeRoot, home: i.p.home });
  try {
    const sessionsDir = join(i.p.projectDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const header = join(sessionsDir, "onboard-a1.header.md");
    writeFileSync(header, onboardStepHeader({ runId: i.runId, label: `Golden task ${i.task.id}.`, skills: loadSkills(["onboard"]) }), { mode: 0o600 });
    const prompt = onboardStepPrompt({ request: i.request, report: i.report, checks: i.checks, maxTurns: i.task.maxTurns });
    // Decision 160: a session counts when the runner records its process start, not from its outcome.
    let sessions = 0;
    const outcome: TaskOutcome = await i.harness.runTask({ workspace: ws.path, prompt, runHeaderPath: header, role: "architect", tier: i.tier, maxTurns: i.task.maxTurns, timeoutMs: ms(i.task.timeoutMinutes), logPath: join(sessionsDir, "onboard-a1.jsonl"), onSpawn: () => { recordEvalStart(i.ledger, i.runId, ONBOARD_TASK, "a1"); sessions++; return true; } });
    if (sessions) recordSessionUsage(i.ledger, { runId: i.runId, taskId: ONBOARD_TASK, attemptId: "a1", role: "architect", tier: i.tier, route: routeTask("architect", i.tier, undefined, i.routing), outcome });
    if (outcome.status === "usage-limited") return { kind: "usage-limited", until: outcome.resetAt ?? outcome.usageWaitUntil, sessions };
    if (outcome.status !== "finished") return { kind: "failed", reason: `onboarding session ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : "message" in outcome ? `: ${outcome.message}` : ""}; no cleanup was started`, sessions };
    try {
      const output = readOnboardOutput(ws.path, i.report, i.checks.map((name) => ({ name })));
      return { kind: "onboard", output, sessions, problems: strayEdits(ws.path, i.report, i.p.home, "onboarding") };
    } catch (e) {
      return { kind: "failed", reason: `${e instanceof Error ? e.message : String(e)}; no cleanup was started`, sessions };
    }
  } finally {
    rmSync(ws.path, { recursive: true, force: true, maxRetries: 2 }); // the onboarding checkout: only the report and the plan leave it, through the runner
  }
}
