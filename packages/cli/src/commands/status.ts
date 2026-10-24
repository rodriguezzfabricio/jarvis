import type { Command } from "commander";
import { resolveProject } from "../config/project.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LedgerTamperError, verifyLedger, type LedgerEntry, type VerifyResult } from "../ledger/ledger.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { renderReport } from "../runner/report.ts";
import { failureEvidence, rebuildState, type FailureEvidence, type RunState } from "../runner/state.ts";

export interface StatusReadOptions { now?: () => number; verify?: (dir: string) => VerifyResult }
export interface StatusCommandOptions extends StatusReadOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  /** The checkout whose derived project id is used without --project or JARVIS_PROJECT (decision 90). */
  cwd?: string;
  output?: (text: string) => void;
  exit?: (code: number) => void;
}
export type RunStatus = { status: "ready"; state: RunState; entries: LedgerEntry[] } | { status: "contended"; message: string };

/** Read-only: never opens a ledger writer or takes its lock to resolve contention. */
export function readRunStatus(projectDir: string, options: StatusReadOptions = {}): RunStatus {
  if (!existsSync(join(projectDir, "ledger.jsonl"))) throw new Error("No run ledger for this project");
  const verified = (options.verify ?? verifyLedger)(projectDir);
  if (verified.contended) return { status: "contended", message: "Run status contended: ledger writers are active; try again shortly." };
  if (!verified.ok) throw new LedgerTamperError(`Cannot read status: ${verified.problems.join("; ")}`);
  return { status: "ready", state: rebuildState(verified.entries, { now: (options.now ?? Date.now)() }), entries: verified.entries };
}

/** The entry kinds the compound skill learns from. */
export const COMPOUND_KINDS = ["steer", "review_result", "gate_result", "blocked", "reconciled"] as const;

/** Verified entries compound needs, the rebuilt state, and each task's repair failure output (re-verified, bounded). */
export function statusJson(result: Extract<RunStatus, { status: "ready" }>): { status: "ready"; state: RunState; entries: LedgerEntry[]; failures: Record<string, FailureEvidence> } {
  const failures: Record<string, FailureEvidence> = Object.create(null) as Record<string, FailureEvidence>;
  for (const task of Object.values(result.state.tasks)) {
    const failure = failureEvidence(task);
    if (failure) failures[task.id] = failure;
  }
  const kinds: readonly string[] = COMPOUND_KINDS;
  return { status: "ready", state: result.state, entries: result.entries.filter((e) => kinds.includes(e.kind)), failures };
}

export function register(program: Command, seams: StatusCommandOptions = {}): void {
  program.command("status").description("Show the current run rebuilt from its ledger; --json prints the entries compound needs, the state and failure output")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)").option("--json", "print JSON")
    .action((options: { project?: string; json?: boolean }) => {
      const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd: seams.cwd ?? process.cwd() });
      const result = readRunStatus(runnerProjectDir(project, seams.jarvisHome), seams);
      const out = seams.output ?? console.log;
      if (!options.json) { out(result.status === "contended" ? result.message : renderReport(result.state, result.entries, [], seams)); return; }
      if (result.status === "contended") {
        out(JSON.stringify(result));
        (seams.exit ?? ((code) => { process.exitCode = code; }))(1);
        return;
      }
      out(JSON.stringify(statusJson(result), null, 2));
    });
}
