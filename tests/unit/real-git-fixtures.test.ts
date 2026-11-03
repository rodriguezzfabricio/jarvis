import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { buildRepoTemplate, copyRepoTemplate } from "./helpers/git-template.ts";
import { initRepo } from "./helpers/git-repo.ts";
import { runnerGitEnv, safeGit } from "../../packages/cli/src/eval/git.ts";

const root = shortTmp("jgf-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function dir() { const path = join(root, String(++n)); mkdirSync(path); return path; }
function tree(root: string, rel = ""): unknown[] {
  return readdirSync(join(root, rel)).sort().flatMap(name => {
    const path = join(rel, name), stat = lstatSync(join(root, path));
    return stat.isDirectory() ? [[path, "dir", stat.mode & 0o777], ...tree(root, path)]
      : [[path, "file", stat.mode & 0o777, readFileSync(join(root, path)).toString("base64")]];
  });
}
it.each([false, true])("template copies preserve native git init files, modes and identity=%s", identity => {
  const template = dir(); buildRepoTemplate(template, identity);
  for (const branch of ["main", "run", "master"]) {
    const direct = dir(), copied = dir();
    const env = { PATH: "/usr/bin:/bin", HOME: direct, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q", "-b", branch], { cwd: direct, env });
    if (identity) {
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: direct, env });
      execFileSync("git", ["config", "user.name", "t"], { cwd: direct, env });
    }
    copyRepoTemplate(template, copied, branch);
    expect(tree(join(copied, ".git")), branch).toEqual(tree(join(direct, ".git")));
  }
});
it("initRepo copies isolate edits from other repositories and future fixtures", () => {
  const first = dir(), second = dir(), third = dir();
  initRepo(first, { identity: true, branch: "run" });
  initRepo(second, { identity: true });
  const before = tree(join(second, ".git"));
  writeFileSync(join(first, ".git", "config"), "broken\n");
  writeFileSync(join(first, ".git", "HEAD"), "broken\n");
  writeFileSync(join(first, ".git", "hooks", "pre-commit"), "broken\n");
  initRepo(third, { identity: true });
  expect(tree(join(second, ".git"))).toEqual(before);
  expect(tree(join(third, ".git"))).toEqual(before);
});
it.each(["hook", "fsmonitor", "global config"])("native safeGit refuses a planted %s in a copied fixture", kind => {
  const repo = dir(), home = dir(), marker = join(repo, "executed"), script = join(repo, "planted");
  initRepo(repo, { identity: true });
  const payload = `#!/bin/sh\nprintf executed > '${marker}'\n`;
  writeFileSync(script, payload, { mode: 0o755 });
  let args: string[];
  if (kind === "hook") {
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), payload, { mode: 0o755 });
    args = ["commit", "--allow-empty", "-qm", "fixture"];
  } else if (kind === "fsmonitor") {
    safeGit(repo, ["config", "core.fsmonitor", script], { home });
    args = ["status", "--porcelain"];
  } else {
    writeFileSync(join(home, ".gitconfig"), `[alias]\n planted = !${script}\n`);
    args = ["planted"];
  }
  if (kind === "global config") expect(() => safeGit(repo, args, { home })).toThrow(/not a git command/);
  else safeGit(repo, args, { home });
  expect(existsSync(marker)).toBe(false);
  // Positive fault control: the planted command really executes without the runner's restrictions.
  const env = { ...runnerGitEnv(home) };
  if (kind === "global config") delete env.GIT_CONFIG_GLOBAL;
  execFileSync("git", args, { cwd: repo, env });
  expect(readFileSync(marker, "utf8")).toBe("executed");
});
