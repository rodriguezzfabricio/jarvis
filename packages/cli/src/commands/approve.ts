import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Broker, pendingApprovalRequests } from "../broker/broker.ts";
import { resolveProject } from "../config/project.ts";
import { Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { oneLineSummary } from "./run-approvals.ts";
import { redactApprovalText, verifiedEntries, type ApprovalsCommandOptions } from "./approvals.ts";

export interface ApproveCommandOptions extends ApprovalsCommandOptions {
  isTTY?: () => boolean;
  confirm?: (prompt: string) => Promise<string>;
  by?: string;
}

/** Redact leaf values before formatting, retaining the action's structure. Never alter the approved payload. */
function redactPayload(value: unknown, key = ""): unknown {
  if (/(?:password|passwd|secret|token|authorization|credential|api.?key|private.?key|cookie)/i.test(key)) return "[redacted]";
  if (typeof value === "string") return redactApprovalText(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  if (Array.isArray(value)) return value.map((v) => redactPayload(v));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactPayload(v, k)]));
  return value;
}

export function formatApproval(request: LedgerEntry): string {
  const d = request.data as Record<string, unknown>;
  return `Action: ${oneLineSummary(d.op)}\nSummary: ${oneLineSummary(redactApprovalText(String(d.summary ?? "")))}\nPayload:\n${JSON.stringify(redactPayload(d.payload), null, 2)}\nPayload hash: ${String(d.payloadHash)}`;
}

async function confirm(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try { return await reader.question(prompt); } finally { reader.close(); }
}

export function register(program: Command, seams: ApproveCommandOptions = {}): void {
  for (const decision of ["approve", "reject"] as const) {
    program.command(decision).description(`${decision === "approve" ? "Approve" : "Reject"} a pending outside action after showing it`)
      .argument("<approval-id>").option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
      .option("--yes", "confirm the displayed action without prompting")
      .action(async (id: string, options: { project?: string; yes?: boolean }) => {
        const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd: seams.cwd ?? process.cwd() });
        const dir = runnerProjectDir(project, seams.jarvisHome);
        const entries = verifiedEntries(dir, seams.verify);
        const request = pendingApprovalRequests(entries, project).find((e) => (e.data as { approvalId: string }).approvalId === id);
        if (!request) {
          const answer = entries.find((e) => e.kind === "approval" && (e.data as { approvalId?: unknown }).approvalId === id);
          if (answer) throw new Error(`Approval ${id} was already answered: ${String((answer.data as { decision?: unknown }).decision)}.`);
          throw new Error(`No pending approval ${id} in project ${project}.`);
        }
        const out = seams.output ?? console.log;
        out(formatApproval(request));
        if (!options.yes) {
          if (!(seams.isTTY ?? (() => stdin.isTTY === true))()) throw new Error(`Non-interactive ${decision} requires --yes.`);
          const answer = await (seams.confirm ?? confirm)(`${decision === "approve" ? "Approve" : "Reject"}? [y/N] `);
          if (!/^(y|yes)$/i.test(answer.trim())) { out("No decision recorded."); return; }
        }
        const broker = new Broker({ ledger: Ledger.open(dir), project, adapters: [], secrets: { get: () => undefined } });
        broker.decide(id, decision, seams.by ?? `${process.env.USER ?? "user"} (terminal)`);
        out(`${decision === "approve" ? "Approved" : "Rejected"} ${id}.`);
      });
  }
}
