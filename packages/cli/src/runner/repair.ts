import type { AppendInput, LedgerEntry } from "../ledger/ledger.ts";
import { buildAlternativeSwitch, failureEvidence, repairsUsed, type AlternativeSwitchInput, type EvidenceReader, type EvidenceVerifier, type TaskState } from "./state.ts";

export type RepairEvent = { kind: "usage_wait" | "runner_crash" | "failure" };
export interface RepairOptions {
  criticalPath?: boolean;
  alternative?: Omit<AlternativeSwitchInput, "taskId" | "reason">;
  readEvidence?: EvidenceReader;
  verifyEvidence?: EvidenceVerifier;
}
export type RepairDecision =
  | { kind: "resume" }
  | { kind: "repair"; repairNumber: number; prompt: string }
  | { kind: "blocked"; entry: AppendInput; alternative?: AppendInput };

type Data = Record<string, unknown>;
const dataOf = (entry: LedgerEntry) => entry.data as Data;
const short = (value: unknown, limit = 160) => String(value ?? "").replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, limit);
function currentEvidence(task: TaskState): LedgerEntry[] {
  return task.evidence.filter((e) => e.actor === "runner" && e.task_id === task.id && e.attempt_id === task.attemptId && dataOf(e).revision === task.candidateRevision);
}

function repairPrompt(task: TaskState, count: number, options: RepairOptions): string {
  const evidence = failureEvidence(task, options.readEvidence, options.verifyEvidence);
  const lines = [`Repair ${task.id} (${count}/2). Address the recorded failures, then rerun protected checks and review.`];
  if (evidence) {
    lines.push(`Check ${short(evidence.check)} at ${evidence.revision}`);
    if (!evidence.verified) lines.push("Evidence changed or missing; runner must recapture it before using output.");
    for (const c of evidence.cases.slice(0, 3)) lines.push(`${short(c.id)}: exit ${c.code ?? "signal"}; timed out: ${c.timedOut}`, `stdout tail:\n${c.stdout}`, `stderr tail:\n${c.stderr}`);
    if (evidence.verification) lines.push(`Verification: exit ${evidence.verification.code ?? "signal"}; timed out: ${evidence.verification.timedOut}; completed: ${evidence.verification.completed}`, evidence.verification.stdout, evidence.verification.stderr);
  }
  for (const entry of currentEvidence(task).filter((e) => e.kind === "review_result" && dataOf(e).status === "fail").slice(0, 4)) lines.push(`${short(dataOf(entry).reviewer)}: ${short(dataOf(entry).summary ?? "review failed", 500)}`);
  const buffer = Buffer.from(lines.join("\n"));
  let end = Math.min(buffer.length, 16_384);
  while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function blocked(task: TaskState, reason: string): Extract<RepairDecision, { kind: "blocked" }> {
  return { kind: "blocked", entry: { kind: "blocked", actor: "runner", task_id: task.id, attempt_id: task.attemptId, data: { reason, failedAttempts: repairsUsed(task) } } };
}

/** Pure policy over rebuilt state; append blocked and alternative entries before dispatching a fallback. */
export function decideRepair(task: TaskState, event: RepairEvent, options: RepairOptions = {}): RepairDecision {
  if (event.kind !== "failure") return { kind: "resume" };
  const evidence = currentEvidence(task);
  if (evidence.some((e) => e.kind === "gate_result" && dataOf(e).status === "tampered")) return blocked(task, "protected check changed");
  const completed = task.attempts.find((a) => a.id === task.attemptId)?.outcome === "completed";
  const failures = repairsUsed(task);
  const latest = evidence.filter((e) => (e.kind === "gate_result" || e.kind === "review_result") && dataOf(e).status === "fail").at(-1);
  if (!completed || !latest || failures === 0) return { kind: "resume" };
  if (failures < 3) return { kind: "repair", repairNumber: failures, prompt: repairPrompt(task, failures, options) };
  const reason = latest.kind === "gate_result" ? `Check ${short(dataOf(latest).check)} failed after two repairs` : `Review ${short(dataOf(latest).reviewer)} failed after two repairs`;
  const result = blocked(task, reason);
  if (options.criticalPath && options.alternative && task.alternativeSwitches.length === 0) result.alternative = buildAlternativeSwitch({ taskId: task.id, reason, ...options.alternative });
  return result;
}
