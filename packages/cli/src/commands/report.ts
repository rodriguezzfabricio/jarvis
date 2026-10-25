import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { projectId, projectRoot, resolveProject } from "../config/project.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { writeReport } from "../runner/report.ts";
import { readRunStatus, type StatusReadOptions } from "./status.ts";

export interface ReportCommandOptions extends StatusReadOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  /** The checkout whose .jarvis folder gets REPORT.md, and whose derived project id is the default (decision 90). */
  cwd?: string;
  output?: (text: string) => void;
  /** Opens the written report; /usr/bin/open by absolute path, never through PATH. */
  open?: (path: string) => void;
  exit?: (code: number) => void;
}

export function register(program: Command, seams: ReportCommandOptions = {}): void {
  program.command("report").description("Rebuild .jarvis/REPORT.md from the ledger (read-only on the ledger); --open opens it")
    .option("--open", "open the report after writing it")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .action((options: { open?: boolean; project?: string }) => {
      const cwd = seams.cwd ?? process.cwd();
      const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd });
      const repo = projectRoot(cwd);
      if (projectId(repo) !== project) throw new Error(`Project ${project} is not this repo (${projectId(repo)}); run jarvis report from that project's repo.`);
      const out = seams.output ?? console.log;
      // readRunStatus verifies the chain without a writer or its lock; a tampered ledger throws here.
      const result = readRunStatus(runnerProjectDir(project, seams.jarvisHome), seams);
      if (result.status === "contended") {
        out(`${result.message} REPORT.md was not rebuilt.`);
        (seams.exit ?? ((code) => { process.exitCode = code; }))(1);
        return;
      }
      const path = writeReport(join(repo, ".jarvis"), result.state, result.entries, [], seams);
      out(`Report rebuilt from the ledger: ${path}`);
      if (options.open) (seams.open ?? ((p) => { execFileSync("/usr/bin/open", [p], { stdio: "ignore" }); }))(path);
    });
}
