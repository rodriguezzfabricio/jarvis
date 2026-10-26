import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGate } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSandboxed, type SandboxedRun } from "../../packages/cli/src/sandbox/srt.ts";
import { tempRoots } from "../../packages/cli/src/sandbox/temp.ts";
import { shortTmp } from "../helpers.ts";

// The gate's read rules, exactly as each phase hands them to the sandbox (decisions 76, 95). Behavior
// tests can't see these entries: in a test every folder sits under a system temp root, and in production
// under the home folder, which the same rules deny wholesale. The explicit entries are what still holds
// when the runner or work folder lives anywhere else.
const root = shortTmp("jtgp-");
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

describe("gate sandbox policy (decisions 76, 95)", () => {
  it("denies the candidate the runner folder, the home folder, the verify folder and the temp roots, and the verify phase the checkout", async () => {
    const jarvisHome = join(root, "jh");
    const projectDir = join(jarvisHome, "projects", "p");
    mkdirSync(join(projectDir, "checks", "fixtures"), { recursive: true });
    writeFileSync(join(projectDir, "checks", "fixtures", "probe.sh"), "exit 0\n");
    writeFileSync(join(projectDir, "checks", "probe.verify.sh"), 'test "$(cat main/code)" = 0 || exit 1\necho "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"\n');
    const ledger = Ledger.open(projectDir);
    const store = new ChecksStore(projectDir);
    store.approve(ledger, "v1");
    const repo = join(root, "work", "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "value.txt"), "42\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "c1");
    const seen: SandboxedRun[] = [];
    const r = await runGate({
      ledger, store, projectDir, jarvisHome, workRoot: join(root, "work"), repoPath: repo, revision: git(repo, "rev-parse", "HEAD"),
      check: { name: "probe", cases: [{ id: "main", command: 'sh "$JARVIS_FIXTURES/probe.sh"' }], verify: 'sh "$JARVIS_CHECKS/probe.verify.sh"', timeoutMs: 30_000 },
      taskId: "t1", attemptId: "a1",
      sandbox: (run) => { seen.push(run); return runSandboxed(run); },
    });
    // The real sandbox ran both phases.
    expect(r.status).toBe("pass");
    expect(seen).toHaveLength(2);
    const [candidate, verify] = seen as [SandboxedRun, SandboxedRun];
    const real = (p: string) => realpathSync(p);
    const checkout = candidate.cwd;
    const runDir = dirname(checkout);
    const gateDir = dirname(runDir);
    const verifyDir = join(gateDir, "verify");
    expect(dirname(gateDir)).toBe(real(join(root, "work", "checks")));
    expect(verify.cwd).toBe(join(verifyDir, "obs"));
    const temp = tempRoots();
    expect(candidate.policy).toEqual({
      denyRead: [real(jarvisHome), real(homedir()), verifyDir, ...temp],
      allowRead: [runDir, real(join(projectDir, "checks", "fixtures"))],
      allowWrite: [checkout, join(runDir, "home"), join(runDir, "cache")],
      allowLocalBinding: false,
    });
    expect(verify.policy).toEqual({
      denyRead: [real(jarvisHome), real(homedir()), runDir, ...temp],
      allowRead: [verifyDir, real(join(projectDir, "checks"))],
      allowWrite: [join(verifyDir, "home")],
    });
  });
});
