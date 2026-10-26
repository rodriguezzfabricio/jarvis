// An empty repository by copy, for tests that make many throwaway repositories. `git init -q -b main` plus
// the two `git config user.*` calls cost about 40 ms of CPU and three process starts; copying the .git
// folder of one repository made that way costs about 5 ms. The result is the same repository: same files,
// same HEAD, same config (the template is made with a clean environment, so no global or system config).
// This module has no Vitest import, so a worker thread can use it; test files use initRepo (git-repo.ts).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Builds a template repository in `dir` (which must exist and be empty). */
export function buildRepoTemplate(dir: string, identity: boolean): void {
  const env = { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env });
  git("init", "-q", "-b", "main");
  if (identity) {
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
  }
}

/** Makes `dir` (created if missing) a repository by copying the template's .git. */
export function copyRepoTemplate(template: string, dir: string, branch = "main"): void {
  mkdirSync(dir, { recursive: true });
  cpSync(join(template, ".git"), join(dir, ".git"), { recursive: true });
  if (branch !== "main") writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}
