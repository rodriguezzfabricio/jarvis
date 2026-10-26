// Shared fixture for the runner worktree tests (tests/unit/runner-worktrees-*.test.ts). Each test file
// gets its own `root` (this module is evaluated once per test file) and removes it in its own afterAll.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../../../packages/cli/src/eval/git.ts";
import { shortTmp } from "../../helpers.ts";

export const root = shortTmp("jrw-");
export const git = (cwd: string, ...args: string[]) => safeGit(cwd, args, { home: root }).toString().trim();
/** The number of projects made so far in this file; tests use it to name per-test folders (a live binding). */
export let n = 0;
export function project() {
  const repoPath = join(root, `repo${++n}`);
  mkdirSync(repoPath);
  git(repoPath, "init", "-q", "-b", "run");
  writeFileSync(join(repoPath, "value"), "base");
  writeFileSync(join(repoPath, ".gitignore"), ".jarvis/\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-qm", "base");
  const baseRevision = git(repoPath, "rev-parse", "HEAD");
  const options = { repoPath, projectId: `p${n}`, taskId: "task", attemptId: "a1", baseRevision, worktreeRoot: join(root, "worktrees"), home: root };
  return { repoPath, baseRevision, options };
}
