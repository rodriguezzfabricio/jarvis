import type { Command } from "commander";
import { resolveProject } from "../config/project.ts";
import { runnerProjectDir, submitSteer } from "../runner/inbox.ts";

export interface SteerCommandOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  /** The checkout whose derived project id is used without --project or JARVIS_PROJECT (decision 90). */
  cwd?: string;
  output?: (text: string) => void;
}

export function register(program: Command, seams: SteerCommandOptions = {}): void {
  program.command("steer").description("Queue a note for the runner between tasks")
    .argument("<note>").option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .action((note: string, options: { project?: string }) => {
      const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd: seams.cwd ?? process.cwd() });
      const path = submitSteer(runnerProjectDir(project, seams.jarvisHome), note);
      (seams.output ?? console.log)(`Steer note queued: ${path}`);
    });
}
