import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { loadTask, runBaseline } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { assertHiddenAbsent, assertHiddenDisjoint, gradeRecordedRun, gradeRun, hiddenDir, installHiddenChecks, loadHiddenChecks, suiteFingerprint } from "../../packages/cli/src/eval/hidden.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { fakeClaudeBin } from "../helpers.ts";
import { addTask, BUGGY, createEvalFixture, FIXED, HIDDEN_TEST, type EvalFixture } from "./eval-jarvis-fixture.ts";

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
    expect(JSON.parse(readFileSync(join(runDir, "grade.json"), "utf8"))).toMatchObject({ pass: false, revision: buggy, suite: good.suite });
    expect(good.suite).toMatch(/^[0-9a-f]{64}$/);
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

describe("eval baseline: the same hidden-file leak check before its session", () => {
  it("refuses a snapshot holding a hidden test and never starts the session; passes a clean one", async () => {
    const fx = fixture();
    const bin = fakeClaudeBin(fx.root);
    const hiddenDirs = [loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship")).dir, loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship", "gate")).dir];
    const run = (task: ReturnType<typeof loadTask>, runId: string, marker: string) => runBaseline(task, { preflight: async () => ({ ok: true }), claudeBin: bin, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, runId, parentEnv: { HOME: fx.home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "baseline", FAKE_CLAUDE_MARKER: marker }, hiddenDirs });
    writeFileSync(join(fx.sourceRepo, "hidden.test.mjs"), HIDDEN_TEST);
    safeGit(fx.sourceRepo, ["add", "-A"], { home: fx.home });
    safeGit(fx.sourceRepo, ["commit", "-q", "-m", "fix tests"], { home: fx.home });
    addTask(fx, "05-leaky", "The citizenship filter is missing some jobs.", { rev: safeGit(fx.sourceRepo, ["rev-parse", "HEAD"], { home: fx.home }).toString().trim(), revert: [fx.fixRev] });
    const marker = join(fx.root, "baseline-started");
    await expect(run(loadTask(fx.evalsRepo, "05-leaky"), "baseline-leak", marker)).rejects.toThrow(/hidden check files are in the snapshot: hidden\.test\.mjs/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(fx.workRoot, "cache-runs", "05-leaky", "baseline-leak"))).toBe(false);
    await expect(run(loadTask(fx.evalsRepo, "05-citizenship"), "baseline-ok", marker)).resolves.toMatchObject({ started: true });
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

  it("runs the descriptors it fingerprinted: a check changed after the first load is graded as installed, not as first parsed", async () => {
    const fx = fixture();
    const dir = hiddenDir(fx.evalsRepo, "05-citizenship");
    const early = loadHiddenChecks(dir); // parsed before the run, as both arms do
    const descriptor = join(dir, "unit.check.json");
    const changed = { ...JSON.parse(readFileSync(descriptor, "utf8")), cases: [{ id: "unit", command: "true" }] };
    writeFileSync(descriptor, JSON.stringify(changed)); // the evals repo changes during the run
    const runDir = join(fx.jarvisHome, "evals", "05-citizenship", "run");
    mkdirSync(runDir, { recursive: true });
    const ran: string[] = [];
    const grade = await gradeRun({
      runDir, repoPath: fx.sourceRepo, revision: fx.fixRev, hidden: early, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot,
      gate: async (g) => {
        ran.push(JSON.stringify(g.check.cases));
        expect(g.store.verify(g.ledger).ok).toBe(true); // what runs is the approved, locked copy
        return { status: "pass", entry: g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { check: g.check.name, revision: g.revision, status: "pass" } }), evidenceDir: g.projectDir };
      },
    });
    expect(ran).toEqual([JSON.stringify(changed.cases)]);
    expect(early.checks.unit!.cases[0]!.command).not.toBe("true");
    const installed = new ChecksStore(grade.projectDir);
    expect(JSON.parse(readFileSync(join(installed.checksDir, "unit.check.json"), "utf8")).cases).toEqual(changed.cases);
    expect(grade.suite).toBe(suiteFingerprint(installed.hashAll()));
  });

  it("fingerprints the whole suite: any changed, added or removed file gives a different suite", () => {
    const base = { "unit.check.json": "1".repeat(64), "verify.sh": "2".repeat(64) };
    const f = suiteFingerprint(base);
    expect(suiteFingerprint({ "verify.sh": "2".repeat(64), "unit.check.json": "1".repeat(64) })).toBe(f);
    expect(suiteFingerprint({ ...base, "verify.sh": "3".repeat(64) })).not.toBe(f);
    expect(suiteFingerprint({ ...base, "expected/a.txt": "4".repeat(64) })).not.toBe(f);
    expect(suiteFingerprint({ "unit.check.json": "1".repeat(64) })).not.toBe(f);
  });

  it("keeps the gate checks disjoint from the grading checks (decision 97)", () => {
    const fx = fixture();
    const grading = loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship"));
    const gate = loadHiddenChecks(hiddenDir(fx.evalsRepo, "05-citizenship", "gate"));
    expect(() => assertHiddenDisjoint(gate, grading)).not.toThrow();
    expect(() => assertHiddenDisjoint(grading, grading)).toThrow(/different folders/);
    writeFileSync(join(gate.dir, "expected.txt"), readFileSync(join(grading.dir, "verify.sh")));
    expect(() => assertHiddenDisjoint(gate, grading)).toThrow(/expected\.txt \(= grading verify\.sh\)/);
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
