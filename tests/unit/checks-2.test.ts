// Protected check and gate tests, part 2 of 3 (the completion line, surviving daemons, the observation cap, temp folders, forged output). The tests are split over three files so they run in parallel;
// the shared fixture is tests/unit/helpers/checks-fixture.ts.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COMPLETE, check, gate, n, out, project, root } from "./helpers/checks-fixture.ts";

// Removing every repo this file made can outlast the default 10 s hook limit under a loaded full run.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

// Generous limits: a gate runs several sandboxed processes, and a broken process cleanup (a mutation)
// must fail these tests by assertion after its bounded waits, not by the test runner's timeout.
describe("gates: evidence made by the runner (decisions 49, 76)", { timeout: 120_000 }, () => {
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
});
