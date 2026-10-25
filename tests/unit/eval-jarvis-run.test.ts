import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runJarvis, type JarvisEvalOptions, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { runSchedule } from "../../packages/cli/src/eval/schedule.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Harness, TaskInput, TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { addHidden, addTask, createEvalFixture, FEATURE_PROMPT, fakeLoop, GRADE_CANARY, HIDDEN_MARKER, HIDDEN_TEST, markerGate, SPEC, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fixture = () => { const f = createEvalFixture(); fixtures.push(f); return f; };

const counter = () => { let n = 0; return { fn: async () => { n++; return { ok: true }; }, get count() { return n; } }; };
const noHarness: Harness = { runTask: async () => { throw new Error("no session expected"); } };
const passReview = async () => "pass" as const;
function options(fx: EvalFixture, o: Partial<JarvisEvalOptions> & Pick<JarvisEvalOptions, "runLoop">): JarvisEvalOptions {
  return { preflight: async () => ({ ok: true }), evalsRepo: fx.evalsRepo, harness: noHarness, review: passReview, gate: markerGate().gate, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, ...o };
}
const json = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const finished = (extra: Partial<TaskOutcome> = {}): TaskOutcome => ({ status: "finished", exitCode: 0, durationMs: 5, usage: [], usageWaitUntil: undefined, ...extra } as TaskOutcome);

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
    expect(json(join(r.resultsDir, "manifest.json"))).toMatchObject({ variant: "jarvis", pipeline: "single-task", allowedDomains: ["registry.npmjs.org", "localhost"] });
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

describe("eval jarvis: fault cases", () => {
  it("records a crashed run, grades what it left, and never calls it done", async () => {
    const fx = fixture();
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("crash") }));
    expect(r).toMatchObject({ outcome: "crashed", claimedDone: false, started: true, lastGreen: null, error: "worktree vanished mid-task" });
    expect(r.finalCommit).toBe(r.baseRevision);
    expect(r.grade).toMatchObject({ pass: false, revision: r.baseRevision });
    expect(json(join(r.resultsDir, "summary.json"))).toMatchObject({ outcome: "crashed" });
  });

  it("reports a crash before any session as not started, so the scheduler stops instead of counting it", async () => {
    const fx = fixture();
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("crash-before-start") }));
    expect(r).toMatchObject({ outcome: "crashed", started: false, claimedDone: false });
  });

  it("records a blocked task with its repairs (decision 87: 2 repairs, then blocked)", async () => {
    const fx = fixture();
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("blocked") }));
    expect(r).toMatchObject({ outcome: "blocked", claimedDone: false, lastGreen: null, loop: { status: "blocked", blocked: ["T1"] } });
    expect(r.metrics).toMatchObject({ repairs: 3, sessions: { build: 3, review: 0, planner: 0, total: 3 } });
    expect(r.metrics.tasks).toEqual([{ id: "T1", status: "blocked", attempts: 3, repairs: 3, blockedReason: "3 failed attempts" }]);
    expect(r.grade?.pass).toBe(false);
  });

  it("counts a usage wait inside the loop as waiting, not as a failure or a repair", async () => {
    const fx = fixture();
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), options(fx, { runLoop: fakeLoop("usage-wait") }));
    expect(r).toMatchObject({ outcome: "complete", claimedDone: true, usageLimited: false });
    expect(r.metrics).toMatchObject({ repairs: 0, usageWaits: { count: 1, waitMs: 3_600_000 } });
    expect(r.grade?.pass).toBe(true);
  });

  it("waits out a usage-limited preflight and retries the same task with a jarvis- run id", async () => {
    const fx = fixture();
    let n = 0;
    const slept: number[] = [];
    const preflight = async () => (n++ === 0 ? { ok: false, waitUntil: 1_000 } : { ok: true });
    const out = await runSchedule(["05-citizenship"], 1, "t", {
      prefix: "jarvis",
      loadTask: (id) => loadTask(fx.evalsRepo, id),
      runOne: (task, runId) => runJarvis(task, options(fx, { runLoop: fakeLoop("fix"), preflight, runId })),
      sleepUntil: async (t) => { slept.push(t); },
      nowMs: () => 0,
      log: () => {},
    });
    expect(slept).toEqual([1_120]);
    expect(out.stopped).toBeUndefined();
    expect(out.completed).toHaveLength(1);
    expect(out.completed[0]!.runId).toMatch(/^jarvis-.*-t-r1-a2$/);
  });
});

describe("eval jarvis: task 2 takes the written spec, then the planning path", () => {
  const planFile = (tasks: unknown[]) => JSON.stringify({ tasks });
  const T = (id: string, acs: string[], checks: string[], deps: string[] = []) => ({ id, title: id, goal: `do ${id}`, exitCondition: `${id} checks pass`, acceptanceCriteria: acs, storyIds: ["S1"], dependencies: deps, priority: 1, requiredChecks: checks, requiredReviews: ["code"] });
  function planner(write: string | null, outcome: TaskOutcome = finished()): { harness: Harness; inputs: TaskInput[] } {
    const inputs: TaskInput[] = [];
    return { inputs, harness: { runTask: async (input) => {
      inputs.push(input);
      if (write !== null) { const dir = join(input.workspace, ".jarvis"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "plan.json"), write); }
      return outcome;
    } } };
  }
  function featureTask(fx: EvalFixture, spec: string | null = SPEC, gate: Record<string, string[]> = { unit: [], greet: ["AC1", "AC2"] }) {
    addTask(fx, "02-greet", FEATURE_PROMPT, { revert: [fx.fixRev], ...(spec ? { spec } : {}) });
    addHidden(fx, "02-greet", "checks", { greet: ["AC1", "AC2"] });
    addHidden(fx, "02-greet", "gate", gate);
    return loadTask(fx.evalsRepo, "02-greet");
  }

  it("commits the approved spec, runs one planner session, reads the plan against the runner's spec and checks, then runs the loop", async () => {
    const fx = fixture();
    const p = planner(planFile([T("T1", ["AC1"], ["unit", "greet"]), T("T2", ["AC2"], ["greet"], ["T1"])]));
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(featureTask(fx), options(fx, { harness: p.harness, runLoop: fakeLoop("fix", { "src/greet.mjs": "FIXED\n" }, calls), gate: markerGate("src/greet.mjs").gate }));
    expect(r).toMatchObject({ pipeline: "spec", triage: { type: "feature" }, outcome: "complete", claimedDone: true });
    expect(r.metrics.sessions).toMatchObject({ planner: 1, build: 2, review: 2, total: 5 });
    // The approved spec is in the repo, as intake would leave it; the planner started from that commit.
    expect(safeGit(r.workspace, ["show", `${r.baseRevision}:docs/spec/v1.md`], { home: fx.home }).toString()).toBe(SPEC);
    expect(p.inputs).toHaveLength(1);
    expect(p.inputs[0]).toMatchObject({ role: "architect", maxTurns: 20, timeoutMs: 120_000 });
    expect(p.inputs[0]!.workspace.startsWith(calls[0]!.worktreeRoot)).toBe(true);
    expect(existsSync(p.inputs[0]!.workspace)).toBe(false);
    // The planner learns check names and the criteria they cover, never their contents.
    expect(p.inputs[0]!.prompt).toContain("- greet: AC1, AC2");
    expect(p.inputs[0]!.prompt).toContain("docs/spec/v1.md");
    expect(p.inputs[0]!.prompt).not.toContain("JARVIS-CHECK-COMPLETE");
    expect(p.inputs[0]!.prompt).not.toContain(HIDDEN_MARKER);
    const created = Ledger.open(calls[0]!.projectDir).entries().filter((e) => e.kind === "task_created").map((e) => e.task_id);
    expect(created).toEqual(["T1", "T2"]);
    const usage = Ledger.open(calls[0]!.projectDir).entries().filter((e) => e.kind === "session_usage");
    expect(usage.map((e) => [e.task_id, (e.data as { role: string }).role])).toEqual([["plan", "architect"], ["T1", "debug"], ["T2", "debug"]]);
  });

  it("refuses a feature task without a written spec, or whose criteria no installed check covers, before the preflight", async () => {
    const fx = fixture();
    const pre = counter();
    await expect(runJarvis(featureTask(fx, null), options(fx, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/spec\.md/);
    const fx2 = fixture();
    await expect(runJarvis(featureTask(fx2, SPEC, { unit: [], greet: ["AC1"] }), options(fx2, { runLoop: fakeLoop("fix"), preflight: pre.fn }))).rejects.toThrow(/no installed check covers AC2/);
    expect(pre.count).toBe(0);
  });

  it("records an invalid plan as plan-failed and never starts the loop", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const p = planner(planFile([T("T1", ["AC1"], ["greet"])])); // AC2 uncovered
    const r = await runJarvis(featureTask(fx), options(fx, { harness: p.harness, runLoop: fakeLoop("fix", undefined, calls) }));
    expect(r).toMatchObject({ outcome: "plan-failed", claimedDone: false, started: true });
    expect(r.error).toMatch(/plan does not cover AC2/);
    expect(calls).toHaveLength(0);
  });

  it("reports a usage-limited planner as usage-limited, with its reset, so the scheduler waits and retries", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const p = planner(null, { status: "usage-limited", resetAt: 1_792_790_000, exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: 1_792_790_000 });
    const r = await runJarvis(featureTask(fx), options(fx, { harness: p.harness, runLoop: fakeLoop("fix", undefined, calls) }));
    expect(r).toMatchObject({ outcome: "usage-limited", usageLimited: true, usageWaitUntil: 1_792_790_000, grade: null });
    expect(calls).toHaveLength(0);
  });
});
