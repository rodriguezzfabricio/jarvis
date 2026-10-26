import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, inject, it } from "vitest";

// tests/setup/use-real-git.ts starts the git binary the macOS /usr/bin/git shim would have run, in place of a
// bare `git` that would find the shim. These tests pin down what it may and may not change: production code
// under test must run exactly as it would without the redirect (same binary, arguments and environment, down
// to what the processes git starts see), and anything that is not a plain bare `git` through the shim is left alone.
const realGit = inject("realGit");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "jarvis-redirect-")); dirs.push(d); return d; };
const clean = (home: string) => ({ PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
/** Which file a spawn actually executes (and, for a shell, the command line it was given), then waits for it to end. */
async function spawned(file: string, args: string[], options: Parameters<typeof spawn>[2] = {}): Promise<{ file: string; line: string }> {
  const child = spawn(file, args, { stdio: "ignore", ...options });
  await new Promise((resolve) => child.once("close", resolve));
  return { file: child.spawnfile, line: child.spawnargs.join(" ") };
}
/** The variables a process started by git sees (an alias that runs env), `_` aside. */
const seenByGitChildren = (bin: string, home: string) => execFileSync(bin, ["-c", "alias.e=!env", "e"], { cwd: home, env: clean(home), encoding: "utf8" }).split("\n").filter((l) => l !== "" && !l.startsWith("_=")).sort();

describe.runIf(realGit !== "")("the real-git redirect (tests/setup/use-real-git.ts)", () => {
  it("runs the real git for a bare git that would find the shim, and nothing else", async () => {
    const home = temp();
    expect((await spawned("git", ["--version"], { env: clean(home) })).file).toBe(realGit);
    expect((await spawned("git", ["--version"], { env: { HOME: home } })).file).toBe(realGit); // no PATH in its env: Node searches /usr/bin:/bin
    expect((await spawned("/usr/bin/git", ["--version"], { env: clean(home) })).file).toBe("/usr/bin/git"); // an absolute path is the caller's choice
    const viaShell = await spawned("git", ["--version"], { env: clean(home), shell: true });
    expect(viaShell.line).toMatch(/-c git --version$/); // a shell resolves a bare git itself (a path with a space in it would break there)
  });

  it("leaves a different git first on PATH alone, and runs it", () => {
    const home = temp();
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho fake-git-ran\n");
    chmodSync(join(bin, "git"), 0o755);
    expect(execFileSync("git", ["--version"], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: "utf8" })).toBe("fake-git-ran\n");
    expect(spawnSync("git", [], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: "utf8" }).stdout).toBe("fake-git-ran\n");
  });

  it("gives git the arguments, working folder and environment the shim would have given it, and the processes git starts too", () => {
    const home = temp();
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: home, env: clean(home) });
    // The redirected call is the bare one; the other goes through the shim by absolute path.
    const redirected = execFileSync("git", ["-c", "alias.e=!env", "e"], { cwd: home, env: clean(home), encoding: "utf8" }).split("\n").filter((l) => l !== "" && !l.startsWith("_=")).sort();
    expect(redirected).toEqual(seenByGitChildren("/usr/bin/git", home));
    expect(redirected.some((l) => l.startsWith("SDKROOT="))).toBe(true); // the variables the shim adds are really there
    expect(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: home, env: clean(home), encoding: "utf8" })).toBe(".git\n");
  });

  it("keeps a variable the caller already set", () => {
    const home = temp();
    const out = execFileSync("git", ["-c", "alias.e=!env", "e"], { cwd: home, env: { ...clean(home), CPATH: "/callers/own" }, encoding: "utf8" });
    expect(out.split("\n")).toContain("CPATH=/callers/own");
  });

  it("covers every way of starting a process: sync, callback, promisified and spawn", async () => {
    const home = temp();
    const env = clean(home);
    expect(execFileSync("git", ["--version"], { env, encoding: "utf8" })).toMatch(/^git version/);
    expect(spawnSync("git", ["--version"], { env, encoding: "utf8" }).stdout).toMatch(/^git version/);
    expect(execFileSync("git", ["--version"]).toString()).toMatch(/^git version/); // no options at all
    const viaCallback = await new Promise<string>((resolve, reject) => execFile("git", ["--version"], { env }, (e, out) => (e ? reject(e) : resolve(out))));
    expect(viaCallback).toMatch(/^git version/);
    expect((await promisify(execFile)("git", ["--version"], { env })).stdout).toMatch(/^git version/);
    const noOptions = await new Promise<string>((resolve, reject) => execFile("git", ["--version"], (e, out) => (e ? reject(e) : resolve(out))));
    expect(noOptions).toMatch(/^git version/);
  });
});
