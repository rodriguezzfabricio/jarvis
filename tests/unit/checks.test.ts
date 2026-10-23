import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGate, verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtk-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
let n = 0;

function project() {
  const id = `p${++n}`;
  const jarvisHome = join(root, `jh${n}`);
  const projectDir = join(jarvisHome, "projects", id);
  mkdirSync(join(projectDir, "checks"), { recursive: true });
  const ledger = Ledger.open(projectDir);
  const store = new ChecksStore(projectDir);
  const repo = join(root, `work${n}`, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "value.txt"), "42\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c1");
  const revision = git(repo, "rev-parse", "HEAD");
  return { id, jarvisHome, projectDir, ledger, store, repo, revision, workRoot: join(root, `work${n}`) };
}
const check = (name: string, script: string, p: ReturnType<typeof project>) => {
  writeFileSync(join(p.projectDir, "checks", `${name}.sh`), script);
  return { name, command: `sh "$JARVIS_CHECKS/${name}.sh"`, timeoutMs: 30_000 };
};
const gate = (p: ReturnType<typeof project>, c: { name: string; command: string; timeoutMs: number }, extra = {}) =>
  runGate({ ledger: p.ledger, store: p.store, projectDir: p.projectDir, jarvisHome: p.jarvisHome, workRoot: p.workRoot, repoPath: p.repo, revision: p.revision, check: c, taskId: "t1", attemptId: "a1", ...extra });

describe("protected checks (decisions 15, 49)", () => {
  it("approves check files into the ledger and verifies them", () => {
    const p = project();
    check("unit", "exit 0\n", p);
    p.store.approve(p.ledger, "spec v1");
    expect(p.store.verify(p.ledger)).toMatchObject({ ok: true, problems: [] });
    expect(p.ledger.entries().at(-1)?.kind).toBe("checks_approved");
  });

  it("detects an edited, added or removed check file", () => {
    for (const mutate of [
      (d: string) => writeFileSync(join(d, "unit.sh"), "exit 0 # loosened\n"),
      (d: string) => writeFileSync(join(d, "extra.sh"), "exit 0\n"),
      (d: string) => rmSync(join(d, "unit.sh")),
    ]) {
      const p = project();
      check("unit", "exit 1\n", p);
      p.store.approve(p.ledger, "v1");
      mutate(join(p.projectDir, "checks"));
      expect(p.store.verify(p.ledger).ok).toBe(false);
    }
  });

  it("detects a check file and its lock edited together (the ledger holds the approved lock hash)", () => {
    const p = project();
    check("unit", "exit 1\n", p);
    p.store.approve(p.ledger, "v1");
    writeFileSync(join(p.projectDir, "checks", "unit.sh"), "exit 0\n");
    const lock = JSON.parse(readFileSync(join(p.projectDir, "checks.lock"), "utf8"));
    lock.files["unit.sh"] = p.store.hashAll()["unit.sh"];
    writeFileSync(join(p.projectDir, "checks.lock"), JSON.stringify(lock));
    expect(p.store.verify(p.ledger).problems.join(" ")).toMatch(/not the approved lock/);
  });
});

describe("gates: evidence made by the runner (decision 49)", () => {
  it("runs the check on a fresh checkout of the revision and records hashed evidence", async () => {
    const p = project();
    const c = check("value", 'test "$(cat value.txt)" = 42 && echo "value ok"\n', p);
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    if (r.status !== "pass") return;
    const e = p.ledger.entries().at(-1)!;
    expect(e.kind).toBe("gate_result");
    expect(e.data).toMatchObject({ check: "value", revision: p.revision, status: "pass", exitCode: 0 });
    expect(readFileSync(join(r.evidenceDir, "stdout.log"), "utf8")).toContain("value ok");
    expect(verifyEvidence(e)).toEqual({ ok: true, problems: [] });
  });

  it("judges the committed revision, not what the agent left uncommitted", async () => {
    const p = project();
    const c = check("value", 'test "$(cat value.txt)" = 42\n', p);
    p.store.approve(p.ledger, "v1");
    writeFileSync(join(p.repo, "value.txt"), "41\n"); // uncommitted edit in the worktree
    expect((await gate(p, c)).status).toBe("pass");
  });

  it("refuses to run a tampered check, and records that", async () => {
    const p = project();
    const marker = join(root, `ran-${n}`);
    const c = check("unit", `touch ${marker}\nexit 1\n`, p);
    p.store.approve(p.ledger, "v1");
    writeFileSync(join(p.projectDir, "checks", "unit.sh"), `touch ${marker}\nexit 0\n`);
    const r = await gate(p, c);
    expect(r.status).toBe("tampered");
    expect(existsSync(marker)).toBe(false);
    expect(p.ledger.entries().at(-1)?.data).toMatchObject({ status: "tampered" });
  });

  it("detects edited evidence", async () => {
    const p = project();
    const c = check("value", "echo fine\n", p);
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    writeFileSync(join(r.evidenceDir, "stdout.log"), "all tests passed (typed by an agent)\n");
    expect(verifyEvidence(p.ledger.entries().at(-1)!).ok).toBe(false);
  });

  it("never runs git hooks the agent planted in its repo", async () => {
    const p = project();
    const marker = join(root, `hook-${n}`);
    writeFileSync(join(p.repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const c = check("noop", "exit 0\n", p);
    p.store.approve(p.ledger, "v1");
    await gate(p, c);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("runs checks sandboxed: no runner folder, no home, no network, no writes outside the checkout", async () => {
    const p = project();
    writeFileSync(join(p.projectDir, "secret.env"), "CHECK-CANARY\n");
    const outside = join(root, `outside-${n}.txt`);
    const c = check(
      "escape",
      [
        `cat "${join(p.projectDir, "secret.env")}" && echo READ-RUNNER`,
        `cat "$HOME_REAL/.zshrc" > /dev/null 2>&1 && echo READ-HOME`,
        `curl -s -m 5 -o /dev/null https://example.com && echo NET`,
        `echo x > "${outside}" && echo WROTE-OUTSIDE`,
        "echo x > inside.txt && echo WROTE-INSIDE",
        "exit 0",
      ].join("\n"),
      p,
    );
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c, { extraEnv: { HOME_REAL: process.env.HOME ?? "/" } });
    const out = readFileSync(join(r.evidenceDir, "stdout.log"), "utf8");
    expect(out).toContain("WROTE-INSIDE");
    for (const leak of ["READ-RUNNER", "READ-HOME", "NET", "WROTE-OUTSIDE"]) expect(out).not.toContain(leak);
    expect(existsSync(outside)).toBe(false);
  });
});
