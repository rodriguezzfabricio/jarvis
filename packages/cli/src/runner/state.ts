import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { verifyEvidence } from "../checks/gate.ts";
import { z } from "zod";
import type { AppendInput, LedgerEntry } from "../ledger/ledger.ts";

const text = z.string().min(1);
const pid = z.number().int().min(2);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const processGroupRecord = z.object({
  groupId: pid, leaderPid: pid, startedAt: text, exited: z.boolean(),
}).refine((r) => r.groupId === r.leaderPid, "group leader must match its process group");
export type ProcessGroupRecord = z.infer<typeof processGroupRecord>;

const definition = z.object({
  goal: z.string().default(""), exitCondition: z.string().default(""), mayTouch: z.array(text).optional(),
  title: z.string().default(""), acceptanceCriteria: z.array(text).default([]), storyIds: z.array(text).default([]),
  dependencies: z.array(text).default([]), priority: z.number().finite().default(0),
  requiredChecks: z.array(text).min(1).default(["unit"]),
  requiredReviews: z.array(text).min(1).default(["code"]),
  baseRevision: revision.optional(),
  /** The plan's top-level notes (decision 113): planner claims shown in every build prompt, never evidence. */
  planNotes: z.array(text).optional(),
});
const leaseData = z.object({
  runId: text, holderPid: pid, expiresAt: z.number().finite(),
  workspace: text.optional(), processGroup: pid.optional(), processGroupRecord: processGroupRecord.optional(),
});
const runData = z.object({
  runId: text, pid, workspaces: z.array(text).default([]), processGroups: z.array(pid).default([]), processGroupRecords: z.array(processGroupRecord).default([]),
  lastGreenRevision: revision.optional(),
});
const startData = z.object({ runId: text, baseRevision: revision.optional(), workspace: text.optional(), processGroup: pid.optional(), processGroupRecord: processGroupRecord.optional() });
const endData = z.object({ status: z.enum(["completed", "failed", "usage_wait"]), candidateRevision: revision.optional(), processGroupRecord: processGroupRecord.optional() });

const usageWaitData = z.object({ until: z.number().finite() }).passthrough();

export type UsageWaitData = z.infer<typeof usageWaitData>;
export type TaskDefinition = z.infer<typeof definition>;
export type TaskCreatedData = z.input<typeof definition>;
export type RunStartedData = z.input<typeof runData>;
export interface TaskPassedData {
  state: "passed";
  /** The candidate revision whose gates and reviews passed. */
  revision: string;
  /** The promoted branch revision, when promotion needed a merge commit. */
  mergedRevision?: string;
}
export type TaskStatus = "pending" | "leased" | "running" | "passed" | "failed" | "blocked";
export interface LeaseInput {
  taskId: string;
  attemptId: string;
  runId: string;
  holderPid: number;
  ttlMs: number;
  workspace?: string;
  processGroup?: number;
  processGroupRecord?: ProcessGroupRecord;
}
export type RunnerLease = z.infer<typeof leaseData> & { taskId: string; attemptId: string };
export type AttemptStartedData = z.infer<typeof startData>;
export type AttemptEndedData = z.infer<typeof endData>;
export interface AttemptState {
  id: string;
  outcome: AttemptEndedData["status"] | null;
  candidateRevision: string | null;
  evidence: LedgerEntry[];
}
export interface AlternativeSwitchData {
  type: "alternative_switch";
  decisionId: string;
  from: string;
  to: string;
  reason: string;
}
export interface AlternativeSwitchInput extends Omit<AlternativeSwitchData, "type"> { taskId: string }
export type EvidenceVerifier = (entry: LedgerEntry) => { ok: boolean; problems: string[] };
export interface TaskState {
  id: string;
  definition: TaskDefinition;
  status: TaskStatus;
  blockedReason: string | null;
  attemptCount: number;
  attempts: AttemptState[];
  completion: LedgerEntry | null;
  alternativeSwitches: AlternativeSwitchData[];
  attemptId: string | null;
  candidateRevision: string | null;
  evidence: LedgerEntry[];
  usageWaitUntil: number | null;
  interruption: string | null;
}
export interface RunnerRun {
  runId: string;
  pid: number;
  ended: boolean;
  workspaces: string[];
  processGroups: number[];
  processGroupRecords: ProcessGroupRecord[];
}
export interface RunState {
  tasks: Record<string, TaskState>;
  activeLeases: RunnerLease[];
  runs: RunnerRun[];
  lastGreenRevision: string | null;
  nextRunnableTaskId: string | null;
  /** All recorded waits retain session metadata; usageWaitUntil is the latest unexpired deadline. */
  usageWaits: UsageWaitData[];
  usageWaitUntil: number | null;
}
export interface RebuildContext {
  now: number;
  /** A snapshot of live holders, if available; omitted means expiry alone decides. */
  alivePids?: ReadonlySet<number>;
  /** Dependency completion re-verifies evidence; inject for deterministic replay fixtures. */
  verifyEvidence?: EvidenceVerifier;
}
export interface LeaseClock {
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
}

/** Append this under Ledger.transact, after checking that no unexpired lease owns the task. */
export function buildLease(input: LeaseInput, now: () => number = Date.now): AppendInput {
  text.parse(input.taskId);
  text.parse(input.attemptId);
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error("lease TTL must be positive");
  const { taskId, attemptId, ttlMs, ...owner } = input;
  const data = leaseData.parse({ ...owner, expiresAt: now() + ttlMs });
  return { kind: "lease", actor: "runner", task_id: taskId, attempt_id: attemptId, data };
}

export function leaseExpired(lease: RunnerLease, clock: LeaseClock = {}): boolean {
  return lease.expiresAt <= (clock.now ?? Date.now)() || (clock.pidAlive !== undefined && !clock.pidAlive(lease.holderPid));
}


const alternativeData = z.object({ type: z.literal("alternative_switch"), decisionId: text, from: text, to: text, reason: text });

/** Append before beginning the fallback; no new ledger kind is needed. */
export function buildAlternativeSwitch(input: AlternativeSwitchInput): AppendInput {
  const { taskId, ...choice } = input;
  text.parse(taskId);
  const data = alternativeData.parse({ ...choice, type: "alternative_switch" });
  if (data.from === data.to) throw new Error("an alternative switch must change the choice");
  return { kind: "decision", actor: "runner", task_id: taskId, data };
}

function latestEvidence(t: TaskState, kind: "gate_result" | "review_result", name: string): LedgerEntry | undefined {
  return t.evidence.filter((e) => {
    const d = e.data as Record<string, unknown>;
    return e.actor === "runner" && e.task_id === t.id && e.attempt_id === t.attemptId
      && e.kind === kind && d[kind === "gate_result" ? "check" : "reviewer"] === name;
  }).at(-1);
}

/** Ledger completion plus named revision-bound verdicts, with gate files re-verified on every call. */
export function isDone(task: TaskState, verify: EvidenceVerifier = verifyEvidence): boolean {
  const completion = task.completion;
  const d = completion?.data as Record<string, unknown> | undefined;
  const reached = task.status === "passed" && completion?.actor === "runner" && completion.kind === "state_reached"
    && completion.task_id === task.id && completion.attempt_id === task.attemptId && d?.state === "passed"
    && d.revision === task.candidateRevision;
  if (!reached || !hasPassEvidence(task)
    || task.attempts.find((a) => a.id === task.attemptId)?.outcome !== "completed") return false;
  try {
    return task.definition.requiredChecks.every((name) => {
      const entry = latestEvidence(task, "gate_result", name);
      return entry !== undefined && verify(entry).ok;
    });
  } catch {
    return false;
  }
}

/** One charged failure per completed attempt; waits, crashes, and protected-check tampering cost none. */
export function repairsUsed(task: TaskState): number {
  return task.attempts.filter((attempt) => attempt.outcome === "completed" && attempt.candidateRevision !== null
    && !attempt.evidence.some((entry) => entry.kind === "gate_result" && (entry.data as { status?: string }).status === "tampered")
    && attempt.evidence.some((entry) => {
      const d = entry.data as Record<string, unknown>;
      return entry.actor === "runner" && entry.task_id === task.id && entry.attempt_id === attempt.id
        && (entry.kind === "gate_result" || entry.kind === "review_result")
        && d.status === "fail" && d.revision === attempt.candidateRevision;
    })).length;
}


export type EvidenceReader = (path: string, maxBytes: number) => string;
export interface FailureCaseEvidence {
  id: string;
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}
export interface FailureEvidence {
  check: string;
  revision: string;
  verified: boolean;
  problems: string[];
  cases: FailureCaseEvidence[];
  verification?: { code: number | null; timedOut: boolean; completed: boolean; stdout: string; stderr: string };
}
const caseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const failureData = z.object({
  check: text, revision, status: z.literal("fail"),
  caseResults: z.array(z.object({ id: caseId, code: z.number().int().nonnegative().nullable(), timedOut: z.boolean() })),
  verifyExitCode: z.number().int().nullable().optional(), verifyTimedOut: z.boolean().optional(), completed: z.boolean().optional(),
  evidence: z.object({ dir: text, files: z.record(z.string(), text) }),
});
type FailedGate = z.infer<typeof failureData>;

function readEvidenceTail(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("evidence must be a regular file");
    const size = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let used = 0;
    while (used < size) {
      const n = readSync(fd, buffer, used, size - used, st.size - size + used);
      if (n === 0) break;
      used += n;
    }
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function boundedTail(value: string, maxBytes: number): string {
  const lines = value.replace(/\n$/, "").split("\n").slice(-40).join("\n");
  const buffer = Buffer.from(lines);
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function evidencePair(dir: string, stdout: string, stderr: string, read: EvidenceReader): { stdout: string; stderr: string } {
  return {
    stdout: boundedTail(read(join(dir, stdout), 2048), 2048),
    stderr: boundedTail(read(join(dir, stderr), 2048), 2048),
  };
}

function validateFailureLayout(data: FailedGate): void {
  if (!isAbsolute(data.evidence.dir)) throw new Error("evidence directory must be absolute");
  const allowed = /^(?:cases\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/(?:stdout|stderr|code)|verify-(?:stdout|stderr)\.log)$/;
  if (Object.keys(data.evidence.files).some((path) => !allowed.test(path))) throw new Error("invalid evidence manifest path");
  const ids = new Set<string>();
  for (const c of data.caseResults) {
    if (ids.has(c.id)) throw new Error("duplicate evidence case id");
    ids.add(c.id);
    for (const name of ["stdout", "stderr", "code"]) {
      if (!Object.hasOwn(data.evidence.files, `cases/${c.id}/${name}`)) throw new Error("case output is absent from hashed evidence manifest");
    }
  }
}

function failureCase(data: FailedGate, c: FailedGate["caseResults"][number], read: EvidenceReader): FailureCaseEvidence {
  const codeText = read(join(data.evidence.dir, "cases", c.id, "code"), 64).trim();
  if (codeText !== "signal" && !/^(?:0|[1-9][0-9]*)$/.test(codeText)) throw new Error("invalid evidence exit code");
  const code = codeText === "signal" ? null : Number(codeText);
  if (code !== c.code) throw new Error("evidence exit code differs from the ledger");
  return { id: c.id, code, timedOut: c.timedOut, ...evidencePair(data.evidence.dir, `cases/${c.id}/stdout`, `cases/${c.id}/stderr`, read) };
}

function latestFailure(task: TaskState): LedgerEntry | undefined {
  return task.attempts.flatMap((a) => a.evidence).filter((e) => {
    const d = e.data as Record<string, unknown>;
    return e.actor === "runner" && e.task_id === task.id && e.kind === "gate_result" && d.status === "fail";
  }).sort((a, b) => a.seq - b.seq).at(-1);
}

/** Verified observations only. Each stream has at most 40 lines and 2 KB (4 KB per case). */
export function failureEvidence(task: TaskState, read: EvidenceReader = readEvidenceTail, verify: EvidenceVerifier = verifyEvidence): FailureEvidence | null {
  const entry = latestFailure(task);
  if (!entry) return null;
  const raw = entry.data as Record<string, unknown>;
  const result: FailureEvidence = { check: String(raw.check ?? ""), revision: String(raw.revision ?? ""), verified: false, problems: [], cases: [] };
  try {
    const data = failureData.parse(entry.data);
    validateFailureLayout(data);
    const checked = verify(entry);
    if (!checked.ok) return { ...result, problems: checked.problems };
    const failed = data.caseResults.filter((c) => c.code !== 0 || c.timedOut);
    // Verify can reject behavior even when every case process exited zero; then all observations matter.
    const cases = (failed.length ? failed : data.caseResults).map((c) => failureCase(data, c, read));
    const verification = Object.hasOwn(data.evidence.files, "verify-stdout.log") && Object.hasOwn(data.evidence.files, "verify-stderr.log")
      ? { code: data.verifyExitCode ?? null, timedOut: data.verifyTimedOut ?? false, completed: data.completed ?? false, ...evidencePair(data.evidence.dir, "verify-stdout.log", "verify-stderr.log", read) }
      : undefined;
    return { ...result, verified: true, cases, ...(verification ? { verification } : {}) };
  } catch (e) {
    return { ...result, problems: [String(e)] };
  }
}

interface Replay {
  state: RunState;
  leases: Map<string, RunnerLease>;
  attempts: Map<string, Set<string>>;
  starts: Map<string, AttemptStartedData>;
  ends: Map<string, AttemptEndedData>;
  leaseSeq: Map<string, number>;
  startSeq: Map<string, number>;
}

function taskFor(r: Replay, e: LedgerEntry): TaskState {
  const t = e.task_id === null ? undefined : r.state.tasks[e.task_id];
  if (!t) throw new Error(`${e.kind}: task_created must precede task events`);
  return t;
}

function attemptId(e: LedgerEntry): string {
  return text.parse(e.attempt_id);
}

function recordRun(r: Replay, e: LedgerEntry): void {
  if (e.kind === "run_started") {
    const d = runData.parse(e.data);
    if (r.state.runs.some((run) => run.runId === d.runId)) throw new Error("duplicate run ID");
    r.state.runs.push({ runId: d.runId, pid: d.pid, ended: false, workspaces: [...d.workspaces], processGroups: [...d.processGroups], processGroupRecords: [] });
    for (const record of d.processGroupRecords) recordGroup(r, d.runId, record);
    r.state.lastGreenRevision ??= d.lastGreenRevision ?? null;
  } else {
    const d = z.object({ runId: text }).parse(e.data);
    const run = r.state.runs.find((v) => v.runId === d.runId);
    if (!run) throw new Error("run_ended without run_started");
    run.ended = true;
  }
}



function recordGroup(r: Replay, runId: string, record: ProcessGroupRecord): void {
  const run = r.state.runs.find((v) => v.runId === runId);
  if (!run) return;
  const previous = run.processGroupRecords.find((g) => g.groupId === record.groupId && g.leaderPid === record.leaderPid && g.startedAt === record.startedAt);
  if (previous) previous.exited ||= record.exited;
  else run.processGroupRecords.push({ ...record });
  if (!run.processGroups.includes(record.groupId)) run.processGroups.push(record.groupId);
}

function endGroup(r: Replay, record: ProcessGroupRecord): void {
  for (const run of r.state.runs) {
    if (run.processGroupRecords.some((g) => g.groupId === record.groupId && g.startedAt === record.startedAt)) recordGroup(r, run.runId, record);
  }
}

function recordResources(r: Replay, runId: string, workspace: string | undefined, processGroup: number | undefined): void {
  const run = r.state.runs.find((v) => v.runId === runId);
  if (!run) return;
  if (workspace && !run.workspaces.includes(workspace)) run.workspaces.push(workspace);
  if (processGroup && !run.processGroups.includes(processGroup)) run.processGroups.push(processGroup);
}

function startAttempt(r: Replay, e: LedgerEntry, t: TaskState): void {
  const id = attemptId(e);
  const d = startData.parse(e.data);
  const run = r.state.runs.find((v) => v.runId === d.runId);
  if (!run) throw new Error("attempt_started without run_started");
  recordResources(r, d.runId, d.workspace, d.processGroup);
  if (d.processGroupRecord) recordGroup(r, d.runId, d.processGroupRecord);
  if (t.status === "blocked") return;
  r.startSeq.set(t.id, e.seq);
  const seen = r.attempts.get(t.id) ?? new Set<string>();
  if (seen.has(id)) {
    if (id === t.attemptId && r.ends.get(t.id)?.status === "usage_wait") {
      t.status = "running";
      t.usageWaitUntil = null;
      const attempt = t.attempts.find((a) => a.id === id)!;
      attempt.outcome = null;
      attempt.candidateRevision = null;
      attempt.evidence = [];
      t.evidence = attempt.evidence;
      t.completion = null;
      r.starts.set(t.id, d);
      r.ends.delete(t.id);
    }
    return;
  }
  seen.add(id);
  r.attempts.set(t.id, seen);
  t.attemptCount = seen.size;
  t.attemptId = id;
  t.status = "running";
  t.candidateRevision = null;
  const attempt: AttemptState = { id, outcome: null, candidateRevision: null, evidence: [] };
  t.attempts.push(attempt);
  t.evidence = attempt.evidence;
  t.completion = null;
  t.usageWaitUntil = null;
  t.interruption = null;
  r.starts.set(t.id, d);
  r.ends.delete(t.id);
}

function endAttempt(r: Replay, e: LedgerEntry, t: TaskState): void {
  const id = attemptId(e);
  const attempt = t.attempts.find((a) => a.id === id);
  if (!attempt) return;
  const d = endData.parse(e.data);
  if (d.processGroupRecord) endGroup(r, d.processGroupRecord);
  attempt.outcome = d.status;
  attempt.candidateRevision = d.candidateRevision ?? null;
  if (id !== t.attemptId) return;
  r.ends.set(t.id, d);
  t.candidateRevision = d.candidateRevision ?? null;
  if (t.status === "blocked") return;
  if (d.status === "completed") t.status = "running"; // Verification still owns the lease.
  else {
    t.status = d.status === "usage_wait" ? "pending" : "failed";
    r.leases.delete(t.id);
  }
}

function hasPassEvidence(t: TaskState): boolean {
  const matches = (kind: "gate_result" | "review_result", name: string) => {
    const latest = latestEvidence(t, kind, name);
    const d = latest?.data as Record<string, unknown> | undefined;
    return d?.status === "pass" && d.revision === t.candidateRevision;
  };
  return t.definition.requiredChecks.every((name) => matches("gate_result", name))
    && t.definition.requiredReviews.every((name) => matches("review_result", name));
}


function recordEvidence(r: Replay, e: LedgerEntry, t: TaskState): void {
  const d = z.object({ status: text }).parse(e.data);
  const attempt = t.attempts.find((a) => a.id === e.attempt_id);
  attempt?.evidence.push(e);
  if (e.kind === "gate_result" && d.status === "tampered") {
    blockTask(r, t, "protected check changed");
    return;
  }
  if (!attempt || e.attempt_id !== t.attemptId) return;
  if (d.status !== "pass" && r.ends.has(t.id) && t.status !== "blocked") {
    t.status = "failed";
    r.leases.delete(t.id);
  }
}

function reachState(r: Replay, e: LedgerEntry, t: TaskState): void {
  const d = z.object({ state: text, revision: revision.optional(), mergedRevision: revision.optional() }).parse(e.data);
  if (d.state !== "passed" || e.attempt_id !== t.attemptId || t.status === "blocked") return;
  if (r.ends.get(t.id)?.status !== "completed" || !t.candidateRevision || d.revision !== t.candidateRevision || !hasPassEvidence(t)) return;
  t.status = "passed";
  t.completion = e;
  r.state.lastGreenRevision = d.mergedRevision ?? t.candidateRevision;
  r.leases.delete(t.id);
}


function blockTask(r: Replay, t: TaskState, reason: string): void {
  t.status = "blocked";
  t.blockedReason = reason;
  t.completion = null;
  r.leases.delete(t.id);
}

function recordUsageWait(r: Replay, e: LedgerEntry): void {
  const data = usageWaitData.parse(e.data);
  r.state.usageWaits.push(data);
  const task = e.task_id === null ? undefined : r.state.tasks[e.task_id];
  if (task && e.attempt_id === task.attemptId) task.usageWaitUntil = data.until;
}

function apply(r: Replay, e: LedgerEntry): void {
  if (e.actor !== "runner") return;
  if (e.kind === "run_started" || e.kind === "run_ended") return recordRun(r, e);
  if (e.kind === "task_created") {
    const id = text.parse(e.task_id);
    if (Object.hasOwn(r.state.tasks, id)) throw new Error(`duplicate task: ${id}`);
    r.state.tasks[id] = { id, definition: definition.parse(e.data), status: "pending", blockedReason: null, attemptCount: 0, attempts: [], completion: null, alternativeSwitches: [], attemptId: null, candidateRevision: null, evidence: [], usageWaitUntil: null, interruption: null };
    return;
  }
  if (e.kind === "usage_wait") return recordUsageWait(r, e);
  if (e.kind === "decision" && (e.data as { type?: string } | null)?.type === "alternative_switch") {
    taskFor(r, e).alternativeSwitches.push(alternativeData.parse(e.data));
    return;
  }
  if (!["lease", "attempt_started", "attempt_ended", "usage_wait", "gate_result", "review_result", "blocked", "state_reached"].includes(e.kind) || e.task_id === null) return;
  const t = taskFor(r, e);
  switch (e.kind) {
    case "lease": {
      const lease = { ...leaseData.parse(e.data), taskId: t.id, attemptId: attemptId(e) };
      recordResources(r, lease.runId, lease.workspace, lease.processGroup);
      if (lease.processGroupRecord) recordGroup(r, lease.runId, lease.processGroupRecord);
      if (t.status === "blocked") return;
      r.leases.set(t.id, lease);
      r.leaseSeq.set(t.id, e.seq);
      if (t.status === "pending" || t.status === "failed") t.status = "leased";
      return;
    }
    case "attempt_started": return startAttempt(r, e, t);
    case "attempt_ended": return endAttempt(r, e, t);
    case "gate_result":
    case "review_result": return recordEvidence(r, e, t);
    case "blocked": {
      const reason = z.object({ reason: z.string().optional() }).parse(e.data).reason ?? "blocked";
      return blockTask(r, t, reason.replace(/\s+/g, " ").slice(0, 240));
    }
    case "state_reached": return reachState(r, e, t);
  }
}

function finishReplay(r: Replay, context: RebuildContext): void {
  const runEnded = (id: string) => r.state.runs.some((v) => v.runId === id && v.ended);
  const live = (lease: RunnerLease) => !runEnded(lease.runId) && !leaseExpired(lease, {
    now: () => context.now,
    ...(context.alivePids ? { pidAlive: (owner: number) => context.alivePids!.has(owner) } : {}),
  });
  r.state.activeLeases = [...r.leases.values()].filter(live);
  for (const t of Object.values(r.state.tasks)) {
    const owned = r.state.activeLeases.some((l) => l.taskId === t.id && ((r.leaseSeq.get(t.id) ?? -1) >= (r.startSeq.get(t.id) ?? 0) || (l.attemptId === t.attemptId && l.runId === r.starts.get(t.id)?.runId)));
    if (t.status === "leased" && !owned) t.status = "pending";
    if (t.status !== "running" || owned) continue;
    t.status = "failed";
    if (!r.ends.has(t.id)) t.interruption = "attempt ended without a result";
  }
  r.state.usageWaitUntil = r.state.usageWaits.reduce<number | null>((until, wait) =>
    wait.until > context.now && (until === null || wait.until > until) ? wait.until : until, null);
  if (r.state.usageWaitUntil !== null) return;
  const candidates = Object.values(r.state.tasks).filter((t) =>
    (t.status === "pending" || t.status === "failed") && (t.usageWaitUntil === null || t.usageWaitUntil <= context.now)
    && !r.state.activeLeases.some((l) => l.taskId === t.id)
    && t.definition.dependencies.every((id) => {
      const dependency = r.state.tasks[id];
      return dependency !== undefined && isDone(dependency, context.verifyEvidence ?? verifyEvidence);
    }));
  candidates.sort((a, b) => b.definition.priority - a.definition.priority);
  r.state.nextRunnableTaskId = candidates[0]?.id ?? null;
}

/** Rebuilds verified ledger state; dependency completion re-verifies evidence with an injectable reader. */
export function rebuildState(entries: readonly LedgerEntry[], context: RebuildContext): RunState {
  z.number().finite().parse(context.now);
  const r: Replay = {
    state: { tasks: Object.create(null) as Record<string, TaskState>, activeLeases: [], runs: [], lastGreenRevision: null, nextRunnableTaskId: null, usageWaits: [], usageWaitUntil: null },
    leases: new Map(), attempts: new Map(), starts: new Map(), ends: new Map(), leaseSeq: new Map(), startSeq: new Map(),
  };
  for (const e of entries) apply(r, e);
  finishReplay(r, context);
  return r.state;
}
