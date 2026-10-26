import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hiddenDir } from "./hidden.ts";

/**
 * The pinned Go both arms' sessions get (decision 123): the module cache the task's gate reads,
 * hidden/<task>/gate/fixtures/gomodcache, reopened read-only in place, and its toolchain unpacked per run in
 * ~/.jarvis-work/toolchains/<task>/<run>. The gate itself reads its own installed copy, in the runner folder.
 * Both arms read the same fixture, so the comparison stays fair (decision 47).
 */

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** The gate's module cache for a task. Refused if it leads into the grading checks, which sessions never see (decision 97). */
export function evalGoFixture(evalsRepo: string, taskId: string): string {
  const fixture = join(hiddenDir(evalsRepo, taskId, "gate"), "fixtures", "gomodcache");
  const grading = hiddenDir(evalsRepo, taskId, "checks");
  if (existsSync(fixture) && existsSync(grading)) {
    const f = realpathSync(fixture);
    const g = realpathSync(grading);
    if (under(f, g) || under(g, f)) throw new Error(`refused: the Go fixture sessions read (${f}) overlaps the grading checks; sessions never see them (decision 97)`);
  }
  return fixture;
}

/**
 * Every folder under the work root that a session of any run, or candidate code in a gate, writes: a pinned
 * toolchain may sit in none of them, since baseline and Jarvis runs can run side by side.
 */
export function evalWritableRoots(workRoot: string): string[] {
  return ["evals", "cache-runs", "worktrees", "caches", "checks", "feedback"].map((d) => join(workRoot, d)).filter((d) => existsSync(d)).map((d) => realpathSync(d));
}

/**
 * A run the toolchain stopped before any session (fail closed): summary.json says it never started, and why,
 * so the run isn't counted and the reason stays with it. Rethrows, so the schedule stops there.
 */
export function recordToolchainRefusal(resultsDir: string, summary: Record<string, unknown>, e: unknown): never {
  const reason = e instanceof Error ? e.message : String(e);
  writeFileSync(join(resultsDir, "summary.json"), `${JSON.stringify({ ...summary, started: false, usageLimited: false, toolchain: { status: "refused", reason } }, null, 2)}\n`);
  throw e;
}

/** Where a run's toolchain is unpacked: outside the worktrees, caches and runner folder; removed after the run. */
export function evalToolchainDir(workRoot: string, taskId: string, runId: string): string {
  return join(workRoot, "toolchains", taskId, runId);
}
