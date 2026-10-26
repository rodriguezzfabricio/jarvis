// Jarvis eval run tests, part 1 of 4 (bug tasks and hidden tests). The tests are split over four files so they run in parallel;
// the shared fixture is tests/unit/helpers/eval-jarvis-run-fixture.ts.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runJarvis, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { addHidden, addTask, fakeLoop, GRADE_CANARY, HIDDEN_MARKER, HIDDEN_TEST, markerGate } from "./eval-jarvis-fixture.ts";
import { counter, fixture, json, noHarness, options, passReview, removeFixtures } from "./helpers/eval-jarvis-run-fixture.ts";

afterEach(removeFixtures);

describe("eval jarvis: bug tasks (golden tasks 4 and 5) go triage → singleTaskPlan → the loop", () => {
  it("runs the loop on a fresh snapshot with production-shaped options and grades the final revision", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const g = markerGate();
    const task = loadTask(fx.evalsRepo, "05-citizenship");
    const r = await runJarvis(task, options(fx, { runLoop: fakeLoop("fix", undefined, calls), gate: g.gate, runId: "jarvis-r1" }));

    expect(r).toMatchObject({ outcome: "complete", claimedDone: true, pipeline: "single-task", triage: { type: "bug" }, started: true, usageLimited: false });
    expect(r.grade).toMatchObject({ pass: true, checks: [{ name: "unit", status: "pass" }] });
    expect(r.finalCommit).toBe(r.lastGreen);
    expect(r.diffStat).toContain("1 file changed");
    // The snapshot undid the fix in the files, with no history to find it in.
    expect(safeGit(r.workspace, ["show", `${r.baseRevision}:src/citizen.mjs`], { home: fx.home }).toString()).not.toContain("FIXED");
    expect(safeGit(r.workspace, ["rev-list", "--count", r.baseRevision], { home: fx.home }).toString().trim()).toBe("1");

    // One loop call, shaped like production: the task's budget, the hidden checks, the runner-owned project folder.
    expect(calls).toHaveLength(1);
    const o = calls[0]!;
    expect(o).toMatchObject({ runBranch: "main", repoPath: r.workspace, taskTimeoutMs: 2 * 60_000, maxTurns: 20, gitHome: fx.home });
    expect(Object.keys(o.checks)).toEqual(["unit"]);
    expect(o.checks.unit!.verify).toContain("gate-verify.sh"); // the project's own suite, never the grading checks (decision 97)
    expect(o.projectDir).toBe(join(r.resultsDir, "project"));
    expect(o.projectDir.startsWith(o.jarvisHome)).toBe(true);
    expect(o.worktreeRoot.startsWith(`${r.workspace}/`)).toBe(false);
    expect(o.harness).toBe(noHarness);
    expect(o.review).toBe(passReview);

    // The plan: one task, the unit check, the code review (decision 89: no intake or spec for a bug).
    const created = Ledger.open(o.projectDir).entries().filter((e) => e.kind === "task_created");
    expect(created.map((e) => [e.task_id, (e.data as { requiredChecks: string[] }).requiredChecks, (e.data as { requiredReviews: string[] }).requiredReviews])).toEqual([["T1", ["unit"], ["code"]]]);
    expect((created[0]!.data as { goal: string }).goal).toBe(task.prompt);

    // The baseline's layout: results in ~/.jarvis/evals/<task>/<run>, the workspace outside them.
    for (const f of ["manifest.json", "summary.json", "grade.json"]) expect(existsSync(join(r.resultsDir, f)), f).toBe(true);
    expect(r.resultsDir).toBe(join(fx.jarvisHome, "evals", "05-citizenship", "jarvis-r1"));
    expect(r.workspace).toBe(join(fx.workRoot, "evals", "05-citizenship", "jarvis-r1"));
    expect(json(join(r.resultsDir, "manifest.json"))).toMatchObject({ variant: "jarvis", pipeline: "single-task", allowedDomains: ["registry.npmjs.org", "proxy.golang.org"] });
    expect(json(join(r.resultsDir, "summary.json"))).toMatchObject({ outcome: "complete", claimedDone: true, finalCommit: r.finalCommit });
    // Grading ran on the final revision, in its own runner-owned folder.
    expect(g.calls.map((c) => [c.revision, c.check.name, c.projectDir.startsWith(join(r.resultsDir, "grade"))])).toEqual([[r.finalCommit, "unit", true]]);
    expect(existsSync(join(fx.workRoot, "cache-runs", "05-citizenship", "jarvis-r1"))).toBe(false);
  });

  it("starts nothing when the preflight fails, like the baseline", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    await expect(runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("fix", undefined, calls), preflight: async () => ({ ok: false }), runId: "jarvis-p" }))).rejects.toThrow(/preflight/);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(fx.workRoot, "evals", "05-citizenship", "jarvis-p"))).toBe(false);
  });

  it("refuses a task file that widens the eval allowlist (decision 79), before the preflight", async () => {
    const fx = fixture();
    const pre = counter();
    const task = { ...loadTask(fx.evalsRepo, "05-citizenship"), allowedDomains: ["api.github.com"] };
    await expect(runJarvis(task, options(fx, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/allowlist/);
    expect(pre.count).toBe(0);
  });

  it("needs a hidden unit check for a bug task, and refuses non-build tasks, before the preflight", async () => {
    const fx = fixture();
    const pre = counter();
    addTask(fx, "05-nounit", "The citizenship filter is missing some jobs.");
    addHidden(fx, "05-nounit", "checks", { unit: [] });
    addHidden(fx, "05-nounit", "gate", { smoke: [] });
    await expect(runJarvis(loadTask(fx.evalsRepo, "05-nounit"), options(fx, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/gate check named "unit"/);
    addTask(fx, "03-review", "Review the outreach code before I ship it.");
    addHidden(fx, "03-review", "checks", { unit: [] });
    await expect(runJarvis(loadTask(fx.evalsRepo, "03-review"), options(fx, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/not a build-loop task/);
    addTask(fx, "05-nohidden", "The citizenship filter is missing some jobs.");
    await expect(runJarvis(loadTask(fx.evalsRepo, "05-nohidden"), options(fx, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/no hidden checks/);
    expect(pre.count).toBe(0);
  });

  it("refuses to run without hidden/<task>/gate/, before the preflight: the grading checks never gate the loop (decision 97)", async () => {
    const fx = fixture();
    const pre = counter();
    addTask(fx, "05-nogate", "The citizenship filter is missing some jobs.");
    addHidden(fx, "05-nogate", "checks", { unit: [] });
    const calls: RunLoopOptions[] = [];
    await expect(runJarvis(loadTask(fx.evalsRepo, "05-nogate"), options(fx, { runLoop: fakeLoop("fix", undefined, calls), preflight: pre.fn }))).rejects.toThrow(/needs hidden\/05-nogate\/gate\//);
    expect(pre.count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("gives the loop the gate checks as installed and locked, not as first parsed", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const descriptor = join(fx.evalsRepo, "hidden", "05-citizenship", "gate", "unit.check.json");
    const changed = { ...JSON.parse(readFileSync(descriptor, "utf8")), cases: [{ id: "unit", command: "node --test --test-reporter=tap" }] };
    // The evals repo changes after the first load, while the preflight runs.
    const preflight = async () => { writeFileSync(descriptor, JSON.stringify(changed)); return { ok: true }; };
    await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("fix", undefined, calls), preflight }));
    expect(calls[0]!.checks.unit!.cases).toEqual(changed.cases);
    expect(JSON.parse(readFileSync(join(calls[0]!.projectDir, "checks", "unit.check.json"), "utf8")).cases).toEqual(changed.cases);
  });

  it("refuses gate checks that hold any grading file, before the preflight", async () => {
    const fx = fixture();
    const pre = counter();
    writeFileSync(join(fx.evalsRepo, "hidden", "05-citizenship", "gate", "copied.test.mjs"), HIDDEN_TEST);
    await expect(runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/gate checks hold grading files.*copied\.test\.mjs/);
    expect(pre.count).toBe(0);
  });

  it("grades on hidden/<task>/checks/ only after the loop, in its own folder: none of it is in the loop's project folder", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const g = markerGate();
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("fix", undefined, calls), gate: g.gate }));
    expect(g.calls.map((c) => c.check.name)).toEqual(["unit"]);
    expect(g.calls[0]!.check.verify).toContain("$JARVIS_CHECKS/verify.sh");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(calls[0]!.projectDir)) expect(readFileSync(f).includes(GRADE_CANARY), f).toBe(false);
    expect(r.grade?.pass).toBe(true);
  });
});

describe("eval jarvis: the hidden tests never reach a session", () => {
  it("keeps every hidden file out of the snapshot repo, at every revision, and in a folder sessions can't read", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("fix", undefined, calls) }));
    const revs = safeGit(r.workspace, ["rev-list", "--all"], { home: fx.home }).toString().trim().split("\n");
    expect(revs.length).toBeGreaterThan(1);
    for (const rev of revs) expect(() => safeGit(r.workspace, ["grep", "-q", HIDDEN_MARKER, rev], { home: fx.home }), rev).toThrow();
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(r.workspace)) expect(readFileSync(f).includes(HIDDEN_MARKER), f).toBe(false);
    // The loop's checks are the gate's, installed under the runner-owned home, which task settings deny (decision 69);
    // the grading checks and their hidden test are not among them (decision 97).
    const checksDir = join(calls[0]!.projectDir, "checks");
    expect(existsSync(join(checksDir, "gate-verify.sh"))).toBe(true);
    expect(checksDir.startsWith(`${fx.jarvisHome}/`)).toBe(true);
    for (const f of walk(checksDir)) expect(readFileSync(f).includes(HIDDEN_MARKER), f).toBe(false);
  });

  it("refuses, before any session, a snapshot that already contains a hidden test (a source revision with the fix's tests)", async () => {
    const fx = fixture();
    writeFileSync(join(fx.sourceRepo, "hidden.test.mjs"), HIDDEN_TEST);
    safeGit(fx.sourceRepo, ["add", "-A"], { home: fx.home });
    safeGit(fx.sourceRepo, ["commit", "-q", "-m", "fix tests"], { home: fx.home });
    const rev = safeGit(fx.sourceRepo, ["rev-parse", "HEAD"], { home: fx.home }).toString().trim();
    addTask(fx, "05-leaky", "The citizenship filter is missing some jobs.", { rev, revert: [fx.fixRev] });
    addHidden(fx, "05-leaky", "checks", { unit: [] });
    addHidden(fx, "05-leaky", "gate", { unit: [] });
    const calls: RunLoopOptions[] = [];
    await expect(runJarvis(loadTask(fx.evalsRepo, "05-leaky"), options(fx, { runLoop: fakeLoop("fix", undefined, calls) }))).rejects.toThrow(/hidden check files are in the snapshot: hidden\.test\.mjs/);
    expect(calls).toHaveLength(0);
  });
});
