import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runGate, verifyEvidence, type GateCheck, type GateInput, type GateResult } from "../checks/gate.ts";
import { ChecksStore } from "../checks/store.ts";
import { safeGit } from "../eval/git.ts";
import { atomicWrite, Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import type { EscalationReason, Harness, TaskInput, TaskOutcome } from "./harness.ts";
import { captureProcessGroup, cleanupLeftovers, readProcessStartTime, type ProcessStartTimeReader } from "./cleanup.ts";
import { buildFootprintEntry, createFootprintLog, type FootprintLog } from "./footprint.ts";
import { ingestSteerNotes, loadInboxCursor, readInbox, saveInboxCursor, type InboxAction } from "./inbox.ts";
import { buildRunHeader, buildTaskPrompt } from "./prompt.ts";
import { decideRepair } from "./repair.ts";
import { writeReport, type ReportClaim } from "./report.ts";
import { loadRouting, routeTask, type RoutingTable } from "./routing.ts";
import { buildLease, isDone, rebuildState, type EvidenceVerifier, type ProcessGroupRecord, type RunState, type TaskCreatedData, type TaskState } from "./state.ts";
import { activeUsageWait, waitForUsage, type UsageWaitNotice } from "./usage-wait.ts";
import { recordSessionUsage } from "./usage-log.ts";
import { commitCandidate, createWorkspace, deleteCandidateBranches, mergeCandidate, promoteCandidate, readTaskNotes, type CandidateRevision, type RunnerGit, type TaskWorkspace } from "./worktrees.ts";

/** The process adapter calls these synchronously at spawn, and only after the entire group exits. */
export interface LoopTaskInput extends TaskInput {
  onSpawn: (groupId: number) => boolean;
  onGroupExit: (groupId: number) => void;
}
export interface LoopHarness extends Harness {
  runTask(input: LoopTaskInput): Promise<TaskOutcome & { finalMessage?: string }>;
}
export interface LoopPlan { tasks: readonly (TaskCreatedData & { id: string })[] }
export interface ReviewInput {
  taskId: string;
  attemptId: string;
  revision: string;
  reviewer: string;
  acceptanceCriteria: readonly string[];
  /** Runner-authored, revision-bound gate records; builder notes are deliberately absent. */
  evidence: readonly LedgerEntry[];
}
/**
 * A review verdict. A plain string is recorded by the loop as a review_result; a recorded verdict was
 * already appended by the review service (review/service.ts). "investigate" blocks the task for a
 * person; "error" is an infrastructure failure: the review is retried once, never charged as a repair,
 * and if it errors again the task blocks with "review infrastructure error: <what the service recorded>".
 * A review function that can fail for infrastructure reasons must return the recorded form: a plain
 * "fail" is a verdict on the code and spends a repair.
 */
export type ReviewVerdict = "pass" | "fail" | { status: "pass" | "fail" | "investigate" | "error"; recorded: true };
export interface RunLoopOptions {
  projectId: string;
  projectDir: string;
  jarvisHome: string;
  repoPath: string;
  runBranch: string;
  worktreeRoot: string;
  workRoot: string;
  harness?: LoopHarness;
  createHarness?: (routing: RoutingTable) => LoopHarness;
  checks: Readonly<Record<string, GateCheck>>;
  review: (input: ReviewInput) => Promise<ReviewVerdict>;
  taskTimeoutMs?: number;
  maxTurns?: number;
  maxConcurrent?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  usageMarginMs?: number;
  reprobe?: () => Promise<boolean>;
  notify?: (notice: UsageWaitNotice) => Promise<void>;
  notifyBlocked?: (notice: { taskId: string; reason: string }) => Promise<void>;
  gitHome?: string;
  git?: RunnerGit;
  gate?: (input: GateInput) => Promise<GateResult>;
  verifyEvidence?: EvidenceVerifier;
  readProcessStartTime?: ProcessStartTimeReader;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  pidAlive?: (pid: number) => boolean;
  plan?: LoopPlan;
  recoverIntake?: (ledger: Ledger) => void | Promise<void>;
  /** Handlers must be idempotent by action seq; cursor acknowledgment follows durable effects. */
  applyInbox?: (action: InboxAction, ledger: Ledger) => void | Promise<void>;
  /** "passed" is after every gate and review passed, before promotion. */
  onCheckpoint?: (name: "spawned" | "candidate-committed" | "passed", taskId: string) => void;
  /** Disk and concurrency log for the report (runner/footprint.ts); false turns it off. */
  footprint?: FootprintLog | false;
}
export interface RunLoopResult { status: "complete" | "blocked"; done: string[]; blocked: string[] }

type Data = Record<string, unknown>;
const dataOf = (entry: LedgerEntry): Data => entry.data as Data;
const liveLoops = new Set<string>();
const short = (value: unknown) => String(value).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 240);
/** A review that errors (no verdict) gets one retry (decision 100). */
const REVIEW_TRIES = 2;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`invalid ${name}`);
  return value;
}

class Loop {
  readonly opts: RunLoopOptions;
  readonly ledger: Ledger;
  readonly runId = randomUUID();
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly verify: EvidenceVerifier;
  readonly pidAlive: (pid: number) => boolean;
  readonly timeout: number;
  readonly turns: number;
  readonly concurrency: number;
  readonly pidFile: string;
  harness!: LoopHarness;
  routing!: RoutingTable;
  readonly footprint: FootprintLog | undefined;
  readonly readStart: ProcessStartTimeReader;
  private promotion: Promise<void> = Promise.resolve();
  private fatal: unknown;
  private failed = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly groups = new Map<number, () => void>();

  constructor(opts: RunLoopOptions) {
    mkdirSync(opts.worktreeRoot, { recursive: true, mode: 0o700 });
    this.opts = { ...opts, worktreeRoot: realpathSync(opts.worktreeRoot) };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
    this.verify = opts.verifyEvidence ?? verifyEvidence;
    this.pidAlive = opts.pidAlive ?? alive;
    this.timeout = positive(opts.taskTimeoutMs ?? 30 * 60_000, "task timeout");
    this.turns = positive(opts.maxTurns ?? 100, "turn cap");
    this.concurrency = positive(opts.maxConcurrent ?? 2, "concurrency");
    this.ledger = Ledger.open(opts.projectDir);
    this.pidFile = join(opts.projectDir, "runner.pid");
    this.readStart = opts.readProcessStartTime ?? readProcessStartTime;
    this.footprint = opts.footprint === false ? undefined
      : opts.footprint ?? createFootprintLog({ worktrees: this.opts.worktreeRoot, caches: [], evidence: join(opts.projectDir, "evidence") }, { now: this.now });
  }

  private git(args: readonly string[]): string {
    return (this.opts.git ?? safeGit)(this.opts.repoPath, args, { home: this.opts.gitHome ?? homedir() }).toString().trim();
  }
  private state(): RunState {
    return rebuildState(this.ledger.entries(), { now: this.now(), verifyEvidence: this.verify });
  }
  private record(type: string, data: Data = {}, taskId?: string, attemptId?: string): LedgerEntry {
    return this.ledger.append({ kind: "reconciled", actor: "runner", ...(taskId ? { task_id: taskId } : {}), ...(attemptId ? { attempt_id: attemptId } : {}), data: { type, runId: this.runId, ...data } });
  }
  private records(type: string, taskId?: string, attemptId?: string): LedgerEntry[] {
    return this.ledger.entries().filter((e) => e.actor === "runner" && e.kind === "reconciled" && dataOf(e).type === type
      && (taskId === undefined || e.task_id === taskId) && (attemptId === undefined || e.attempt_id === attemptId));
  }

  acquire(): void {
    const key = resolve(this.opts.projectDir);
    if (liveLoops.has(key)) throw new Error("run lease already active");
    this.ledger.transact((entries, add) => {
      const unreleased = entries.filter((e) => e.actor === "runner" && e.kind === "reconciled" && dataOf(e).type === "run_lease_acquired"
        && !entries.some((r) => r.actor === "runner" && r.kind === "reconciled" && dataOf(r).type === "run_lease_released" && dataOf(r).runId === dataOf(e).runId));
      const runs = rebuildState(entries, { now: this.now(), verifyEvidence: this.verify }).runs;
      // A PID alone can be reused: a holder counts only if it is the same process (start time, as cleanup.ts does).
      const startedAt = (runId: unknown) => entries.find((e) => e.actor === "runner" && e.kind === "reconciled" && dataOf(e).type === "run_lease_acquired" && dataOf(e).runId === runId)?.data as Data | undefined;
      const holds = (pid: number, lease: Data | undefined) => this.pidAlive(pid) && (typeof lease?.startedAt !== "string" || this.startTime(pid) === lease.startedAt);
      if (unreleased.some((e) => holds(Number(dataOf(e).pid), dataOf(e))) || runs.some((r) => !r.ended && holds(r.pid, startedAt(r.runId)))) throw new Error("run lease held by an active runner");
      const own = this.startTime(process.pid);
      add({ kind: "reconciled", actor: "runner", data: { type: "run_lease_acquired", runId: this.runId, pid: process.pid, ...(own ? { startedAt: own } : {}) } });
    });
    liveLoops.add(key);
  }
  private startTime(pid: number): string | null {
    try { return this.readStart(pid)?.trim().replace(/\s+/g, " ") ?? null; } catch { return null; }
  }
  release(): void {
    try { this.record("run_lease_released"); } finally { liveLoops.delete(resolve(this.opts.projectDir)); }
  }

  async start(): Promise<void> {
    const state = this.state();
    const resumable = new Set(Object.values(state.tasks).filter((t) => t.attempts.at(-1)?.outcome === "usage_wait")
      .map((t) => this.workspaceRecord(t)?.path).filter((p) => p !== undefined));
    const cleanupState = { ...state, runs: state.runs.map((r) => ({ ...r, workspaces: r.workspaces.filter((p) => !resumable.has(p)) })) };
    this.record("cleanup_intent");
    const cleaned = cleanupLeftovers({ state: cleanupState, pidFile: this.pidFile, worktreeRoot: this.opts.worktreeRoot, now: this.now, pidAlive: this.pidAlive,
      ...(this.opts.kill ? { kill: this.opts.kill } : {}),
      ...(this.opts.readProcessStartTime ? { readProcessStartTime: this.opts.readProcessStartTime } : {}) });
    this.record("cleanup_result", { ...cleaned });
    if (cleaned.errors.length || cleaned.refused.length) throw new Error(`leftover cleanup refused: ${[...cleaned.errors, ...cleaned.refused].join("; ")}`);
    for (const runId of cleaned.deadRunIds) this.ledger.append({ kind: "run_ended", actor: "runner", data: { runId, status: "crashed" } });
    const routing = loadRouting(this.opts.repoPath);
    this.routing = routing;
    this.excludeReportFolder();
    const harness = this.opts.createHarness?.(routing) ?? this.opts.harness;
    if (!harness) throw new Error("a task harness is required");
    this.harness = harness;
    this.ledger.append({ kind: "run_started", actor: "runner", data: { runId: this.runId, pid: process.pid, routing } });
    atomicWrite(this.pidFile, `${process.pid}\n`);
    await this.opts.recoverIntake?.(this.ledger);
    this.seedPlan();
    await this.pauseUsage();
    await this.recoverCandidates();
  }
  /** REPORT.md lives in the main checkout's .jarvis/; untracked, it would make the next promotion refuse a dirty tree (Opus review M2). */
  private excludeReportFolder(): void {
    const path = resolve(this.opts.repoPath, this.git(["rev-parse", "--git-path", "info/exclude"]));
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === "/.jarvis/")) return;
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}/.jarvis/\n`);
  }
  private seedPlan(): void {
    if (!this.opts.plan) return;
    this.ledger.transact((entries, add) => {
      for (const { id, ...data } of this.opts.plan!.tasks) {
        if (!entries.some((e) => e.actor === "runner" && e.kind === "task_created" && e.task_id === id)) add({ kind: "task_created", actor: "runner", task_id: id, data });
      }
    });
  }
  private workspaceRecord(task: TaskState): TaskWorkspace | undefined {
    const entry = this.records("workspace_created", task.id, task.attemptId ?? "").at(-1);
    return entry ? dataOf(entry).workspace as TaskWorkspace : undefined;
  }

  private async inbox(): Promise<void> {
    ingestSteerNotes(this.opts.projectDir, this.ledger);
    const entries = this.ledger.entries();
    const batch = readInbox(entries, loadInboxCursor(this.opts.projectDir, entries), this.state());
    for (const action of batch.actions) {
      const seq = action.kind === "replan" ? action.seq : action.entry.seq;
      if (this.records("inbox_applied").some((e) => dataOf(e).sourceSeq === seq)) continue;
      this.record("inbox_intent", { sourceSeq: seq, action });
      await this.opts.applyInbox?.(action, this.ledger);
      this.record("inbox_applied", { sourceSeq: seq, action });
    }
    saveInboxCursor(this.opts.projectDir, batch.cursor, this.ledger.entries());
  }
  private async probeUsage(): Promise<boolean> {
    for (;;) {
      let until: number | undefined;
      while ((until = activeUsageWait(this.ledger.entries(), this.now())) !== undefined) await this.sleep(Math.min(60_000, until - this.now()));
      if (!this.opts.reprobe || !await this.opts.reprobe()) return false;
      const entries = this.ledger.entries();
      if (activeUsageWait(entries, this.now()) !== undefined) continue;
      const last = entries.filter((e) => e.kind === "usage_wait" && e.actor === "runner").at(-1);
      if (last) this.record("usage_probe_passed", { throughSeq: last.seq });
      return true;
    }
  }
  private async pauseUsage(): Promise<void> {
    const entries = this.ledger.entries();
    const acknowledged = Math.max(0, ...this.records("usage_probe_passed").map((e) => Number(dataOf(e).throughSeq)));
    const pending = entries.filter((e) => e.actor === "runner" && e.kind === "usage_wait" && e.seq > acknowledged);
    if (!pending.length && activeUsageWait(entries, this.now()) === undefined) return;
    if (!await this.probeUsage()) throw new Error("usage reset preflight probe failed; dispatch remains paused");
  }

  async schedule(): Promise<RunLoopResult> {
    for (;;) {
      await this.inbox();
      await this.pauseUsage();
      if (this.failed) break;
      const state = this.state();
      const ready = Object.values(state.tasks).filter((task) => !this.running.has(task.id) && !isDone(task, this.verify) && task.status !== "blocked"
        && !state.activeLeases.some((lease) => lease.taskId === task.id)
        && task.definition.dependencies.every((id) => state.tasks[id] !== undefined && isDone(state.tasks[id]!, this.verify)))
        .sort((a, b) => b.definition.priority - a.definition.priority);
      for (const task of ready.slice(0, this.concurrency - this.running.size)) {
        if (this.failed) break;
        const promise = this.dispatch(task).catch((e: unknown) => { this.fatal = e; this.stop(); }).finally(() => this.running.delete(task.id));
        this.running.set(task.id, promise);
      }
      if (this.running.size) { await Promise.race(this.running.values()); continue; }
      for (const task of Object.values(this.state().tasks)) {
        if (!isDone(task, this.verify) && task.status !== "blocked") await this.block(task, "dependencies unavailable or completion evidence changed");
      }
      break;
    }
    await Promise.all(this.running.values());
    if (this.failed) throw this.fatal;
    return this.finish();
  }

  stop(): void {
    this.failed = true;
    for (const shutdown of this.groups.values()) shutdown();
  }
  async settle(): Promise<void> {
    await Promise.all(this.running.values());
  }
  private signal(groupId: number, signal: NodeJS.Signals): void {
    try { (this.opts.kill ?? process.kill)(-groupId, signal); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") this.record("shutdown_error", { groupId, signal, message: short(e) }); }
  }

  private async block(task: TaskState, reason: string): Promise<void> {
    this.ledger.append({ kind: "blocked", actor: "runner", task_id: task.id, attempt_id: task.attemptId, data: { reason: short(reason) } });
    try { await this.opts.notifyBlocked?.({ taskId: task.id, reason: short(reason) }); } catch { /* Notification failure never prevents cleanup. */ }
  }
  private lease(taskId: string, attemptId: string, workspace: string): void {
    this.ledger.transact((entries, add) => {
      const state = rebuildState(entries, { now: this.now(), verifyEvidence: this.verify });
      if (state.activeLeases.some((l) => l.taskId === taskId)) throw new Error(`task lease already active: ${taskId}`);
      add(buildLease({ taskId, attemptId, runId: this.runId, holderPid: process.pid, ttlMs: this.timeout + 60_000, workspace }, this.now));
    });
  }
  private async dispatch(task: TaskState): Promise<void> {
    const missing = task.definition.requiredChecks.find((name) => !Object.hasOwn(this.opts.checks, name));
    if (missing) return this.block(task, `required check unavailable: ${missing}`);
    // Decide from the last attempt that finished: a repair that crashed keeps its prompt (Opus review L1).
    const view = this.repairView(task);
    const repair = decideRepair(view, { kind: "failure" }, { verifyEvidence: this.verify });
    if (repair.kind === "blocked") {
      this.ledger.append(repair.entry);
      if (repair.alternative) this.ledger.append(repair.alternative);
      try { await this.opts.notifyBlocked?.({ taskId: task.id, reason: String((repair.entry.data as Data).reason) }); } catch { /* Best effort. */ }
      return;
    }
    if (task.status === "passed") return this.block(task, "completion evidence changed");
    const resuming = task.attempts.at(-1)?.outcome === "usage_wait";
    const attemptId = resuming ? task.attemptId! : randomUUID();
    const path = resuming ? this.workspaceRecord(task)?.path : join(resolve(this.opts.worktreeRoot), this.opts.projectId, `${task.id}-${attemptId}`);
    if (!path) return this.block(task, "usage checkpoint workspace missing");
    this.lease(task.id, attemptId, path);
    const baseRevision = this.git(["rev-parse", "--verify", `refs/heads/${this.opts.runBranch}^{commit}`]);
    this.ledger.append({ kind: "attempt_started", actor: "runner", task_id: task.id, attempt_id: attemptId, data: { runId: this.runId, baseRevision, workspace: path } });
    let workspace: TaskWorkspace;
    try {
      workspace = resuming ? this.workspaceRecord(task)! : createWorkspace({ repoPath: this.opts.repoPath, projectId: this.opts.projectId, taskId: task.id, attemptId, baseRevision,
        worktreeRoot: this.opts.worktreeRoot, ...(this.opts.gitHome ? { home: this.opts.gitHome } : {}), ...(this.opts.git ? { git: this.opts.git } : {}) });
      if (!resuming) this.record("workspace_created", { workspace }, task.id, attemptId);
      if (!resuming) {
        mkdirSync(join(workspace.path, ".git/info"), { recursive: true });
        appendFileSync(join(workspace.path, ".git/info/exclude"), "\n/.jarvis/\n");
      }
    } catch (e) { return this.block(this.state().tasks[task.id]!, `workspace refused: ${short(e)}`); }
    const failure: EscalationReason | undefined = repair.kind !== "repair" ? undefined
      : view.evidence.some((e) => e.kind === "review_result" && dataOf(e).revision === view.candidateRevision && dataOf(e).status === "fail") ? "review_fail" : "gate_fail";
    const stale = !resuming && task.attemptId !== null && this.records("stale_base", task.id, task.attemptId).length > 0
      ? "The run branch moved while your previous attempt was being checked, and its changes conflict with work merged since. Redo the task on the current run branch; your workspace starts from it." : "";
    await this.attempt(task, workspace, [repair.kind === "repair" ? repair.prompt : "", stale].filter(Boolean).join("\n\n"), failure);
  }
  private repairView(task: TaskState): TaskState {
    const last = [...task.attempts].reverse().find((a) => a.outcome === "completed" && a.candidateRevision !== null);
    if (!last || last.id === task.attemptId) return task;
    return { ...task, attemptId: last.id, candidateRevision: last.candidateRevision, evidence: last.evidence };
  }

  private prompt(task: TaskState) {
    const steers = this.records("inbox_applied").map((e) => dataOf(e).action as InboxAction).filter((a) => a.kind === "replan" && a.taskIds.includes(task.id));
    const spec = this.ledger.entries().filter((e) => e.actor === "runner" && e.kind === "spec_version").at(-1);
    const version = Number(spec ? dataOf(spec).version : 1);
    return { taskId: task.id, goal: task.definition.goal || task.definition.title, exitCondition: task.definition.exitCondition,
      acceptanceCriteria: task.definition.acceptanceCriteria, decisions: steers.map((a) => a.kind === "replan" ? `Steer #${a.seq}: ${a.note}` : ""),
      specPath: String(spec ? dataOf(spec).path ?? `docs/spec/v${version}.md` : "docs/spec/v1.md"),
      mayNotTouch: [".jarvis-routing.json", ".git/hooks/", ".git/config", ".claude/"], maxTurns: this.turns, specVersion: version };
  }
  private observeGroup(task: TaskState, workspace: TaskWorkspace) {
    let group: ProcessGroupRecord | null = null;
    let groupExited = false;
    let identityMissing = false;
    let checkpointError: unknown;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    // Disposing the attempt never disarms SIGKILL: only the group's exit does (Opus review L3).
    const dispose = () => { for (const timer of timers) clearTimeout(timer); };
    const onSpawn = (groupId: number): boolean => {
      try {
        group = captureProcessGroup(groupId, this.opts.readProcessStartTime);
        if (!group) { identityMissing = true; return false; }
        this.ledger.append({ kind: "attempt_started", actor: "runner", task_id: task.id, attempt_id: workspace.attemptId,
          data: { runId: this.runId, workspace: workspace.path, baseRevision: workspace.baseRevision, processGroup: groupId, processGroupRecord: group } });
        let stopping = false;
        const shutdown = () => {
          if (stopping || groupExited) return;
          stopping = true;
          this.record("shutdown_intent", { groupId }, task.id, workspace.attemptId);
          this.signal(groupId, "SIGTERM");
          killTimer = setTimeout(() => { if (!groupExited) this.signal(groupId, "SIGKILL"); }, 1000);
        };
        this.groups.set(groupId, shutdown);
        timers.push(setTimeout(() => { timedOut = true; shutdown(); }, this.timeout));
        this.opts.onCheckpoint?.("spawned", task.id);
        return true;
      } catch (e) { checkpointError = e; return false; }
    };
    const onGroupExit = (groupId: number) => {
      if (group?.groupId !== groupId) return;
      groupExited = true;
      this.groups.delete(groupId);
      if (killTimer) clearTimeout(killTimer);
      dispose();
    };
    const result = (outcome: TaskOutcome & { finalMessage?: string }) => {
      if (checkpointError !== undefined) throw checkpointError;
      if (group && !groupExited) throw new Error("process group did not exit; attempt remains recoverable");
      if (timedOut) outcome = { ...outcome, status: "timeout" };
      return { outcome, group, identityMissing, endedGroup: group ? { ...group, exited: true } : undefined };
    };
    return { onSpawn, onGroupExit, result, dispose };
  }
  private async session(task: TaskState, workspace: TaskWorkspace, repair: string, failure: EscalationReason | undefined) {
    const input = this.prompt(task);
    const sessionDir = join(this.opts.projectDir, "sessions", randomUUID());
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const headerPath = join(sessionDir, "header.md");
    writeFileSync(headerPath, buildRunHeader({ ...input, runId: this.runId }), { flag: "wx", mode: 0o600 });
    const observer = this.observeGroup(task, workspace);
    try {
      await this.pauseUsage();
      this.footprint?.sessionStarted();
      let outcome: TaskOutcome & { finalMessage?: string };
      try { outcome = await this.harness.runTask({
        workspace: workspace.path, prompt: `${buildTaskPrompt(input)}${repair ? `\n\n${repair}` : ""}${task.definition.mayTouch ? `\nMay touch only: ${task.definition.mayTouch.join(", ")}` : ""}`,
        runHeaderPath: headerPath, role: "build", tier: 1, maxTurns: this.turns, timeoutMs: this.timeout, logPath: join(sessionDir, "stream.jsonl"),
        ...(failure ? { failure } : {}),
        onSpawn: observer.onSpawn, onGroupExit: observer.onGroupExit,
      }); } finally { this.footprint?.sessionEnded(); }
      // A usage-log failure never fails the run (runner/usage-log.ts); a refused session isn't logged.
      recordSessionUsage(this.ledger, { runId: this.runId, taskId: task.id, attemptId: workspace.attemptId, role: "build", tier: 1,
        route: routeTask("build", 1, failure, this.routing), ...(failure ? { failure } : {}), outcome });
      return observer.result(outcome);
    } finally { observer.dispose(); }
  }
  private async attempt(task: TaskState, workspace: TaskWorkspace, repair: string, failure?: EscalationReason): Promise<void> {
    let backoff = 0;
    for (;;) {
      const { outcome, group, endedGroup, identityMissing } = await this.session(task, workspace, repair, failure);
      // Only a limit reported before any session started may come without a captured group (Opus review L2).
      const noSession = outcome.status === "usage-limited" && outcome.sessionUsage === undefined && outcome.exitCode === null;
      if (outcome.status === "refused" || identityMissing || (!group && !noSession)) {
        this.end(workspace, "failed", undefined, endedGroup);
        return this.block(this.state().tasks[task.id]!, outcome.status === "refused" ? outcome.reason : "process group identity unavailable");
      }
      if (outcome.status === "usage-limited") this.end(workspace, "usage_wait", undefined, endedGroup);
      const wait = await waitForUsage({ outcome, ledger: this.ledger, taskId: task.id, attemptId: workspace.attemptId, backoffAttempt: backoff++ }, {
        now: this.now, sleep: this.sleep, notify: this.opts.notify ?? (async () => {}), reprobe: () => this.probeUsage(),
        ...(this.opts.usageMarginMs !== undefined ? { marginMs: this.opts.usageMarginMs } : {}),
      });
      if (outcome.status === "usage-limited" && wait === "resume") {
        this.lease(task.id, workspace.attemptId, workspace.path);
        this.ledger.append({ kind: "attempt_started", actor: "runner", task_id: task.id, attempt_id: workspace.attemptId, data: { runId: this.runId, workspace: workspace.path, baseRevision: workspace.baseRevision } });
        continue;
      }
      this.record("session_finished", { outcome: outcome.status, ...(endedGroup ? { processGroupRecord: endedGroup } : {}) }, task.id, workspace.attemptId);
      this.footprint?.sample();
      if (this.failed) { this.end(workspace, "failed", undefined, endedGroup); return; }
      await this.candidate(task, workspace, outcome, endedGroup);
      return;
    }
  }
  private end(workspace: TaskWorkspace, status: "failed" | "completed" | "usage_wait", candidate?: CandidateRevision, group?: ProcessGroupRecord): void {
    this.ledger.append({ kind: "attempt_ended", actor: "runner", task_id: workspace.taskId, attempt_id: workspace.attemptId,
      data: { status, ...(candidate ? { candidateRevision: candidate.revision } : {}), ...(group ? { processGroupRecord: group } : {}) } });
  }
  private async candidate(task: TaskState, workspace: TaskWorkspace, outcome: TaskOutcome & { finalMessage?: string }, group?: ProcessGroupRecord): Promise<void> {
    let candidate: CandidateRevision;
    try {
      const notes = readTaskNotes(workspace);
      const text = notes?.text ?? outcome.finalMessage;
      if (text) this.record("agent_claim", { text: text.slice(0, 65_536), source: notes ? `.jarvis/notes/${task.id}.md` : "session final message" }, task.id, workspace.attemptId);
      this.record("candidate_intent", { ref: `refs/heads/jarvis/candidates/${task.id}/${workspace.attemptId}` }, task.id, workspace.attemptId);
      candidate = commitCandidate(workspace, this.opts.git ? { git: this.opts.git } : {});
      const paths = this.git(["ls-tree", "-r", "--name-only", "-z", candidate.revision]).split("\0");
      if (paths.some((path) => path.split("/")[0]?.toLowerCase() === ".jarvis")) throw new Error("candidate contains runner-owned .jarvis paths");
    } catch (e) {
      this.end(workspace, "failed", undefined, group);
      return this.block(this.state().tasks[task.id]!, `candidate refused: ${short(e)}`);
    }
    this.opts.onCheckpoint?.("candidate-committed", task.id);
    this.end(workspace, "completed", candidate, group);
    if (outcome.status !== "finished") {
      this.ledger.append({ kind: "review_result", actor: "runner", task_id: task.id, attempt_id: workspace.attemptId,
        data: { reviewer: "session", revision: candidate.revision, status: "fail", summary: outcome.status === "timeout" ? "task timeout" : "task session failed" } });
      return;
    }
    await this.verifyCandidate(task.id, workspace.attemptId, candidate);
  }

  private async verifyCandidate(taskId: string, attemptId: string, candidate: CandidateRevision): Promise<void> {
    let task = this.state().tasks[taskId]!;
    let failedGate = false;
    for (const name of task.definition.requiredChecks) {
      const old = task.evidence.filter((e) => e.kind === "gate_result" && dataOf(e).check === name && dataOf(e).revision === candidate.revision).at(-1);
      if (old) {
        if (dataOf(old).status === "pass" && this.verify(old).ok) continue;
        if (dataOf(old).status === "fail") { failedGate = true; continue; }
        return this.block(task, dataOf(old).status === "tampered" ? "protected check changed" : "gate evidence unavailable");
      }
      this.record("gate_intent", { check: name, revision: candidate.revision }, taskId, attemptId);
      const check = this.opts.checks[name];
      if (!check) return this.block(task, `required check unavailable: ${name}`);
      const result = await (this.opts.gate ?? runGate)({ ledger: this.ledger, store: new ChecksStore(this.opts.projectDir), projectDir: this.opts.projectDir,
        jarvisHome: this.opts.jarvisHome, workRoot: this.opts.workRoot, repoPath: this.opts.repoPath, revision: candidate.revision, check, taskId, attemptId });
      if (result.status === "tampered") return this.block(task, "protected check changed");
      if (result.status === "error") return this.block(task, `gate error: ${name}`);
      if (result.status !== "pass") { failedGate = true; continue; }
      if (!this.verify(result.entry).ok) return this.block(task, "gate evidence changed");
    }
    if (failedGate) return;
    task = this.state().tasks[taskId]!;
    for (const reviewer of task.definition.requiredReviews) {
      const old = task.evidence.filter((e) => e.kind === "review_result" && dataOf(e).reviewer === reviewer && dataOf(e).revision === candidate.revision).at(-1);
      if (old) { if (dataOf(old).status === "pass") continue; return; }
      // An "error" is the review's infrastructure failing, not the code (decisions 100, 111): it is retried, and
      // if it persists the task blocks with that reason. Neither spends a repair or sends the builder a fix prompt.
      let status: "pass" | "fail" | "investigate" | "error" | undefined;
      for (let tries = 0; tries < REVIEW_TRIES && (status === undefined || status === "error"); tries++) status = await this.reviewOnce(taskId, attemptId, candidate, reviewer);
      if (status === "fail") return;
      task = this.state().tasks[taskId]!;
      if (status === "investigate") return this.block(task, `review ${reviewer} needs investigation`);
      if (status === "error") return this.block(task, `review infrastructure error: ${this.reviewError(task, reviewer, candidate.revision)}`);
      if (status !== "pass") return this.block(task, "reviewer returned an invalid verdict");
    }
    this.opts.onCheckpoint?.("passed", taskId);
    await this.promote(taskId, attemptId, candidate);
  }
  /** What the review service recorded about its last infrastructure error for this reviewer and revision. */
  private reviewError(task: TaskState, reviewer: string, revision: string): string {
    const recorded = task.evidence.filter((e) => e.kind === "review_result" && dataOf(e).reviewer === reviewer && dataOf(e).revision === revision).at(-1);
    const reason = recorded ? dataOf(recorded).error ?? dataOf(recorded).summary : undefined;
    return typeof reason === "string" && reason.trim() ? short(reason).slice(0, 160) : `review ${reviewer} produced no verdict`;
  }
  private async reviewOnce(taskId: string, attemptId: string, candidate: CandidateRevision, reviewer: string): Promise<"pass" | "fail" | "investigate" | "error" | undefined> {
    const task = this.state().tasks[taskId]!;
    await this.pauseUsage();
    this.record("review_intent", { reviewer, revision: candidate.revision }, taskId, attemptId);
    const verdict = await this.opts.review({ taskId, attemptId, revision: candidate.revision, reviewer, acceptanceCriteria: task.definition.acceptanceCriteria,
      evidence: task.evidence.filter((e) => e.kind === "gate_result" && dataOf(e).revision === candidate.revision) });
    if (typeof verdict === "object" && verdict !== null && verdict.recorded === true) {
      const recorded = this.state().tasks[taskId]!.evidence.filter((e) => e.kind === "review_result" && dataOf(e).reviewer === reviewer && dataOf(e).revision === candidate.revision).at(-1);
      // The service records its own verdict; trust only what reached the ledger for this revision.
      return recorded && dataOf(recorded).status === verdict.status && ["pass", "fail", "investigate", "error"].includes(verdict.status) ? verdict.status : undefined;
    }
    if (verdict !== "pass" && verdict !== "fail") return undefined;
    this.ledger.append({ kind: "review_result", actor: "runner", task_id: taskId, attempt_id: attemptId, data: { reviewer, revision: candidate.revision, status: verdict } });
    return verdict;
  }
  /** Every required gate and review passed at the task's current candidate revision. */
  private verdictsPass(task: TaskState): boolean {
    const latest = (kind: string, key: string, name: string) => task.evidence.filter((e) => e.actor === "runner" && e.kind === kind && dataOf(e)[key] === name && dataOf(e).revision === task.candidateRevision).at(-1);
    return task.candidateRevision !== null
      && task.definition.requiredChecks.every((name) => { const e = latest("gate_result", "check", name); return e !== undefined && dataOf(e).status === "pass" && this.verify(e).ok; })
      && task.definition.requiredReviews.every((name) => dataOf(latest("review_result", "reviewer", name) ?? { data: {} } as LedgerEntry).status === "pass");
  }
  private ancestor(a: string, b: string): boolean {
    try { this.git(["merge-base", "--is-ancestor", a, b]); return true; } catch (e) { if ((e as { status?: number }).status === 1) return false; throw e; }
  }
  /**
   * Promotion is serialized and only ever a fast-forward to a revision that was gated and reviewed as
   * itself (Opus review H1). A candidate built on a head the branch has moved past is merged by the
   * runner onto the new head and verified again; a conflict ends the attempt uncharged, and the task is
   * redone from the new head. The task is passed only once promoted (M1); failures block, never throw.
   */
  private async promote(taskId: string, attemptId: string, candidate: CandidateRevision): Promise<void> {
    const work = this.promotion.then(() => this.promoteNow(taskId, attemptId, candidate));
    this.promotion = work.then(() => {}, () => {});
    const merged = await work;
    if (merged) await this.verifyCandidate(taskId, attemptId, merged);
  }
  private async promoteNow(taskId: string, attemptId: string, candidate: CandidateRevision): Promise<CandidateRevision | undefined> {
    if (this.failed) return undefined;
    let task = this.state().tasks[taskId]!;
    if (task.attemptId !== attemptId || task.candidateRevision !== candidate.revision || !this.verdictsPass(task)) { await this.block(task, "promotion evidence changed"); return undefined; }
    const home = this.opts.gitHome ? { home: this.opts.gitHome } : {};
    const git = this.opts.git ? { git: this.opts.git } : {};
    try {
      const head = this.git(["rev-parse", "--verify", `refs/heads/${this.opts.runBranch}^{commit}`]);
      let mergedRevision: string;
      if (this.ancestor(candidate.revision, head)) {
        mergedRevision = head; // promoted before a crash, recorded now
      } else if (this.ancestor(head, candidate.revision)) {
        this.record("promotion_intent", { candidate, expectedHead: head }, taskId, attemptId);
        mergedRevision = promoteCandidate({ repoPath: this.opts.repoPath, candidate, runBranch: this.opts.runBranch, expectedHead: head, ...home, ...git });
      } else {
        this.record("merge_intent", { candidate, head }, taskId, attemptId);
        const merged = mergeCandidate({ repoPath: this.opts.repoPath, candidate, head, ...home, ...git });
        if (!merged) {
          this.record("stale_base", { revision: candidate.revision, head, reason: "conflicts with the moved run branch" }, taskId, attemptId);
          this.ledger.append({ kind: "attempt_ended", actor: "runner", task_id: taskId, attempt_id: attemptId, data: { status: "failed" } });
          return undefined;
        }
        this.record("merge_candidate", { revision: merged.revision, from: candidate.revision, head }, taskId, attemptId);
        this.ledger.append({ kind: "attempt_ended", actor: "runner", task_id: taskId, attempt_id: attemptId, data: { status: "completed", candidateRevision: merged.revision } });
        return merged;
      }
      this.record("promoted", { revision: candidate.revision, mergedRevision }, taskId, attemptId);
      this.ledger.append({ kind: "state_reached", actor: "runner", task_id: taskId, attempt_id: attemptId, data: { state: "passed", revision: candidate.revision, mergedRevision } });
    } catch (e) {
      this.record("promotion_failed", { revision: candidate.revision, message: short(e) }, taskId, attemptId);
      await this.block(this.state().tasks[taskId]!, `promotion refused: ${short(e)}`);
      return undefined;
    }
    task = this.state().tasks[taskId]!;
    if (!isDone(task, this.verify)) await this.block(task, "completion evidence changed");
    return undefined;
  }

  private async recoverCandidates(): Promise<void> {
    for (let task of Object.values(this.state().tasks)) {
      if (!task.attemptId || task.status === "blocked" || isDone(task, this.verify)) continue;
      const attempt = task.attempts.find((a) => a.id === task.attemptId);
      // An attempt the runner ended (refused, stale, failed) or parked for usage is not a candidate to recover.
      if (attempt?.outcome === "failed" || attempt?.outcome === "usage_wait") continue;
      const ref = `refs/heads/jarvis/candidates/${task.id}/${task.attemptId}`;
      let refRevision: string | undefined;
      try { refRevision = this.git(["rev-parse", "--verify", `${ref}^{commit}`]); } catch { refRevision = undefined; }
      let revision: string;
      if (task.candidateRevision) {
        // The ledger's candidate is the truth: a crash between a runner merge and its record left the ref ahead.
        revision = task.candidateRevision;
        if (refRevision !== revision) { try { this.git(["update-ref", ref, revision]); } catch { continue; } }
      } else if (refRevision) revision = refRevision;
      else continue;
      const candidate = { revision, ref };
      const session = this.records("session_finished", task.id, task.attemptId).at(-1);
      if (!session) continue;
      if (attempt?.outcome !== "completed") {
        this.ledger.append({ kind: "attempt_ended", actor: "runner", task_id: task.id, attempt_id: task.attemptId,
          data: { status: "completed", candidateRevision: revision, ...(dataOf(session).processGroupRecord ? { processGroupRecord: dataOf(session).processGroupRecord } : {}) } });
      }
      task = this.state().tasks[task.id]!;
      if (dataOf(session).outcome !== "finished") {
        if (!task.evidence.some((e) => e.kind === "review_result" && dataOf(e).reviewer === "session")) {
          this.ledger.append({ kind: "review_result", actor: "runner", task_id: task.id, attempt_id: task.attemptId,
            data: { reviewer: "session", revision, status: "fail", summary: `task session ${String(dataOf(session).outcome)}` } });
        }
        continue;
      }
      if (task.evidence.some((e) => dataOf(e).revision === revision && ["fail", "tampered", "error", "investigate"].includes(String(dataOf(e).status)))) continue;
      await this.verifyCandidate(task.id, task.attemptId!, candidate);
    }
  }
  private finish(): RunLoopResult {
    const state = this.state();
    const done = Object.values(state.tasks).filter((t) => isDone(t, this.verify)).map((t) => t.id);
    const blocked = Object.values(state.tasks).filter((t) => !isDone(t, this.verify)).map((t) => t.id);
    const status = blocked.length ? "blocked" : "complete";
    this.record("candidate_cleanup_intent");
    deleteCandidateBranches(this.opts.repoPath, { ...(this.opts.gitHome ? { home: this.opts.gitHome } : {}), ...(this.opts.git ? { git: this.opts.git } : {}) });
    if (this.footprint) {
      try { this.ledger.append(buildFootprintEntry(this.runId, this.footprint.finish())); } catch { /* A footprint failure never fails the run. */ }
    }
    this.ledger.append({ kind: "run_ended", actor: "runner", data: { runId: this.runId, status, done, blocked } });
    const claims: ReportClaim[] = this.records("agent_claim").map((e) => ({ taskId: e.task_id!, text: String(dataOf(e).text), source: String(dataOf(e).source) }));
    writeReport(join(this.opts.repoPath, ".jarvis"), this.state(), this.ledger.entries(), claims, { now: this.now, verifyEvidence: this.verify });
    if (existsSync(this.pidFile) && readFileSync(this.pidFile, "utf8").trim() === String(process.pid)) rmSync(this.pidFile);
    return { status, done, blocked };
  }
}

/** A rejected loop deliberately leaves its run open: the next process cleans and replays it. */
export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const loop = new Loop(opts);
  loop.acquire();
  try { await loop.start(); return await loop.schedule(); }
  catch (e) { loop.stop(); throw e; }
  finally { await loop.settle(); loop.release(); }
}
