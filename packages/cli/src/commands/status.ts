import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LedgerTamperError, verifyLedger, type LedgerEntry, type VerifyResult } from "../ledger/ledger.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { renderReport } from "../runner/report.ts";
import { rebuildState, type RunState } from "../runner/state.ts";

export interface StatusReadOptions { now?: () => number; verify?: (dir: string) => VerifyResult }
export interface StatusCommandOptions extends StatusReadOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  output?: (text: string) => void;
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

export function register(program: Command, seams: StatusCommandOptions = {}): void {
  program.command("status").description("Show the current run rebuilt from its ledger")
    .option("--project <id>", "project id (or JARVIS_PROJECT)")
    .action((options: { project?: string }) => {
      const project = options.project ?? (seams.env ?? process.env).JARVIS_PROJECT;
      if (!project) throw new Error("Specify --project <id> or JARVIS_PROJECT");
      const result = readRunStatus(runnerProjectDir(project, seams.jarvisHome), seams);
      (seams.output ?? console.log)(result.status === "contended" ? result.message : renderReport(result.state, result.entries, [], seams));
    });
}
