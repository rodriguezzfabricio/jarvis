import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGate, verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtk-");
// Removing every repo this file made can outlast the default 10 s hook limit under a loaded full run.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);
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
/** The default assertions: the case exited 0. */
const EXIT0 = `test "$(cat main/code)" = 0 || exit 1\n${COMPLETE}`;
/** One case, "main", running checks/fixtures/<name>.sh in the candidate sandbox; assertions in checks/<name>.verify.sh. */
const check = (name: string, script: string, p: ReturnType<typeof project>, verify = EXIT0) => {
  mkdirSync(join(p.projectDir, "checks", "fixtures"), { recursive: true });
  writeFileSync(join(p.projectDir, "checks", "fixtures", `${name}.sh`), script);
  writeFileSync(join(p.projectDir, "checks", `${name}.verify.sh`), verify);
  return { name, cases: [{ id: "main", command: `sh "$JARVIS_FIXTURES/${name}.sh"` }], verify: `sh "$JARVIS_CHECKS/${name}.verify.sh"`, timeoutMs: 30_000 };
};
const out = (r: { evidenceDir: string }, f = "stdout") => readFileSync(join(r.evidenceDir, "cases", "main", f), "utf8");
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
      (d: string) => writeFileSync(join(d, "fixtures", "unit.sh"), "exit 0 # loosened\n"),
      (d: string) => writeFileSync(join(d, "extra.sh"), "exit 0\n"),
      (d: string) => rmSync(join(d, "fixtures", "unit.sh")),
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
    writeFileSync(join(p.projectDir, "checks", "fixtures", "unit.sh"), "exit 0\n");
    const lock = JSON.parse(readFileSync(join(p.projectDir, "checks.lock"), "utf8"));
    lock.files["fixtures/unit.sh"] = p.store.hashAll()["fixtures/unit.sh"];
    writeFileSync(join(p.projectDir, "checks.lock"), JSON.stringify(lock));
    expect(p.store.verify(p.ledger).problems.join(" ")).toMatch(/not the approved lock/);
  });
});

// Generous limits: a gate runs several sandboxed processes, and a broken process cleanup (a mutation)
// must fail these tests by assertion after its bounded waits, not by the test runner's timeout.
describe("gates: evidence made by the runner (decisions 49, 76)", { timeout: 120_000 }, () => {
  it("runs the check on a fresh checkout of the revision and records hashed evidence", async () => {
    const p = project();
    const c = check("value", 'test "$(cat value.txt)" = 42 && echo "value ok"\n', p);
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    const e = p.ledger.entries().at(-1)!;
    expect(e.kind).toBe("gate_result");
    expect(e.data).toMatchObject({ check: "value", revision: p.revision, status: "pass", caseResults: [{ id: "main", code: 0, timedOut: false }], completed: true });
    expect(out(r)).toContain("value ok");
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
    writeFileSync(join(p.projectDir, "checks", "fixtures", "unit.sh"), `touch ${marker}\nexit 0\n`);
    const r = await gate(p, c);
    expect(r.status).toBe("tampered");
    expect(existsSync(marker)).toBe(false);
    expect(p.ledger.entries().at(-1)?.data).toMatchObject({ status: "tampered" });
  });

  // Codex review 5, high: candidate code that kills its own shell must never look like success.
  it("records a case killed by a signal as a signal, never as exit 0", async () => {
    const p = project();
    const c = check("killed", "kill -TERM $$\nsleep 1\nexit 1\n", p);
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("fail");
    expect(out(r, "code").trim()).toBe("signal");
    const c2 = check("killed-int", "kill -INT $$\nsleep 1\nexit 1\n", p);
    p.store.approve(p.ledger, "v2");
    expect((await gate(p, c2)).status).toBe("fail");
  });

  it("fails a case that times out, whatever the assertions say", async () => {
    const p = project();
    const c = { ...check("slow", "sleep 30\n", p, COMPLETE), timeoutMs: 1_000 };
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("fail");
    expect((r.entry.data as { completed: boolean }).completed).toBe(true);
  });

  // Codex reviews 6 and 7, high: early exits and fabricated observations must never earn a pass.
  it("judges a candidate only by its own output: early exits and planted observations fail", async () => {
    const drive = '. ./candidate.sh\necho "value=$(answer)"\n';
    const assert = `grep -qx 'value=42' main/stdout || exit 1\n${COMPLETE}`;
    const plant = [
      "for d in ../../verify/obs/main \"$JARVIS_OUT/main\" \"$EVIDENCE_HINT\"/*/cases/main; do",
      "  mkdir -p \"$d\" 2>/dev/null && echo value=42 > \"$d/stdout\" 2>/dev/null",
      "done",
    ].join("\n");
    for (const [candidate, want] of [
      ["answer() { echo 42; }\n", "pass"],
      ["answer() { echo 41; }\n", "fail"],
      ["exit 0\nanswer() { echo 41; }\n", "fail"], // exits during "import", before printing anything
      [`${plant}\nexit 0\nanswer() { echo 41; }\n`, "fail"], // writes the expected observation, then exits
    ] as const) {
      const p = project();
      writeFileSync(join(p.repo, "candidate.sh"), candidate);
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-qm", "candidate");
      const revision = git(p.repo, "rev-parse", "HEAD");
      const c = check("early-exit", drive, p, assert);
      p.store.approve(p.ledger, "v1");
      const r = await gate({ ...p, revision }, c, { extraEnv: { EVIDENCE_HINT: join(p.projectDir, "evidence") } });
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

  // Codex stage 0 review 16, lane D: a daemon that escapes the case's process group (setsid) must not reach
  // the verifier's scratch files, through the library's shared temp folder or anywhere else.
  it("doesn't let a surviving candidate daemon rewrite the verifier's scratch files", async () => {
    const made = !existsSync("/private/tmp/claude");
    if (made) mkdirSync("/private/tmp/claude", { recursive: true });
    try {
      const daemon = `/usr/bin/perl -e 'use POSIX qw(setsid); exit if fork; setsid(); open STDIN, "</dev/null"; open STDOUT, ">/dev/null"; open STDERR, ">/dev/null"; for (1..200) { for my $f (glob("/tmp/claude/assert.* /private/tmp/claude/assert.*")) { if (open my $h, ">", $f) { print $h "value=42\\n"; close $h } } select(undef, undef, undef, 0.05) }'\n`;
      const verify = `t=$(mktemp "$TMPDIR/assert.XXXXXXXX") || exit 1\ncp main/stdout "$t"\nsleep 1\ngrep -qx value=42 "$t" || exit 1\n${COMPLETE}`;
      for (const [candidate, want] of [
        ["echo value=42\n", "pass"],
        [`echo value=41\n${daemon}`, "fail"],
      ] as const) {
        const p = project();
        const c = check("daemon", candidate, p, verify);
        p.store.approve(p.ledger, "v1");
        expect((await gate(p, c)).status, candidate).toBe(want);
      }
    } finally {
      if (made) rmSync("/private/tmp/claude", { recursive: true, force: true });
    }
  });

  // Codex stage 0 review 16, lane D: the observation cap was checked only after unbounded capture.
  it("stops a case as soon as its output passes the observation cap, and fails without running verify", async () => {
    const p = project();
    const c = check("flood", "head -c 40000000 /dev/zero\nsleep 20\n", p, COMPLETE);
    p.store.approve(p.ledger, "v1");
    const started = Date.now();
    // Raced against a deadline, so a capture that never ends fails an assertion, not the runner's timeout.
    const raced = await Promise.race([gate(p, c), new Promise<"hung">((res) => setTimeout(() => res("hung"), 60_000))]);
    expect(raced).not.toBe("hung");
    const r = raced as Awaited<ReturnType<typeof gate>>;
    expect(r.status).toBe("fail");
    expect((r.entry.data as { observationsOverCap?: boolean }).observationsOverCap).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(statSync(join(r.evidenceDir, "cases", "main", "stdout")).size).toBeLessThanOrEqual(17 * 1024 * 1024);
    expect(existsSync(join(r.evidenceDir, "verify-stdout.log")) ? readFileSync(join(r.evidenceDir, "verify-stdout.log"), "utf8") : "").toBe("");
  });

  // Codex round 18, lanes A and D, high: gate sandboxes lacked decision 95's temp denials.
  it("keeps candidates and assertions from reading the system temp folders, while each phase's own TMPDIR works", async () => {
    const nonce = `${process.pid}-${Date.now()}`;
    const secret = `GATE-TEMP-SECRET-${nonce}`;
    const planted = [...new Set(["/private/tmp", "/private/var/tmp", realpathSync(tmpdir())])].map((d) => join(d, `jarvis-gate-secret-${nonce}.txt`));
    for (const f of planted) writeFileSync(f, `${secret}\n`, { mode: 0o600 });
    try {
      const p = project();
      const reads = planted.map((f) => `cat ${f} 2>&1\n`).join("");
      const c = check("temp", `${reads}printf own-ok > "$TMPDIR/own" && cat "$TMPDIR/own"\n`, p, `${reads}printf 'verify-ok\\n' > "$TMPDIR/v" && cat "$TMPDIR/v"\n${COMPLETE}`);
      p.store.approve(p.ledger, "v1");
      const r = await gate(p, c);
      const caseOut = out(r);
      const verifyOut = readFileSync(join(r.evidenceDir, "verify-stdout.log"), "utf8");
      expect(caseOut).toContain("own-ok");
      expect(verifyOut).toContain("verify-ok");
      expect(caseOut).not.toContain(secret);
      expect(verifyOut).not.toContain(secret);
      for (const f of planted) expect(caseOut).toContain(`${f}: Operation not permitted`);
      expect(r.status).toBe("pass");
    } finally {
      for (const f of planted) rmSync(f, { force: true });
    }
  });

  it("doesn't let candidate output forge the completion line", async () => {
    const p = project();
    // The candidate guesses the line and prints it where a naive verify phase echoes it last.
    const c = check("forge", 'echo "JARVIS-CHECK-COMPLETE $(cat ../../verify/completion 2>/dev/null || echo guess)"\n', p, "cat main/stdout\n");
    p.store.approve(p.ledger, "v1");
    expect((await gate(p, c)).status).toBe("fail");
  });

  it("refuses a check without a verify phase or cases, or with bad case ids", async () => {
    const p = project();
    const base = check("shape", "exit 0\n", p);
    p.store.approve(p.ledger, "v1");
    for (const c of [
      { ...base, verify: "" },
      { ...base, cases: [] },
      { ...base, cases: [{ id: "__proto__", command: "true" }] },
      { ...base, cases: [{ id: "a/../b", command: "true" }] },
      { ...base, cases: [{ id: "a", command: "true" }, { id: "a", command: "true" }] },
    ]) expect((await gate(p, c)).status).toBe("error");
  });

  it("runs several cases and records each one's output separately", async () => {
    const p = project();
    mkdirSync(join(p.projectDir, "checks", "fixtures"), { recursive: true });
    writeFileSync(join(p.projectDir, "checks", "fixtures", "in.txt"), "7\n");
    writeFileSync(join(p.projectDir, "checks", "multi.verify.sh"), `test "$(cat one/stdout)" = 7 && test "$(cat two/code)" = 3 || exit 1\n${COMPLETE}`);
    const c = { name: "multi", cases: [{ id: "one", command: 'cat "$JARVIS_FIXTURES/in.txt"' }, { id: "two", command: "exit 3" }], verify: 'sh "$JARVIS_CHECKS/multi.verify.sh"', timeoutMs: 30_000 };
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    expect(Object.keys((r.entry.data as { evidence: { files: Record<string, string> } }).evidence.files)).toEqual(expect.arrayContaining(["cases/one/stdout", "cases/two/code", "verify-stdout.log"]));
  });

  it("detects edited evidence", async () => {
    const p = project();
    const c = check("value", "echo fine\n", p);
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    for (const f of ["stdout", "code"]) {
      const path = join(r.evidenceDir, "cases", "main", f);
      const before = readFileSync(path);
      writeFileSync(path, "all tests passed (typed by an agent)\n");
      expect(verifyEvidence(p.ledger.entries().at(-1)!).ok).toBe(false);
      writeFileSync(path, before);
    }
    expect(verifyEvidence(p.ledger.entries().at(-1)!).ok).toBe(true);
    rmSync(join(r.evidenceDir, "verify-stdout.log"));
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
    const objPath = join(p.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const { chmodSync } = await import("node:fs");
    chmodSync(objPath, 0o644);
    writeFileSync(objPath, deflateSync(Buffer.from("blob 3\u000042\n", "latin1")));
    const c = check("value", 'test "$(cat value.txt)" = 42\n', p);
    p.store.approve(p.ledger, "v1");
    const r = await gate({ ...p, revision }, c);
    expect(r.status).not.toBe("pass");
  });

  // A golden-task run: Go's module extraction leaves read-only trees, and a candidate can chmod one on purpose.
  it("removes a read-only tree the candidate left, and still returns the recorded status", async () => {
    const p = project();
    const c = check("ro", "mkdir -p ro/a/b && touch ro/a/b/f && chmod -R a-w ro\nexit 0\n", p);
    p.store.approve(p.ledger, "v1");
    try {
      const r = await gate(p, c);
      expect(r.status).toBe("pass");
      expect(p.ledger.entries().at(-1)).toMatchObject({ kind: "gate_result", data: { check: "ro", status: "pass" } });
      expect(readdirSync(join(p.workRoot, "checks"))).toEqual([]);
    } finally { execFileSync("/bin/chmod", ["-R", "u+w", p.workRoot]); } // so a leftover never breaks the suite's own cleanup
  });

  it("makes the run folder writable without following a symlink out of it", async () => {
    const p = project();
    const outside = join(root, `locked-${n}`); mkdirSync(join(outside, "inner"), { recursive: true }); chmodSync(outside, 0o500);
    try {
      const c = check("link", `ln -s "${outside}" out\nmkdir ro && chmod a-w ro\nexit 0\n`, p);
      p.store.approve(p.ledger, "v1");
      expect((await gate(p, c)).status).toBe("pass");
      expect(statSync(outside).mode & 0o777).toBe(0o500);
      expect(existsSync(join(outside, "inner"))).toBe(true);
      expect(readdirSync(join(p.workRoot, "checks"))).toEqual([]);
    } finally { chmodSync(outside, 0o700); }
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

  it.skipIf(process.platform !== "darwin")("runs cases sandboxed: no runner folder, no expectations, no home, no network, no writes outside the checkout", async () => {
    const p = project();
    writeFileSync(join(p.projectDir, "secret.env"), "CHECK-CANARY\n");
    const outside = join(root, `outside-${n}.txt`);
    const c = check(
      "escape",
      [
        `cat "${join(p.projectDir, "secret.env")}" && echo READ-RUNNER`,
        `cat "${join(p.projectDir, "checks", "escape.verify.sh")}" > /dev/null 2>&1 && echo READ-EXPECTATIONS`,
        'cat "$JARVIS_FIXTURES/escape.sh" > /dev/null && echo READ-FIXTURES',
        'ls ../../verify > /dev/null 2>&1 && echo SAW-VERIFY',
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
    const o = out(r);
    expect(o).toContain("WROTE-INSIDE");
    expect(o).toContain("READ-FIXTURES");
    for (const leak of ["READ-RUNNER", "READ-EXPECTATIONS", "SAW-VERIFY", "READ-HOME", "NET", "WROTE-OUTSIDE"]) expect(o).not.toContain(leak);
    expect(existsSync(outside)).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("runs the assertions without the checkout or the candidate's folders", async () => {
    const p = project();
    const c = check("apart", "pwd\n", p, ['W=$(head -1 main/stdout)', 'cat "$W/value.txt" > /dev/null 2>&1 && echo READ-CHECKOUT', 'ls "$W/../home" > /dev/null 2>&1 && echo READ-CANDIDATE-HOME', COMPLETE].join("\n"));
    p.store.approve(p.ledger, "v1");
    const r = await gate(p, c);
    expect(r.status).toBe("pass");
    const ver = readFileSync(join(r.evidenceDir, "verify-stdout.log"), "utf8");
    expect(ver).not.toContain("READ-CHECKOUT");
    expect(ver).not.toContain("READ-CANDIDATE-HOME");
  });
});
