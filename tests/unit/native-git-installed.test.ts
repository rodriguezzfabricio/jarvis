import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { fixtureGitCommand } from "./helpers/git-template.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function installedGit() {
  const root = shortTmp("jgi-"); roots.push(root);
  const file = fixtureGitCommand();
  const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return (args: string[]) => {
    const child = spawnSync(file, args, { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    if (child.error) throw child.error;
    if (child.signal) throw new Error(`installed Git terminated: ${child.signal}`);
    return child;
  };
}
it("runs the installed Git version and retains its real option-failure semantics", () => {
  const git = installedGit();
  const version = git(["--version"]);
  expect(version.status).toBe(0);
  expect(version.stdout).toMatch(/^git version .+\n$/);
  const failure = git(["--not-a-real-option"]);
  expect(failure.status).toBe(129);
  expect(failure.stdout).toBe("");
  expect(failure.stderr).toContain("unknown option: --not-a-real-option");
});
it("runs installed Git in the caller's folder with an ordinary isolated environment", () => {
  const git = installedGit();
  expect(git(["init", "-q"]).status).toBe(0);
  const result = git(["rev-parse", "--git-dir"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(".git\n");
});
