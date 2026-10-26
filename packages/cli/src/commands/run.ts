import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { projectRoot, resolveProject } from "../config/project.ts";
import { allowsUnattended, runDoctor } from "../doctor/doctor.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { runLoop, type RunLoopOptions, type RunLoopResult } from "../runner/loop.ts";
import { SESSION_PLAN_KINDS, type SessionPlanKind } from "../runner/plan.ts";

export interface RunContext {
  projectId: string;
  projectDir: string;
  jarvisHome: string;
  repoPath: string;
  /** `--plan onboard|sweep`: read that session-owned plan instead of .jarvis/plan.json. */
  planKind?: SessionPlanKind;
}
/** A run ready to start, and what it hosts for its own duration (architecture §3.4). */
export interface PreparedRun {
  loop: RunLoopOptions;
  /** Stops what the run hosts (the broker). Called once the loop returns or throws. */
  close(): Promise<void>;
  /** The finished notification: the loop's result, or undefined when it threw. Never throws. */
  finished(result: RunLoopResult | undefined): Promise<void>;
  /**
   * A run in phases (a review's fixes, then its report update; decision 126): drives the loop itself and
   * returns the last phase's result. Absent: the loop runs once on `loop`.
   */
  drive?(loop: (options: RunLoopOptions) => Promise<RunLoopResult>): Promise<RunLoopResult>;
}
export interface DetachedChild {
  pid?: number | undefined;
  unref(): unknown;
  once(event: string, callback: (error?: Error) => void): unknown;
}
export interface RunCommandOptions {
  jarvisHome?: string;
  cwd?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  output?: (text: string) => void;
  probe?: () => Promise<{ ok: boolean }>;
  /** The composition root supplies checks, plan, the harness factory, the fresh read-only reviewer, the hosted broker and the notifier. */
  prepareRun?: (context: RunContext) => Promise<PreparedRun>;
  /** Test seam for the loop a prepared run drives. */
  runLoop?: (options: RunLoopOptions) => Promise<RunLoopResult>;
  run?: (context: RunContext) => Promise<RunLoopResult>;
  spawn?: (bin: string, args: string[], options: SpawnOptions) => DetachedChild;
  entrypoint?: string;
  /** Keeps the Mac awake while `pid` lives (architecture §3.4). Default: caffeinate -i -w on macOS. */
  keepAwake?: (pid: number) => void;
}

/** `caffeinate -i -w <pid>` by absolute path, so the Mac stays awake exactly as long as the runner lives. */
export function caffeinate(pid: number, platform: NodeJS.Platform = process.platform, spawn: NonNullable<RunCommandOptions["spawn"]> = (bin, args, options) => spawnChild(bin, args, options)): void {
  if (platform !== "darwin") return;
  const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(pid)], { detached: true, stdio: "ignore" });
  child.once("error", () => { /* staying awake is best effort; the run continues */ });
  child.unref();
}

async function detach(context: RunContext, seams: RunCommandOptions): Promise<void> {
  mkdirSync(context.projectDir, { recursive: true, mode: 0o700 });
  const logPath = join(context.projectDir, `runner-${Date.now()}-${process.pid}.log`);
  const fd = openSync(logPath, "wx", 0o600);
  try {
    const entrypoint = seams.entrypoint ?? process.argv[1];
    if (!entrypoint) throw new Error("cannot resolve the CLI entry point");
    const args = [resolve(entrypoint), "run", "--project", context.projectId, ...(context.planKind ? ["--plan", context.planKind] : [])];
    const child = (seams.spawn ?? spawnChild)(process.execPath, args, { cwd: context.repoPath, detached: true, stdio: ["ignore", fd, fd] });
    await new Promise<void>((accept, reject) => {
      child.once("error", reject);
      child.once("spawn", () => child.pid === undefined ? reject(new Error("detached runner has no pid")) : accept());
    });
    child.unref();
    (seams.output ?? console.log)(`Runner pid ${child.pid}; log ${logPath}`);
  } finally { closeSync(fd); }
}

/** Drives the loop; what the run hosts comes down whether it returns or throws, then the finished notice goes out. */
async function hosted(run: PreparedRun, loop: (options: RunLoopOptions) => Promise<RunLoopResult>): Promise<RunLoopResult> {
  let result: RunLoopResult | undefined;
  let failed = false;
  try {
    result = run.drive ? await run.drive(loop) : await loop(run.loop);
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await run.close(); } catch (error) {
      if (!failed) throw error;
      console.error(`Stopping the run's broker also failed: ${error instanceof Error ? error.message : String(error)}`); // the loop's own error wins
    } finally { await run.finished(result); }
  }
}

export function register(program: Command, seams: RunCommandOptions = {}): void {
  program.command("run").description("Run ready tasks through protected checks and independent review")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .option("--plan <kind>", `read a session-owned plan: ${SESSION_PLAN_KINDS.join(" or ")} (.jarvis/<kind>/plan.json)`)
    .option("--detach", "continue in a detached runner")
    .action(async (options: { project?: string; plan?: string; detach?: boolean }) => {
      const cwd = resolve(seams.cwd ?? process.cwd());
      const projectId = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd });
      if (options.plan !== undefined && !(SESSION_PLAN_KINDS as readonly string[]).includes(options.plan)) throw new Error(`--plan must be one of: ${SESSION_PLAN_KINDS.join(", ")}`);
      const jarvisHome = seams.jarvisHome ?? join(homedir(), ".jarvis");
      const context: RunContext = {
        projectId, projectDir: runnerProjectDir(projectId, jarvisHome), jarvisHome, repoPath: projectRoot(cwd),
        ...(options.plan ? { planKind: options.plan as SessionPlanKind } : {}),
      };
      // Both checks come before a detached runner is spawned (Opus review L6).
      if (!seams.run && !seams.prepareRun) throw new Error("run composition is required: provide a harness, protected checks and a fresh read-only reviewer");
      // The live doctor: pinned binaries, clean environment, disk, and the live canary probe.
      const probe = seams.probe ?? (async () => ({ ok: allowsUnattended(await runDoctor({ live: true, repoPath: context.repoPath })) }));
      if (!(await probe()).ok) throw new Error("live canary probe failed; refusing unattended run"); // safety requirement 6
      if (options.detach) return detach(context, seams);
      (seams.keepAwake ?? ((pid) => caffeinate(pid)))(process.pid);
      const result = seams.run ? await seams.run(context) : await hosted(await seams.prepareRun!(context), seams.runLoop ?? runLoop);
      (seams.output ?? console.log)(`Run ${result.status}: ${result.done.length} done, ${result.blocked.length} blocked`);
    });
}
