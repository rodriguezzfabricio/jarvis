import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { assertHiddenAbsent, gradeRecordedRun, gradeRun, hiddenDir, installHiddenChecks, loadHiddenChecks } from "../../packages/cli/src/eval/hidden.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { BUGGY, createEvalFixture, FIXED, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fixture = () => { const f = createEvalFixture(); fixtures.push(f); return f; };

/** A run's snapshot repo with two revisions: the planted bug, then the fix. */
function runRepo(fx: EvalFixture): { repo: string; buggy: string; fixed: string } {
  const repo = join(fx.workRoot, "evals", "05-citizenship", "run");
  mkdirSync(join(repo, "src"), { recursive: true });
  const g = (args: string[]) => safeGit(repo, args, { home: fx.home }).toString().trim();
  writeFileSync(join(repo, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(repo, "src", "citizen.mjs"), BUGGY);
  g(["init", "-q", "-b", "main"]); g(["add", "-A"]); g(["commit", "-q", "-m", "snapshot"]);
  const buggy = g(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src", "citizen.mjs"), FIXED);
  g(["commit", "-q", "-am", "fix"]);
  return { repo, buggy, fixed: g(["rev-parse", "HEAD"]) };
}

describe("eval grading: the hidden checks on a run's final revision, on the real gate", { timeout: 120_000 }, () => {
  it("passes the fix and fails the planted bug, with hashed runner evidence in the run folder", async () => {
    const fx = fixture();
    const { repo, buggy, fixed } = runRepo(fx);
    const hidden = loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship"));
    const runDir = join(fx.jarvisHome, "evals", "05-citizenship", "run");
    mkdirSync(runDir, { recursive: true });
    const good = await gradeRun({ runDir, repoPath: repo, revision: fixed, hidden, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot });
    expect(good).toMatchObject({ pass: true, revision: fixed, checks: [{ name: "unit", status: "pass" }] });
    const bad = await gradeRun({ runDir, repoPath: repo, revision: buggy, hidden, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot });
    expect(bad).toMatchObject({ pass: false, checks: [{ name: "unit", status: "fail" }] });
    expect(JSON.parse(readFileSync(join(runDir, "grade.json"), "utf8"))).toMatchObject({ pass: false, revision: buggy });
    for (const grade of [good, bad]) {
      expect(grade.projectDir.startsWith(join(runDir, "grade"))).toBe(true);
      const results = Ledger.open(grade.projectDir).entries().filter((e) => e.kind === "gate_result");
      expect(results).toHaveLength(1);
      expect(verifyEvidence(results[0]!)).toEqual({ ok: true, problems: [] });
    }
    // The candidate's checkout never kept the hidden test: the gate clones fresh and deletes it.
    expect(safeGit(repo, ["status", "--porcelain"], { home: fx.home }).toString()).toBe("");
    expect(existsSync(join(repo, "test", "hidden.test.mjs"))).toBe(false);
  });

  it("grades a recorded run from its summary, and refuses one that never started", async () => {
    const fx = fixture();
    const { repo, fixed } = runRepo(fx);
    const hidden = loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship"));
    const runDir = join(fx.jarvisHome, "evals", "05-citizenship", "baseline-x");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({ started: true, workspace: repo, finalCommit: fixed }));
    await expect(gradeRecordedRun(runDir, hidden, { jarvisHome: fx.jarvisHome, workRoot: fx.workRoot })).resolves.toMatchObject({ pass: true });
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({ started: false, workspace: repo, finalCommit: fixed }));
    await expect(gradeRecordedRun(runDir, hidden, { jarvisHome: fx.jarvisHome, workRoot: fx.workRoot })).rejects.toThrow(/never started/);
  });
});

describe("eval hidden checks: loading and installing", () => {
  it("installs an exact copy as approved protected checks, so a later edit reads as tampered", () => {
    const fx = fixture();
    const hidden = loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship"));
    expect(hidden.criteria).toEqual({ unit: [] });
    const projectDir = join(fx.jarvisHome, "p");
    const ledger = Ledger.open(projectDir);
    const store = installHiddenChecks(projectDir, ledger, hidden, "test");
    expect(store.verify(ledger).ok).toBe(true);
    expect(readFileSync(join(store.checksDir, "fixtures", "hidden.test.mjs"), "utf8")).toBe(readFileSync(join(hidden.dir, "fixtures", "hidden.test.mjs"), "utf8"));
    writeFileSync(join(store.checksDir, "verify.sh"), "echo JARVIS-CHECK-COMPLETE x\n");
    expect(store.verify(ledger)).toMatchObject({ ok: false, problems: ["check changed: verify.sh"] });
    expect(() => installHiddenChecks(projectDir, ledger, hidden, "again")).toThrow(/fresh/);
  });

  it("refuses symlinks, misnamed or malformed check files, and an empty folder", () => {
    const fx = fixture();
    const dir = hiddenDir(fx.evalsRepo, "05-citizenship");
    symlinkSync("/etc/hosts", join(dir, "fixtures", "hosts"));
    expect(() => loadHiddenChecks(dir)).toThrow(/symlinks/);
    const bad = join(fx.evalsRepo, "hidden", "x", "checks");
    mkdirSync(bad, { recursive: true });
    expect(() => loadHiddenChecks(bad)).toThrow(/no <name>\.check\.json/);
    writeFileSync(join(bad, "a.check.json"), JSON.stringify({ name: "b", cases: [{ id: "c", command: "true" }], verify: "true", timeoutMs: 1 }));
    expect(() => loadHiddenChecks(bad)).toThrow(/name must match/);
    writeFileSync(join(bad, "a.check.json"), JSON.stringify({ name: "a", cases: [], verify: "true", timeoutMs: 1 }));
    expect(() => loadHiddenChecks(bad)).toThrow(/cases/);
    expect(() => loadHiddenChecks(join(fx.evalsRepo, "hidden", "missing", "checks"))).toThrow(/no hidden checks/);
  });

  it("refuses a snapshot that overlaps the hidden folder or holds a hidden file's bytes, and ignores tiny files", () => {
    const fx = fixture();
    const dir = hiddenDir(fx.evalsRepo, "05-citizenship");
    const ws = join(fx.root, "ws");
    mkdirSync(join(ws, ".git"), { recursive: true });
    writeFileSync(join(ws, "tiny.txt"), "#!/bin/sh\n");
    writeFileSync(join(ws, ".git", "copy"), readFileSync(join(dir, "verify.sh"))); // git's own folder is not the snapshot's files
    expect(() => assertHiddenAbsent(ws, [dir])).not.toThrow();
    writeFileSync(join(ws, "check.sh"), readFileSync(join(dir, "verify.sh")));
    expect(() => assertHiddenAbsent(ws, [dir])).toThrow(/check\.sh \(= hidden verify\.sh\)/);
    expect(() => assertHiddenAbsent(fx.evalsRepo, [dir])).toThrow(/overlap/);
  });
});
