import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { pinnedClaudeBin } from "../config/pins.ts";
import { runCanaryProbe } from "../harness/claude/index.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { runLoop, type RunLoopOptions, type RunLoopResult } from "../runner/loop.ts";

export interface RunContext { projectId: string; projectDir: string; jarvisHome: string; repoPath: string }
export interface DetachedChild {
  pid: number | undefined;
  unref(): unknown;
  once(event: string, callback: (error?: Error) => void): unknown;
}
export interface RunCommandOptions {
  jarvisHome?: string;
  cwd?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  output?: (text: string) => void;
  probe?: () => Promise<{ ok: boolean }>;
  /** The composition root supplies planning, the harness factory and the fresh read-only reviewer. */
  prepareRun?: (context: RunContext) => Promise<RunLoopOptions>;
  run?: (context: RunContext) => Promise<RunLoopResult>;
  spawn?: (bin: string, args: string[], options: SpawnOptions) => DetachedChild;
  entrypoint?: string;
}

async function detach(context: RunContext, seams: RunCommandOptions): Promise<void> {
  mkdirSync(context.projectDir, { recursive: true, mode: 0o700 });
  const logPath = join(context.projectDir, `runner-${Date.now()}-${process.pid}.log`);
  const fd = openSync(logPath, "wx", 0o600);
  try {
    const entrypoint = seams.entrypoint ?? process.argv[1];
    if (!entrypoint) throw new Error("cannot resolve the CLI entry point");
    const child = (seams.spawn ?? spawnChild)(process.execPath, [resolve(entrypoint), "run", "--project", context.projectId], {
      cwd: context.repoPath, detached: true, stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((accept, reject) => {
      child.once("error", reject);
      child.once("spawn", () => child.pid === undefined ? reject(new Error("detached runner has no pid")) : accept());
    });
    child.unref();
    (seams.output ?? console.log)(`Runner pid ${child.pid}; log ${logPath}`);
  } finally { closeSync(fd); }
}

export function register(program: Command, seams: RunCommandOptions = {}): void {
  program.command("run").description("Run ready tasks through protected checks and independent review")
    .option("--project <id>", "project id (or JARVIS_PROJECT)").option("--detach", "continue in a detached runner")
    .action(async (options: { project?: string; detach?: boolean }) => {
      const projectId = options.project ?? (seams.env ?? process.env).JARVIS_PROJECT;
      if (!projectId) throw new Error("Specify --project <id> or JARVIS_PROJECT");
      const jarvisHome = seams.jarvisHome ?? join(homedir(), ".jarvis");
      const context = { projectId, projectDir: runnerProjectDir(projectId, jarvisHome), jarvisHome, repoPath: resolve(seams.cwd ?? process.cwd()) };
      const probe = seams.probe ?? (() => runCanaryProbe({ claudeBin: pinnedClaudeBin(homedir()) }));
      if (!(await probe()).ok) throw new Error("live canary probe failed; refusing unattended run");
      if (options.detach) return detach(context, seams);
      if (!seams.run && !seams.prepareRun) throw new Error("run composition is required: provide a harness, protected checks and a fresh read-only reviewer");
      const result = seams.run ? await seams.run(context) : await runLoop(await seams.prepareRun!(context));
      (seams.output ?? console.log)(`Run ${result.status}: ${result.done.length} done, ${result.blocked.length} blocked`);
    });
}
