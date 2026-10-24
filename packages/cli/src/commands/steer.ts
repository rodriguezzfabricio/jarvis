import type { Command } from "commander";
import { runnerProjectDir, submitSteer } from "../runner/inbox.ts";

export interface SteerCommandOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  output?: (text: string) => void;
}

export function register(program: Command, seams: SteerCommandOptions = {}): void {
  program.command("steer").description("Queue a note for the runner between tasks")
    .argument("<note>").option("--project <id>", "project id (or JARVIS_PROJECT)")
    .action((note: string, options: { project?: string }) => {
      const project = options.project ?? (seams.env ?? process.env).JARVIS_PROJECT;
      if (!project) throw new Error("Specify --project <id> or JARVIS_PROJECT");
      const path = submitSteer(runnerProjectDir(project, seams.jarvisHome), note);
      (seams.output ?? console.log)(`Steer note queued: ${path}`);
    });
}
