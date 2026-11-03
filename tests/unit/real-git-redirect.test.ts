import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import type { TestProject } from "vitest/node";
import setup from "../setup/real-git-global.ts";
import { shortTmp } from "../helpers.ts";
import { nativeGitApis, faultBatches, runNativeGitProbe } from "./helpers/native-git-test.ts";

// Decision 137 replaces the redirect with native execution. These assertions run even without Xcode.
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = shortTmp("jgr-"); dirs.push(dir); return dir; };
const clean = (home: string) => ({ PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const selected of faultBatches) it.each(nativeGitApis)(`detects %s interception: ${selected.join(", ")}`, api => {
  const result = runNativeGitProbe(api, temp(), "faults", selected);
  expect(result.controls).toBeDefined();
  for (const [name, value] of Object.entries(result.controls)) {
    if (name === "unchanged") expect(value.configured).toEqual(value.native);
    else expect(value.configured, name).not.toEqual(value.native);
  }
});
async function spawned(file: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
  const child = spawn(file, args, { stdio: "ignore", ...options });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect(code).toBe(0);
  return { file: child.spawnfile, line: child.spawnargs.join(" ") };
}
function environment(bin: string, home: string, extra: Record<string, string> = {}) {
  return execFileSync(bin, ["-c", "alias.e=!env", "e"], { cwd: home, env: { ...clean(home), ...extra }, encoding: "utf8" })
    .split("\n").filter(line => line !== "" && !line.startsWith("_=")).sort();
}
describe("native git execution in the suite (decision 137)", () => {
  it("leaves bare, missing-PATH, absolute and shell commands to Node", async () => {
    const home = temp();
    expect((await spawned("git", ["--version"], { env: clean(home) })).file).toBe("git");
    expect((await spawned("git", ["--version"], { env: { HOME: home } })).file).toBe("git");
    expect((await spawned("/usr/bin/git", ["--version"], { env: clean(home) })).file).toBe("/usr/bin/git");
    expect((await spawned("git", ["--version"], { env: clean(home), shell: true })).line).toMatch(/-c git --version$/);
  });
  it("leaves a different git first on PATH alone and executes it", async () => {
    const home = temp(), bin = join(home, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho fake-git-ran\n"); chmodSync(join(bin, "git"), 0o755);
    const env = { ...clean(home), PATH: `${bin}:/usr/bin:/bin` };
    expect(execFileSync("git", ["--version"], { env, encoding: "utf8" })).toBe("fake-git-ran\n");
    expect((await spawned("git", [], { env })).file).toBe("git");
  });
  it("gives git and its children the native arguments, working folder and environment", () => {
    const home = temp();
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: home, env: clean(home) });
    expect(environment("git", home)).toEqual(environment("/usr/bin/git", home));
    expect(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: home, env: clean(home), encoding: "utf8" })).toBe(".git\n");
  });
  it("preserves the native shim's treatment of caller variables", () => {
    const home = temp();
    const extra = { CPATH: "/callers/own", LIBRARY_PATH: "/callers/lib", MANPATH: "/callers/man" };
    expect(environment("git", home, extra)).toEqual(environment("/usr/bin/git", home, extra));
  });
  it("provides inert compatibility context without discovery or conditional coverage", () => {
    expect(inject("realGit")).toBe("");
    expect(inject("shimEnv")).toEqual({});
    const provided: Record<string, unknown> = {};
    setup({ provide: (key: string, value: unknown) => { provided[key] = value; } } as TestProject);
    expect(provided).toEqual({ realGit: "", shimEnv: {} });
  });
});
