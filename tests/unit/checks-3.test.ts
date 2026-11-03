// Protected check and gate tests, part 3 of 3 (malformed checks, several cases, edited evidence, object stores, read-only trees, planted hooks). The tests are split over three files so they run in parallel;
// the shared fixture is tests/unit/helpers/checks-fixture.ts.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { COMPLETE, check, git, gate, n, out, project, root } from "./helpers/checks-fixture.ts";

// Removing every repo this file made can outlast the default 10 s hook limit under a loaded full run.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

// Generous limits: a gate runs several sandboxed processes, and a broken process cleanup (a mutation)
// must fail these tests by assertion after its bounded waits, not by the test runner's timeout.
describe("gates: evidence made by the runner (decisions 49, 76)", { timeout: 120_000 }, () => {
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
