import type { BaselineRunResult, GoldenTask } from "./baseline.ts";

/**
 * Runs golden-task baselines one after another (decision 63: one writer under 40 GB free).
 * Usage waits never use up attempts and never skip a task (decisions 3, 62): a usage-limited run
 * or preflight waits for the reset and retries the same task. Anything else that stops the chain
 * is recorded as an explicit incomplete stop.
 */

export interface PreflightResult {
  ok: boolean;
  /** Set when the preflight itself hit a usage limit. */
  waitUntil?: number;
}

export class PreflightError extends Error {
  waitUntil: number | undefined;
  constructor(message: string, waitUntil?: number) {
    super(message);
    this.waitUntil = waitUntil;
  }
}

export interface ScheduleDeps {
  loadTask: (id: string) => GoldenTask;
  runOne: (task: GoldenTask, runId: string) => Promise<BaselineRunResult>;
  sleepUntil: (unixSeconds: number) => Promise<void>;
  nowMs: () => number;
  log: (m: string) => void;
  /** A single wait longer than this stops the chain (default 12 h). */
  maxWaitHours?: number;
  /** Consecutive usage-limited retries of one task before an explicit stop (default 8). */
  maxUsageRetries?: number;
}

export interface ScheduleOutcome {
  completed: { task: string; runId: string }[];
  stopped?: { task: string; reason: string };
}

export async function runSchedule(ids: readonly string[], repeat: number, label: string, deps: ScheduleDeps): Promise<ScheduleOutcome> {
  const completed: ScheduleOutcome["completed"] = [];
  const maxWaitMs = (deps.maxWaitHours ?? 12) * 3600_000;
  const wait = async (task: string, until: number, why: string): Promise<string | undefined> => {
    const ms = until * 1000 + 120_000 - deps.nowMs();
    if (ms > maxWaitMs) return `usage window resets in ${Math.round(ms / 3600_000)} h (${why})`;
    deps.log(`${task}: ${why}; waiting ${Math.max(0, Math.round(ms / 60000))} min for the reset`);
    await deps.sleepUntil(until + 120);
    return undefined;
  };

  for (let i = 1; i <= repeat; i++) {
    for (const id of ids) {
      const task = deps.loadTask(id);
      let usageRetries = 0;
      for (let attempt = 1; ; attempt++) {
        const runId = `baseline-${new Date(deps.nowMs()).toISOString().replace(/[:.]/g, "-")}${label ? `-${label}` : ""}-r${i}-a${attempt}`;
        let r: BaselineRunResult;
        try {
          r = await deps.runOne(task, runId);
        } catch (e) {
          if (e instanceof PreflightError && e.waitUntil !== undefined && usageRetries < (deps.maxUsageRetries ?? 8)) {
            usageRetries++;
            const stop = await wait(id, e.waitUntil, "preflight hit a usage limit");
            if (stop) return { completed, stopped: { task: id, reason: stop } };
            continue;
          }
          const reason = e instanceof PreflightError ? `preflight failed: ${e.message}` : `run error: ${String(e)}`;
          deps.log(`${id}: stopping the chain; ${reason}`);
          return { completed, stopped: { task: id, reason } };
        }
        deps.log(`${id} ${runId}: exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}, ${r.resultSubtype}, ${r.numTurns} turns, ${Math.round(r.durationMs / 60000)} min, ${r.diffStat || "no changes"}`);
        if (r.usageLimited) {
          if (usageRetries >= (deps.maxUsageRetries ?? 8)) return { completed, stopped: { task: id, reason: `still usage-limited after ${usageRetries} waits` } };
          usageRetries++;
          const stop = await wait(id, r.usageWaitUntil ?? Math.floor(deps.nowMs() / 1000) + 3600, "run hit a usage limit; it will be retried");
          if (stop) return { completed, stopped: { task: id, reason: stop } };
          continue; // the same task again; waiting is not a failure
        }
        completed.push({ task: id, runId });
        if (r.usageWaitUntil !== undefined) {
          const stop = await wait(id, r.usageWaitUntil, "usage is high");
          if (stop) return { completed, stopped: { task: ids[ids.indexOf(id) + 1] ?? id, reason: stop } };
        }
        break;
      }
    }
  }
  return { completed };
}
