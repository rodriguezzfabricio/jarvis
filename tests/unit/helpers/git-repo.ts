// An empty repository by copy, for tests that make many throwaway repositories. `git init -q -b main` plus
// the two `git config user.*` calls cost about 40 ms of CPU and three process starts; copying the .git
// folder of one repository made that way costs about 5 ms. The result is the same repository: same files,
// same HEAD, same config (the template is made with a clean environment, so no global or system config).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortTmp } from "../../helpers.ts";

export interface RepoOptions {
  /** Also set user.email=t@t and user.name=t, as the tests that run a plain `git commit` do. */
  identity?: boolean;
  /** The branch HEAD points to (default main). */
  branch?: string;
}

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

// One template per kind, made when first needed and removed when this process ends.
const templates = new Map<boolean, string>();
function template(identity: boolean): string {
  let dir = templates.get(identity);
  if (dir === undefined) {
    const made = shortTmp("jgr-");
    buildRepoTemplate(made, identity);
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
    dir = made;
    templates.set(identity, made);
  }
  return dir;
}

/** What `git init -q -b <branch>` (and the two config calls, with `identity`) would leave in `dir`. */
export function initRepo(dir: string, options: RepoOptions = {}): void {
  copyRepoTemplate(template(options.identity === true), dir, options.branch);
}
