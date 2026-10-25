// Process handling for the mutation check (Codex review of the subset mutation check, 2-4). Each
// suite runs as its own process group, so a timeout or a signal stops all of it: TERM, a bounded
// wait, then KILL. A descendant that left the group can't hold a run open by keeping its pipes.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** The running groups, each with its stop(). */
export const active = new Set();

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone, or never started
  }
}

/** Resolves true once the group's leader has exited, false after `ms`. */
function exited(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    child.once("exit", onExit);
  });
}

/**
 * Runs `cmd` in a new process group with spawnSync's old limits (15 minutes, 1 MB per output
 * stream) and resolves with spawnSync's { status, signal, error? }. It never rejects.
 */
export function runGroup(cmd, args, { cwd, env, timeoutMs = 900_000, graceMs = 10_000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const proc = { status: null, signal: null };
    const child = spawn(cmd, args, { cwd, env, detached: true });
    let settled = false;
    let stopping;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(entry);
      resolve(proc);
    };
    const done = new Promise((r) => child.once("close", r).once("error", r));
    const stop = (error) => {
      if (error) proc.error ??= error;
      stopping ??= (async () => {
        signalGroup(child, "SIGTERM");
        await exited(child, graceMs);
        signalGroup(child, "SIGKILL");
        await exited(child, graceMs);
        // A descendant outside the group may still hold the pipes: stop reading them, don't wait on it.
        child.stdout?.destroy();
        child.stderr?.destroy();
        await Promise.race([done, new Promise((r) => setTimeout(r, graceMs))]);
        if (!settled) {
          proc.status = child.exitCode;
          proc.signal = child.signalCode;
          finish();
        }
      })();
      return stopping;
    };
    const entry = { stop };
    active.add(entry);
    const timer = setTimeout(() => stop(new Error(`spawnSync ${cmd} ETIMEDOUT`)), timeoutMs);
    child.stdin?.end();
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      stream?.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) stop(new Error(`spawnSync ${cmd} ENOBUFS`));
      });
    }
    child.on("error", (error) => {
      proc.error ??= error;
      finish();
    });
    child.on("close", (status, signal) => {
      proc.status = status;
      proc.signal = signal;
      finish();
    });
  });
}

/** The mutation check's own settings: they configure this run, never the suites it starts. */
const OWN = ["JARVIS_MUTATIONS", "JARVIS_MUTATION_CONFIRM", "JARVIS_MUTATION_JOBS"];

/**
 * The environment for a suite: the caller's, minus the mutation check's own settings, plus `extra`.
 * A filtered run must not hand JARVIS_MUTATIONS to tests that refuse it (review-run's tests did).
 */
export function suiteEnv(env, extra = {}) {
  const out = { ...env };
  for (const k of OWN) delete out[k];
  return { ...out, ...extra };
}

/** Stops every running group (TERM, then KILL after its grace period) and waits until each run has ended. */
export async function stopAll() {
  await Promise.all([...active].map((e) => e.stop()));
}

/**
 * runGroup, then reads the run's JSON report and run-end record. A malformed file rejects the
 * returned promise (an async function, never a throw inside a process callback).
 */
export async function runAndRead(cmd, args, options, { report, end }) {
  const proc = await runGroup(cmd, args, options);
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);
  return { proc, report: read(report), runEnd: read(end) };
}

/**
 * Runs fn(worker, item, index) over `items`, one item at a time per worker. On the first failure it
 * calls onError, takes no new items, waits for every running item to finish, then rejects. Once
 * stopped() is true it takes no new items and resolves with what finished.
 */
export async function runPool(items, workers, fn, { onError = async () => {}, stopped = () => false } = {}) {
  const out = new Array(items.length);
  let next = 0;
  let failure;
  await Promise.all(
    workers.map(async (worker) => {
      while (!failure && !stopped() && next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(worker, items[i], i);
        } catch (err) {
          if (failure) continue;
          failure = { err };
          await onError(err);
        }
      }
    }),
  );
  if (failure) throw failure.err;
  return out;
}

/**
 * How many jobs run and what each Vitest gets. One job keeps Vitest's default (cpus - 1 workers).
 * More jobs split that budget and are capped by it, so no test runs under more load than in one
 * full-suite run (decision 81, rule 3).
 */
export function jobPlan(requested, cpus) {
  const budget = Math.max(1, cpus - 1);
  const jobs = Math.min(requested, budget);
  return { jobs, flags: jobs > 1 ? [`--maxWorkers=${Math.floor(budget / jobs)}`] : [] };
}
