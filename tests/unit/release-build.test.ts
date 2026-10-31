import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { buildRelease } from "../../packages/cli/src/release/build.ts";
import { registeredArtifacts } from "../../packages/cli/src/release/config.ts";
import { artifactDigest } from "../../packages/cli/src/release/manifest.ts";
import type { SandboxedRun } from "../../packages/cli/src/sandbox/srt.ts";
import { shortTmp } from "../helpers.ts";
import { initRepo } from "./helpers/git-repo.ts";

// Decision 157: the runner builds the checked revision itself, in the gate's sandbox, and registers the output's
// digest as the artifact's only binding to that revision. The real sandbox runs in tests/integration/e2e-release.test.ts.
const root = shortTmp("jrb-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project(files: Record<string, string>) {
  const dir = join(root, `b${++n}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  initRepo(repo, { identity: true });
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); }
  safeGit(repo, ["add", "-A"], { home: dir });
  safeGit(repo, ["commit", "-q", "-m", "app"], { home: dir });
  const revision = safeGit(repo, ["rev-parse", "HEAD"], { home: dir }).toString().trim();
  const jarvisHome = join(dir, "jarvis"); const projectDir = join(jarvisHome, "projects", "habits");
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const runs: SandboxedRun[] = [];
  // Runs the command without the sandbox runtime, so this file can see the policy it was given.
  const sandbox = async (r: SandboxedRun) => { runs.push(r); return runSession({ bin: "/bin/sh", args: ["-c", r.command], cwd: r.cwd, env: r.env, timeoutMs: r.timeoutMs, ...(r.stdoutPath ? { stdoutPath: r.stdoutPath } : {}), ...(r.stderrPath ? { stderrPath: r.stderrPath } : {}) }); };
  const ledger = Ledger.open(projectDir);
  const input = (command: string, output = "out") => ({ ledger, project: "habits", projectDir, jarvisHome, workRoot: join(dir, "work"), repoPath: repo, revision,
    build: { command, output, timeoutMs: 30_000 }, artifactRoot: join(dir, "work", "release", "habits", "artifacts"), runId: `r${n}`, gitHome: dir, sandbox });
  return { dir, repo, revision, ledger, runs, input, jarvisHome };
}

describe("the fixed-revision release build", () => {
  it("builds the committed revision, copies its output out of the checkout and registers the digest", async () => {
    const p = project({ "src/app.txt": "habits" });
    writeFileSync(join(p.repo, "src", "uncommitted.txt"), "not in the revision");
    const result = await buildRelease(p.input("mkdir -p out && cp src/* out/ && echo '<h1>Habits</h1>' > out/index.html"));
    expect(result.status).toBe("pass");
    if (result.status !== "pass") return;
    expect(readFileSync(join(result.artifactDir, "index.html"), "utf8")).toContain("Habits");
    expect(existsSync(join(result.artifactDir, "uncommitted.txt"))).toBe(false);
    expect(result.artifactHash).toBe(artifactDigest(result.artifactDir));
    expect(result.artifactDir.startsWith(realpathSync(join(p.dir, "work", "release", "habits", "artifacts")))).toBe(true);
    expect(result.entry).toMatchObject({ kind: "decision", actor: "runner", data: { type: "release.artifact", project: "habits", revision: p.revision, artifactHash: result.artifactHash } });
    expect(registeredArtifacts(p.ledger.entries(), "habits")).toEqual({ [p.revision]: result.artifactHash });
    // The scratch checkout is gone; only the artifact and the logs remain.
    expect(readdirSync(join(p.dir, "work")).filter((d) => d.startsWith("release-build-"))).toEqual([]);
  });

  it("runs in the gate's sandbox: the runner home unreadable, writes only to its own checkout, no credential in its environment", async () => {
    const p = project({ "a.txt": "a" });
    await buildRelease(p.input("mkdir -p out && touch out/x"));
    const run = p.runs[0]!;
    expect(run.policy.denyRead).toEqual(expect.arrayContaining([realpathSync(p.jarvisHome), realpathSync(homedir())]));
    expect(run.policy.allowWrite).toHaveLength(3);
    expect(run.policy.allowWrite.every((w) => w.startsWith(realpathSync(join(p.dir, "work"))))).toBe(true);
    expect(run.policy.allowedDomains ?? []).toEqual([]);
    expect(run.policy.allowUnixSockets ?? []).toEqual([]);
    expect(Object.keys(run.env).filter((k) => /TOKEN|SECRET|KEY|AUTH/i.test(k))).toEqual([]);
    expect(run.cwd.endsWith("/checkout")).toBe(true);
  });

  it.each([
    ["a failing build", "exit 2", "out", /exited 2/],
    ["a build with no output folder", "true", "out", /left no out folder/],
    ["an output folder that is a link", "mkdir -p real && ln -s real out", "out", /left no out folder/],
    ["an output link out of the checkout", "mkdir -p out && ln -s /etc out/etc", "out", /could not run|escapes|outside/],
  ])("registers nothing for %s", async (_name, command, output, reason) => {
    const p = project({ "a.txt": "a" });
    const result = await buildRelease(p.input(command, output));
    expect(result).toMatchObject({ status: "fail", reason: expect.stringMatching(reason) });
    expect(registeredArtifacts(p.ledger.entries(), "habits")).toEqual({});
  });

  it("refuses a revision that isn't a full commit id", async () => {
    const p = project({ "a.txt": "a" });
    expect(await buildRelease({ ...p.input("true"), revision: "HEAD" })).toMatchObject({ status: "fail" });
    expect(p.runs).toEqual([]);
  });
});
