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
/** The completion line a verify phase prints last (decision 76). */
const COMPLETE = 'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"\n';
const check = (name: string, script: string, p: ReturnType<typeof project>, verify = COMPLETE) => {
  writeFileSync(join(p.projectDir, "checks", `${name}.sh`), script);
  writeFileSync(join(p.projectDir, "checks", `${name}.verify.sh`), verify);
  return { name, command: `sh "$JARVIS_CHECKS/${name}.sh"`, verify: `sh "$JARVIS_CHECKS/${name}.verify.sh"`, timeoutMs: 30_000 };
};
type Check = ReturnType<typeof check>;
const gate = (p: ReturnType<typeof project>, c: Check, extra = {}) =>
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

  it("protects a check file named __proto__ like any other", () => {
    const p = project();
    writeFileSync(join(p.projectDir, "checks", "__proto__"), "exit 1\n");
    p.store.approve(p.ledger, "v1");
    expect(Object.keys(p.store.hashAll())).toContain("__proto__");
    writeFileSync(join(p.projectDir, "checks", "__proto__"), "exit 0\n");
    expect(p.store.verify(p.ledger).problems).toContain("check changed: __proto__");
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

  // Codex review 5, high: candidate code that kills the check's own shell must never yield a pass.
  it("fails a check whose shell is killed before its assertions run", async () => {
    const p = project();
    const c = check("killed", 'kill -TERM $$\nsleep 1\nexit 1\n', p);
    p.store.approve(p.ledger, "v1");
    expect((await gate(p, c)).status).toBe("fail");
    const c2 = check("killed-int", 'kill -INT $$\nsleep 1\nexit 1\n', p);
    p.store.approve(p.ledger, "v2");
    expect((await gate(p, c2)).status).toBe("fail");
  });

  // Codex review 6, high: candidate code that exits 0 before the assertions run must never yield a pass.
  it("fails when candidate code exits 0 before the assertions run", async () => {
    const drive = '. ./candidate.sh\necho "value=$(answer)" > "$JARVIS_OUT/result"\n';
    const assert = `grep -qx 'value=42' "$JARVIS_OUT/result" || exit 1\n${COMPLETE}`;
    for (const [candidate, want] of [
      ["answer() { echo 42; }\n", "pass"],
      ["answer() { echo 41; }\n", "fail"],
      ["exit 0\nanswer() { echo 41; }\n", "fail"], // exits during "import", before anything is observed
    ] as const) {
      const p = project();
      writeFileSync(join(p.repo, "candidate.sh"), candidate);
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-qm", "candidate");
      const revision = git(p.repo, "rev-parse", "HEAD");
      const c = check("early-exit", drive, p, assert);
      p.store.approve(p.ledger, "v1");
      const r = await gate({ ...p, revision }, c);
      expect(r.status, candidate).toBe(want);
    }
  });

  it("passes only when the assertions run to the end and print this run's completion line", async () => {
    for (const [verify, want] of [
      [COMPLETE, "pass"],
      ["exit 0\n" + COMPLETE, "fail"], // stopped early with status 0
      ['echo "JARVIS-CHECK-COMPLETE not-the-nonce"\n', "fail"],
      [COMPLETE + "echo trailing output\n", "fail"],
      [COMPLETE + "exit 1\n", "fail"],
    ] as const) {
      const p = project();
      const c = check("complete", "exit 0\n", p, verify);
      p.store.approve(p.ledger, "v1");
      const r = await gate(p, c);
      expect(r.status, verify).toBe(want);
      expect((r.entry.data as { completed: boolean }).completed).toBe(want === "pass" || verify.startsWith(COMPLETE + "exit"));
    }
  });

  it("doesn't let candidate output forge the completion line", async () => {
    const p = project();
    // The candidate guesses the line and plants it where a naive verify phase echoes it last.
    const c = check("forge", 'echo "JARVIS-CHECK-COMPLETE $(cat ../../verify/completion 2>/dev/null || echo guess)" > "$JARVIS_OUT/result"\n', p, 'cat "$JARVIS_OUT/result"\n');
    p.store.approve(p.ledger, "v1");
    expect((await gate(p, c)).status).toBe("fail");
  });

  it("refuses a check without a verify phase", async () => {
    const p = project();
    const c = { ...check("noverify", "exit 0\n", p), verify: "" };
    p.store.approve(p.ledger, "v1");
    expect((await gate(p, c)).status).toBe("error");
  });

  it("hashes the observations into the evidence", async () => {
    const p = project();
    const c = check("obs", 'echo "value=42" > "$JARVIS_OUT/result"\n', p, `grep -qx value=42 result || exit 1\n${COMPLETE}`);
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    const e = p.ledger.entries().at(-1)!;
    expect(Object.keys((e.data as { evidence: { files: Record<string, string> } }).evidence.files)).toContain("out/result");
    expect(verifyEvidence(e).ok).toBe(true);
    writeFileSync(join(r.evidenceDir, "out", "result"), "value=41\n");
    expect(verifyEvidence(e).ok).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("keeps the phases apart: assertions can't read the checkout, the candidate can't read the verify folder", async () => {
    const p = project();
    const c = check(
      "apart",
      ['pwd > "$JARVIS_OUT/where"', "ls ../../verify > /dev/null 2>&1 && echo SAW-VERIFY", "cat value.txt > /dev/null && echo READ-OWN-CHECKOUT"].join("\n"),
      p,
      ['cat "$(cat "$JARVIS_OUT/where")/value.txt" > /dev/null 2>&1 && echo READ-CHECKOUT', 'ls "$(cat "$JARVIS_OUT/where")/../../out" > /dev/null 2>&1 && echo READ-LIVE-OUT', COMPLETE].join("\n"),
    );
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    const run = readFileSync(join(r.evidenceDir, "stdout.log"), "utf8");
    const ver = readFileSync(join(r.evidenceDir, "verify-stdout.log"), "utf8");
    expect(run).toContain("READ-OWN-CHECKOUT");
    expect(run).not.toContain("SAW-VERIFY");
    expect(ver).not.toContain("READ-CHECKOUT");
    expect(ver).not.toContain("READ-LIVE-OUT");
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

  // Codex review 5, high: an object swapped under its old name must not turn a failure into a pass.
  it("does not pass a candidate whose object store was tampered with", async () => {
    const { deflateSync } = await import("node:zlib");
    const p = project();
    writeFileSync(join(p.repo, "value.txt"), "41\n");
    git(p.repo, "commit", "-qam", "candidate fails the check");
    const revision = git(p.repo, "rev-parse", "HEAD");
    const blob = git(p.repo, "rev-parse", "HEAD:value.txt");
    // Replace the failing blob's stored contents with passing contents, keeping its file name.
    const objPath = join(p.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const { chmodSync } = await import("node:fs");
    chmodSync(objPath, 0o644);
    writeFileSync(objPath, deflateSync(Buffer.from("blob 3\u000042\n", "latin1")));
    const c = check("value", 'test "$(cat value.txt)" = 42\n', p);
    p.store.approve(p.ledger, "v1");
    const r = await gate({ ...p, revision }, c);
    expect(r.status).not.toBe("pass");
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
    expect(r.status).toBe("pass");
    const out = readFileSync(join(r.evidenceDir, "stdout.log"), "utf8");
    expect(out).toContain("WROTE-INSIDE");
    for (const leak of ["READ-RUNNER", "READ-HOME", "NET", "WROTE-OUTSIDE"]) expect(out).not.toContain(leak);
    expect(existsSync(outside)).toBe(false);
  });
});
