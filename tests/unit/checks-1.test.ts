// Protected check and gate tests, part 1 of 2 (protected checks, the first gate cases). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/checks-fixture.ts.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { COMPLETE, check, git, gate, n, out, project, root } from "./helpers/checks-fixture.ts";

// Removing every repo this file made can outlast the default 10 s hook limit under a loaded full run.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

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
});
