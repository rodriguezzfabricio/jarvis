import { existsSync, realpathSync } from "node:fs";
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

/** Where a run's toolchain is unpacked: outside the worktrees, caches and runner folder; removed after the run. */
export function evalToolchainDir(workRoot: string, taskId: string, runId: string): string {
  return join(workRoot, "toolchains", taskId, runId);
}
