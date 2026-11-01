import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Broker } from "../broker/broker.ts";
import type { GateCheck } from "../checks/gate.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { recordReleaseStep, runReleaseStep, type ReleaseRuntime, type ReleaseSeams } from "../release/run.ts";
import type { TaskTier } from "../runner/harness.ts";
import type { RunLoopOptions, RunLoopResult } from "../runner/loop.ts";
import { writeReport, type ReportClaim } from "../runner/report.ts";
import { loadRouting } from "../runner/routing.ts";
import { rebuildState } from "../runner/state.ts";
import type { RunContext } from "./run.ts";

/**
 * `jarvis run` with a release setup (decision 157): the build loop, then the release step once every planned task is
 * done, then REPORT.md again, so the report and the finished notification (run-compose.ts) say what the release
 * reached. A release that can't start or stops says why in the ledger; it never fails the build run.
 */
export interface ReleaseDriveInput {
  loop: RunLoopOptions;
  release: ReleaseRuntime;
  broker: Broker;
  ledger: Ledger;
  context: RunContext;
  checks: readonly GateCheck[];
  git(args: readonly string[]): string;
  runBranch: string;
  home: string;
  workRoot: string;
  worktreeRoot: string;
  tier: TaskTier;
  notify(text: string): Promise<void>;
  seams?: ReleaseSeams;
}

export function releaseDrive(i: ReleaseDriveInput): (run: (options: RunLoopOptions) => Promise<RunLoopResult>) => Promise<RunLoopResult> {
  return async (run) => {
    const result = await run(i.loop);
    try {
      if (result.status !== "complete") recordReleaseStep(i.ledger, randomUUID(), `not started: the run ended with ${result.blocked.length} task(s) blocked`);
      else {
        const routing = loadRouting(i.context.repoPath);
        const harness = i.loop.createHarness?.(routing) ?? i.loop.harness;
        if (!harness) throw new Error("no task harness for the ship session");
        await runReleaseStep({
          runtime: i.release, ledger: i.ledger, broker: i.broker, projectId: i.context.projectId, projectDir: i.context.projectDir, jarvisHome: i.context.jarvisHome,
          repoPath: i.context.repoPath, workRoot: i.workRoot, worktreeRoot: i.worktreeRoot, gitHome: i.home, runBranch: i.runBranch, git: i.git, checks: i.checks,
          harness, routing, tier: i.tier, maxTurns: i.loop.maxTurns ?? 100, timeoutMs: i.loop.taskTimeoutMs ?? 30 * 60_000, notify: i.notify,
          ...(i.seams ? { seams: i.seams } : {}),
        });
      }
    } catch (error) {
      recordReleaseStep(i.ledger, randomUUID(), `stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = i.ledger.entries();
    const claims: ReportClaim[] = entries.filter((e) => e.actor === "runner" && e.kind === "reconciled" && (e.data as { type?: string }).type === "agent_claim")
      .map((e) => ({ taskId: e.task_id ?? "run", text: String((e.data as { text?: unknown }).text), source: String((e.data as { source?: unknown }).source) }));
    writeReport(join(i.context.repoPath, ".jarvis"), rebuildState(entries, { now: Date.now() }), entries, claims);
    return result;
  };
}
