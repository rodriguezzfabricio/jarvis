import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifyEvidence } from "../checks/gate.ts";
import { atomicWrite, GENESIS, type LedgerEntry } from "../ledger/ledger.ts";
import { footprintReportLines } from "./footprint.ts";
import { inboxIssues } from "./inbox.ts";
import { usageReportLines } from "./usage-log.ts";
import { isDone, type EvidenceVerifier, type RunState, type TaskState } from "./state.ts";

export interface ReportClaim { taskId: string; source: string; text: string }
export interface ReportOptions {
  now?: () => number;
  locale?: string;
  timeZone?: string;
  verifyEvidence?: EvidenceVerifier;
}
type Data = Record<string, unknown>;
const dataOf = (entry: LedgerEntry): Data => entry.data && typeof entry.data === "object" ? entry.data as Data : {};
const line = (value: unknown): string => String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/[<>`*_[\]\\]/g, "\\$&");
const runnerAuthored = (entry: LedgerEntry): boolean => entry.actor === "runner";
const orNone = (lines: string[]) => lines.length ? lines : ["- None."];

function releaseEntry(entries: readonly LedgerEntry[]): LedgerEntry | undefined {
  return entries.filter(runnerAuthored).filter((e) => e.kind === "state_reached" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(dataOf(e).revision))
    && ["preview-ready", "release-ready", "deployed"].includes(String(dataOf(e).state))).at(-1);
}

function shownEvidence(task: TaskState): LedgerEntry[] {
  const entries = task.evidence.filter(runnerAuthored).filter((e) => e.task_id === task.id && e.attempt_id === task.attemptId && dataOf(e).revision === task.candidateRevision);
  const gates = task.definition.requiredChecks.map((name) => entries.filter((e) => e.kind === "gate_result" && dataOf(e).check === name).at(-1));
  const reviews = task.definition.requiredReviews.map((name) => entries.filter((e) => e.kind === "review_result" && dataOf(e).reviewer === name).at(-1));
  return [...gates, ...reviews].filter((e) => e !== undefined);
}

function evidenceLine(entry: LedgerEntry): string {
  const data = dataOf(entry);
  if (entry.kind === "review_result") return `  - #${entry.seq} Review ${line(data.reviewer)}: ${line(data.status)}`;
  const evidence = data.evidence as { dir: string; files: Record<string, string> };
  const hashes = Object.entries(evidence.files).map(([name, hash]) => `${line(name)} SHA-256 ${line(hash)}`).join("; ");
  return `  - #${entry.seq} Check ${line(data.check)}: ${line(evidence.dir)}; ${hashes}`;
}

function activeDecisions(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const decisions = entries.filter(runnerAuthored).filter((e) => e.kind === "decision");
  return decisions.filter((e) => dataOf(e).status !== "superseded" && (dataOf(e).status as { kind?: string } | null)?.kind !== "superseded" && !decisions.some((later) => later.seq > e.seq
    && [String(e.seq), String(dataOf(e).id ?? e.seq)].includes(String(dataOf(later).supersedes))));
}

function defaultsConfirmed(entry: LedgerEntry, entries: readonly LedgerEntry[]): boolean {
  const data = dataOf(entry);
  return entries.some((e) => {
    const answer = dataOf(e);
    const matches = typeof data.requestId === "string" && data.requestId.length > 0
      ? answer.requestId === data.requestId : data.round !== undefined && answer.round === data.round;
    return runnerAuthored(e) && e.kind === "decision" && e.seq > entry.seq && answer.source === "notify"
      && answer.acceptedDefaults === true && answer.confirmed === true && matches;
  });
}

function attention(entries: readonly LedgerEntry[]): string[] {
  const lines: string[] = [];
  const latestSpec = entries.filter(runnerAuthored).filter((e) => e.kind === "spec_version").at(-1);
  for (const entry of [...activeDecisions(entries), ...(latestSpec ? [latestSpec] : [])]) {
    const data = dataOf(entry);
    const classification = String(data.class ?? "").toLowerCase();
    const unconfirmed = (data.madeBy === "unconfirmed-default" || data.maker === "unconfirmed-default" || data.status === "unconfirmed"
      || (data.source === "intake" && data.by === "default-unconfirmed" && data.confirmed === false)) && !defaultsConfirmed(entry, entries);
    if (unconfirmed) lines.push(`- Unconfirmed #${entry.seq}: ${line(data.decision ?? data.choice ?? data.answer ?? `Spec ${String(data.version ?? "")}`)}`);
    if (["taste", "challenge"].includes(classification)) lines.push(`- ${classification === "taste" ? "Taste" : "Challenge"} #${entry.seq}: ${line(data.decision ?? data.choice)}. ${line(data.why)} Depends on: ${line(Array.isArray(data.dependsOn) ? data.dependsOn.join(", ") : data.dependsOn)}`);
  }
  return lines;
}

function outsideUnknowns(entries: readonly LedgerEntry[]): string[] {
  return entries.filter((e) => e.kind === "broker_receipt" && dataOf(e).status === "unknown"
    && !entries.some((r) => runnerAuthored(r) && r.seq > e.seq && r.kind === "reconciled" && dataOf(r).executionSeq === dataOf(e).executionSeq
      && ["succeeded", "failed"].includes(String(dataOf(r).outcome))))
    .map((e) => `- #${e.seq} ${line(dataOf(e).op)}: unknown outcome; reconcile before any retry (execution #${line(dataOf(e).executionSeq)}).`);
}

function usageWaits(entries: readonly LedgerEntry[], options: ReportOptions): string[] {
  const now = (options.now ?? Date.now)();
  return entries.filter(runnerAuthored).filter((e) => e.kind === "usage_wait").map((e) => {
    const data = dataOf(e);
    const until = typeof data.until === "number" && Number.isFinite(data.until) ? data.until : NaN;
    const start = Date.parse(e.ts);
    const recorded = typeof data.waitMs === "number" && Number.isFinite(data.waitMs) ? data.waitMs : data.durationMs;
    const length = typeof recorded === "number" && Number.isFinite(recorded) ? recorded : until - (Number.isFinite(start) ? start : now);
    const local = Number.isFinite(until) ? new Date(until).toLocaleString(options.locale, options.timeZone ? { timeZone: options.timeZone } : {}) : "unknown reset";
    return `- #${e.seq} Until ${line(local)}; wait ${Number.isFinite(length) ? Math.max(0, Math.ceil(length / 60_000)) : "unknown"} min${typeof data.tokens === "number" ? `; tokens ${data.tokens}` : ""}.`;
  });
}

function taskLines(state: RunState, entries: readonly LedgerEntry[], verify: EvidenceVerifier): { done: string[]; left: string[]; blocked: string[] } {
  const result = { done: [] as string[], left: [] as string[], blocked: [] as string[] };
  const done = new Map(Object.values(state.tasks).map((task) => [task.id, isDone(task, verify)]));
  for (const task of Object.values(state.tasks)) {
    if (done.get(task.id)) result.done.push(`- ${line(task.id)}: ${line(task.definition.title)} at ${line(task.candidateRevision)}`, ...shownEvidence(task).map(evidenceLine));
    else if (task.status === "passed") result.left.push(`- Unverified completion: ${line(task.id)} — evidence changed or missing, or required checks/reviews absent.`);
    else if (task.status === "blocked") {
      const blocked = entries.filter(runnerAuthored).filter((e) => e.task_id === task.id && e.kind === "blocked").at(-1);
      result.blocked.push(`- ${line(task.id)}: ${line(task.blockedReason ?? (blocked ? dataOf(blocked).reason : "No reason recorded"))}`);
    } else {
      const dependencies = task.definition.dependencies.filter((id) => !done.get(id));
      result.left.push(`- ${line(task.id)}: ${line(task.definition.title)} (${task.status}). ${dependencies.length ? `Waiting on ${dependencies.map(line).join(", ")}` : line(task.interruption ?? "Not completed")}`);
    }
  }
  return result;
}

/** RunState owns completion; every rendering re-verifies its required evidence files. */
export function renderReport(state: RunState, entries: readonly LedgerEntry[], claims: readonly ReportClaim[] = [], options: ReportOptions = {}): string {
  const release = releaseEntry(entries);
  const tasks = taskLines(state, entries, options.verifyEvidence ?? verifyEvidence);
  const lines = ["# Jarvis report", "", `State: ${release ? line(dataOf(release).state) : "not-reached"}`];
  if (release) lines.push(`Revision: ${line(dataOf(release).revision)} (#${release.seq})`, `Open/run: ${line(dataOf(release).open ?? "No instructions recorded")}`);
  lines.push(`Ledger head: ${entries.at(-1)?.hash ?? GENESIS}`, "", "## Check first", "", ...orNone(attention(entries)), "", "## Done", "", ...orNone(tasks.done));
  lines.push("", "## Blocked / reconciliation", "", ...orNone([...tasks.blocked, ...outsideUnknowns(entries)]));
  lines.push("", "## Skipped inbox items", "", ...orNone(inboxIssues(entries).map((issue) => `- ${line(issue.id)}: ${line(issue.reason)}`)));
  lines.push("", "## Usage waits", "", ...orNone(usageWaits(entries, options)), "", "## Left", "", ...orNone(tasks.left));
  lines.push("", ...usageReportLines(entries), "", ...footprintReportLines(entries));
  if (claims.length) lines.push("", "## Agent claims", "", ...claims.map((claim) => `- Claim (unverified), ${line(claim.taskId)}, ${line(claim.source)}: ${line(claim.text.slice(0, 2000))}`));
  lines.push("", 'Reply here to steer, or run jarvis steer --project <id> "<note>".', "");
  return lines.join("\n");
}

export function notifierSummary(state: RunState, entries: readonly LedgerEntry[], options: ReportOptions = {}): string {
  const release = releaseEntry(entries);
  const tasks = Object.values(state.tasks);
  const done = tasks.filter((task) => isDone(task, options.verifyEvidence ?? verifyEvidence)).length;
  const taste = activeDecisions(entries).filter((e) => String(dataOf(e).class).toLowerCase() === "taste").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  return `${release ? String(dataOf(release).state) : "not-reached"}. ${done}/${tasks.length} done; ${taste} Taste decisions to check; ${blocked} blocked. Reply here to steer.`;
}

/** viewDir is the repo's .jarvis folder. Unique staging avoids a planted temporary-file symlink. */
export function writeReport(viewDir: string, state: RunState, entries: readonly LedgerEntry[], claims: readonly ReportClaim[] = [], options: ReportOptions = {}): string {
  mkdirSync(viewDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(viewDir).isDirectory() || lstatSync(viewDir).isSymbolicLink()) throw new Error("report directory must be a real directory");
  const staging = mkdtempSync(join(viewDir, ".report-"));
  const path = join(viewDir, "REPORT.md");
  try {
    const staged = join(staging, "REPORT.md");
    atomicWrite(staged, renderReport(state, entries, claims, options));
    renameSync(staged, path);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return path;
}
