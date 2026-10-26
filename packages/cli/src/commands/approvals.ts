import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pendingApprovalRequests } from "../broker/broker.ts";
import { resolveProject } from "../config/project.ts";
import { LedgerTamperError, verifyLedger, type LedgerEntry, type VerifyResult } from "../ledger/ledger.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { redactReviewText } from "../review/redaction.ts";
import { oneLineSummary } from "./run-approvals.ts";

export interface ApprovalsCommandOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  cwd?: string;
  output?: (text: string) => void;
  verify?: (dir: string) => VerifyResult;
}
/** The snapshot scanner exempts placeholders; terminal output also hides fake-looking URL credentials. */
export function redactApprovalText(text: string): string {
  const urls = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/"<>]+@/gi, "$1[redacted]@");
  return redactReviewText(urls);
}

export interface PendingApproval {
  id: string;
  op: string;
  summary: string;
  payloadHashPrefix: string;
  requestedAt: string;
  taskId: string | null;
  attemptId: string | null;
  sessionId: string | null;
}

/** No writer, lock acquisition, or crash repair: even a missing project is left untouched. */
export function verifiedEntries(projectDir: string, verify = verifyLedger): LedgerEntry[] {
  if (!existsSync(join(projectDir, "ledger.jsonl"))) return [];
  const result = verify(projectDir);
  if (result.contended) throw new Error("Approvals contended: ledger writers are active; try again shortly.");
  if (!result.ok) throw new LedgerTamperError("Approval ledger failed verification; refusing to show or answer requests.");
  return result.entries;
}

export function readApprovalRequests(projectDir: string, project: string, verify = verifyLedger): LedgerEntry[] {
  return pendingApprovalRequests(verifiedEntries(projectDir, verify), project);
}

export function readApprovals(projectDir: string, project: string, verify = verifyLedger): PendingApproval[] {
  return readApprovalRequests(projectDir, project, verify).map((e) => {
    const d = e.data as Record<string, unknown>;
    return { id: String(d.approvalId), op: String(d.op), summary: oneLineSummary(redactApprovalText(String(d.summary ?? ""))),
      payloadHashPrefix: String(d.payloadHash).slice(0, 12), requestedAt: e.ts, taskId: e.task_id, attemptId: e.attempt_id,
      sessionId: typeof d.sessionId === "string" ? d.sessionId : typeof d.session_id === "string" ? d.session_id : null };
  });
}

export function register(program: Command, seams: ApprovalsCommandOptions = {}): void {
  program.command("approvals").description("List pending outside actions from the verified ledger")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)").option("--json", "print JSON")
    .action((options: { project?: string; json?: boolean }) => {
      const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd: seams.cwd ?? process.cwd() });
      const approvals = readApprovals(runnerProjectDir(project, seams.jarvisHome), project, seams.verify);
      const text = options.json ? JSON.stringify(approvals, null, 2) : approvals.length ? approvals.map((a) =>
        `${a.id}  ${a.op}  ${a.summary}\n  Payload: ${a.payloadHashPrefix}  Requested: ${a.requestedAt}  Task: ${a.taskId ?? "unknown"}  Session: ${a.sessionId ?? "unknown"}  Attempt: ${a.attemptId ?? "unknown"}`).join("\n") : "No pending approvals.";
      (seams.output ?? console.log)(text);
    });
}
