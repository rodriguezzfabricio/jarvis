// The Jarvis arm on a review that asks for fixes (golden task 3's shape; decision 126, backlog 109): a
// review session writes the report in its checkout, the runner commits it, a bug task per finding runs
// through the loop, then a report-update task records what happened. Fault injection: no report, a
// symlinked report, a session that didn't finish; and a plain review still has no build-loop arm.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { pipelineFor, runJarvis, type RunLoop, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Harness, TaskInput, TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { BUG_EXIT_CONDITION } from "../../packages/cli/src/runner/plan.ts";
import { REVIEW_FINDINGS_FILE } from "../../packages/cli/src/runner/review-fix.ts";
import { addHidden, addTask, FIXED, type EvalFixture } from "./eval-jarvis-fixture.ts";
import { finished, fixture, json, options, removeFixtures } from "./helpers/eval-jarvis-run-fixture.ts";
import { CODEX_PHRASINGS } from "./helpers/review-fix-phrasings.ts";

afterEach(removeFixtures);

const REQUEST = "Review the citizenship filter before I ship it. Put what you find in REVIEW.md and fix the real problems.";
const git = (cwd: string, home: string, args: string[]) => safeGit(cwd, args, { home }).toString().trim();
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** The task's runner-owned opt-in (decision 126, round 3): `true`, `{ limits }`, or null for none. */
function setReviewFix(fx: EvalFixture, id: string, reviewFix: unknown): void {
  const path = join(fx.evalsRepo, "tasks", id, "task.json");
  const task = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (reviewFix === null) delete task.reviewFix; else task.reviewFix = reviewFix;
  writeFileSync(path, JSON.stringify(task, null, 2));
}
function reviewTask(fx: EvalFixture, request = REQUEST, id = "03-review", reviewFix: unknown = true) {
  addTask(fx, id, request, { revert: [fx.fixRev] });
  addHidden(fx, id, "checks", { unit: [] });
  addHidden(fx, id, "gate", { unit: [] });
  setReviewFix(fx, id, reviewFix);
  return loadTask(fx.evalsRepo, id);
}

const REPORT = [
  "# Review of the citizenship filter", "",
  "## F1: src/citizen.mjs:2 (high)", "The test runs on raw HTML. Fix: test the visible text.", "",
  "## Not a problem", "- test/citizen.test.mjs:1: imports only node:test", "",
].join("\n");
const FINDINGS = JSON.stringify({
  request: REQUEST, report: "REVIEW.md",
  findings: [{ id: "F1", title: "Markup and no-break spaces hide the phrase", severity: "high", confidence: "high", file: "src/citizen.mjs", line: 2,
    evidence: "Every job page passes its HTML to requiresCitizenship; the regex runs on the raw markup.", fix: "Strip tags and fold no-break spaces before the test." }],
  cleared: [{ file: "test/citizen.test.mjs", line: 1, what: "test imports", why: "only node:test and the module under test" }],
});

/** A fake review-step session: `write` acts on its workspace; every call is recorded with its header. */
function reviewer(write: (ws: string) => void, outcome: TaskOutcome = finished()): { harness: Harness; inputs: (TaskInput & { header: string })[] } {
  const inputs: (TaskInput & { header: string })[] = [];
  return { inputs, harness: { runTask: async (input) => {
    inputs.push({ ...input, header: readFileSync(input.runHeaderPath, "utf8") });
    write(input.workspace);
    return outcome;
  } } };
}
const writesReport = (ws: string) => { put(ws, "REVIEW.md", REPORT); put(ws, REVIEW_FINDINGS_FILE, FINDINGS); };

/**
 * A fake runner/loop.ts that, like the real one, runs only the tasks not yet passed or blocked: a fix task
 * commits the fix, the update task appends a status line to the report. Each call is its own run.
 */
function reviewFixLoop(calls: RunLoopOptions[], o: { block?: string[] } = {}): RunLoop {
  return async (opts) => {
    calls.push(opts);
    const ledger = Ledger.open(opts.projectDir);
    const g = (args: string[]) => git(opts.repoPath, opts.gitHome!, args);
    const runId = `loop-${calls.length}`;
    const settled = new Set(ledger.entries().filter((e) => e.kind === "state_reached" || e.kind === "blocked").map((e) => e.task_id));
    const pending = ledger.entries().filter((e) => e.kind === "task_created" && !settled.has(e.task_id));
    ledger.append({ kind: "run_started", actor: "runner", data: { runId, pid: process.pid } });
    for (const e of pending) {
      const id = e.task_id!;
      const def = e.data as { mayTouch?: string[]; requiredChecks: string[] };
      ledger.append({ kind: "attempt_started", actor: "runner", task_id: id, attempt_id: "a1", data: { runId, baseRevision: g(["rev-parse", "HEAD"]) } });
      if (o.block?.includes(id)) { ledger.append({ kind: "blocked", actor: "runner", task_id: id, data: { reason: "3 failed attempts" } }); continue; }
      if (def.mayTouch?.includes("REVIEW.md")) put(opts.repoPath, "REVIEW.md", `${readFileSync(join(opts.repoPath, "REVIEW.md"), "utf8")}\nStatus: updated by ${id}\n`);
      else put(opts.repoPath, "src/citizen.mjs", FIXED);
      g(["add", "-A"]);
      g(["commit", "-q", "--allow-empty", "-m", `candidate ${id}`]);
      const rev = g(["rev-parse", "HEAD"]);
      ledger.append({ kind: "attempt_ended", actor: "runner", task_id: id, attempt_id: "a1", data: { status: "completed", candidateRevision: rev } });
      for (const check of def.requiredChecks) ledger.append({ kind: "gate_result", actor: "runner", task_id: id, attempt_id: "a1", data: { check, revision: rev, status: "pass" } });
      const verdict = await opts.review({ taskId: id, attemptId: "a1", revision: rev });
      ledger.append({ kind: "review_result", actor: "runner", task_id: id, attempt_id: "a1", data: { reviewer: "code", revision: rev, status: verdict } });
      ledger.append({ kind: "state_reached", actor: "runner", task_id: id, attempt_id: "a1", data: { state: "passed", revision: rev } });
      g(["tag", "-f", "last-green", rev]);
    }
    ledger.append({ kind: "run_ended", actor: "runner", data: { runId } });
    const entries = ledger.entries();
    const all = entries.filter((e) => e.kind === "task_created").map((e) => e.task_id!);
    const done = all.filter((id) => entries.some((e) => e.kind === "state_reached" && e.task_id === id));
    const blocked = all.filter((id) => !done.includes(id));
    return { status: blocked.length ? "blocked" : "complete", done, blocked };
  };
}
const created = (projectDir: string) => Ledger.open(projectDir).entries().filter((e) => e.kind === "task_created").map((e) => ({ id: e.task_id!, ...(e.data as { goal: string; exitCondition: string; mayTouch?: string[]; requiredChecks: string[] }) }));
const show = (repo: string, home: string, rev: string, path: string) => git(repo, home, ["show", `${rev}:${path}`]);

describe("eval jarvis: a review that asks for fixes (golden task 3's shape)", () => {
  it("has a pipeline only when the task opts in, never from the request's words", () => {
    expect(pipelineFor("review", true)).toBe("review-fix");
    expect(() => pipelineFor("review", false)).toThrow(/not a build-loop task/);
    expect(() => pipelineFor("review")).toThrow(/runner-owned reviewFix/);
    expect(pipelineFor("bug")).toBe("single-task");
  });

  it("starts nothing for a review that asks for fixes in words but has no runner-owned opt-in", async () => {
    for (const [i, request] of [REQUEST, ...CODEX_PHRASINGS.filter((p) => p.startsWith("Review"))].entries()) {
      const fx = fixture();
      let preflights = 0;
      const task = reviewTask(fx, request, `03-words-${i}`, null);
      const error = await runJarvis(task, options(fx, { preflight: async () => { preflights++; return { ok: true }; }, runLoop: reviewFixLoop([]) })).then(() => "ran", (e: unknown) => String(e));
      expect(error, request).toMatch(/triage says review: not a build-loop task/);
      expect(preflights, request).toBe(0);
    }
  });

  it("refuses an opt-in that isn't exactly true or a limits object", async () => {
    for (const bad of ["yes", 1, { limits: "public API" }, { limits: [""] }, { limits: ["x"], extra: true }, false]) {
      const fx = fixture();
      const task = reviewTask(fx, REQUEST, "03-bad", bad);
      const error = await runJarvis(task, options(fx, { runLoop: reviewFixLoop([]) })).then(() => "ran", (e: unknown) => String(e));
      expect(error, JSON.stringify(bad)).toMatch(/reviewFix/);
    }
  });

  it("reviews, commits the session's report, fixes each finding through the loop, then records what happened in the report", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const s = reviewer(writesReport);
    const r = await runJarvis(reviewTask(fx), options(fx, { harness: s.harness, runLoop: reviewFixLoop(calls), runId: "jarvis-rf" }));

    expect(r).toMatchObject({ outcome: "complete", claimedDone: true, pipeline: "review-fix", triage: { type: "review" }, started: true });
    // The review step: one session in a fresh checkout of the snapshot, as the reviewer, with the review skill as text.
    expect(s.inputs).toHaveLength(1);
    const step = s.inputs[0]!;
    expect(step.role).toBe("review");
    expect(step.prompt).toContain(REQUEST);
    expect(step.prompt).toContain("REVIEW.md");
    expect(step.prompt).toContain(REVIEW_FINDINGS_FILE);
    expect(step.header).toContain("<skill name=\"review\">");
    expect(step.header).not.toContain("<skill name=\"build\">");
    expect(step.workspace.startsWith(join(fx.workRoot, "evals", "03-review", "jarvis-rf.wt"))).toBe(true);

    // The report is the session's file, committed on the run branch before any fix, and it reaches the final revision.
    const ws = r.workspace;
    expect(r.review?.reportRevision).toBeDefined();
    expect(show(ws, fx.home, r.review!.reportRevision!, "REVIEW.md")).toBe(REPORT.trimEnd());
    // The report commit is the fixes' base, as task 2's runner-committed spec is its base; it sits on the snapshot.
    expect(r.review!.reportRevision).toBe(r.baseRevision);
    expect(git(ws, fx.home, ["rev-parse", `${r.baseRevision}^`])).toBe(r.snapshot.commit);
    expect(git(ws, fx.home, ["diff-tree", "--no-commit-id", "--name-only", "-r", r.baseRevision])).toBe("REVIEW.md");
    expect(r.finalCommit).toBe(r.lastGreen);
    expect(show(ws, fx.home, r.finalCommit, "REVIEW.md")).toContain("Status: updated by T2");
    expect(show(ws, fx.home, r.finalCommit, "src/citizen.mjs")).toContain("FIXED");
    expect(r.diffStat).toContain("2 files changed");

    // Two loop runs: the fix task (decision 114's exit condition), then the report update, which may touch only the report.
    expect(calls).toHaveLength(2);
    const tasks = created(calls[0]!.projectDir);
    expect(tasks.map((t) => [t.id, t.requiredChecks])).toEqual([["T1", ["unit"]], ["T2", ["unit"]]]);
    expect(tasks[0]!.exitCondition).toContain(BUG_EXIT_CONDITION);
    expect(tasks[0]!.goal).toContain("src/citizen.mjs:2");
    expect(tasks[0]!.goal).toMatch(/claim/);
    expect(tasks[1]!.mayTouch).toEqual(["REVIEW.md"]);
    expect(tasks[1]!.goal).toMatch(/F1 .*: fixed/);

    expect(r.review?.outcomes.map((o) => [o.id, o.status])).toEqual([["F1", "fixed"]]);
    expect(r.review).toMatchObject({ report: "REVIEW.md", findings: 1, cleared: 1, updated: true });
    expect(json(join(r.resultsDir, "summary.json"))).toMatchObject({ pipeline: "review-fix", review: { report: "REVIEW.md", updated: true } });
    expect(json(join(r.resultsDir, "manifest.json"))).toMatchObject({ pipeline: "review-fix", review: { report: "REVIEW.md" } });
    expect(r.metrics.sessions.planner).toBe(1); // the review step, counted with the sessions before the loop
    expect(r.grade).toMatchObject({ pass: true });
  });

  it("says what wasn't fixed: a blocked fix task is recorded, and the update still runs", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(reviewTask(fx), options(fx, { harness: reviewer(writesReport).harness, runLoop: reviewFixLoop(calls, { block: ["T1"] }) }));
    expect(r.outcome).toBe("blocked");
    expect(r.claimedDone).toBe(false);
    expect(calls).toHaveLength(2);
    expect(r.review?.outcomes).toEqual([expect.objectContaining({ id: "F1", status: "not-fixed", task: "T1" })]);
    expect(created(calls[0]!.projectDir)[1]!.goal).toContain("3 failed attempts");
    expect(show(r.workspace, fx.home, r.finalCommit, "REVIEW.md")).toContain("Status: updated by T2");
    expect(show(r.workspace, fx.home, r.finalCommit, "src/citizen.mjs")).not.toContain("FIXED");
  });

  it("starts no fixes when the review session wrote no report, and says so", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(reviewTask(fx), options(fx, { harness: reviewer((ws) => put(ws, REVIEW_FINDINGS_FILE, FINDINGS)).harness, runLoop: reviewFixLoop(calls) }));
    expect(r.outcome).toBe("review-failed");
    expect(r.error).toMatch(/wrote no report at REVIEW\.md/);
    expect(r.error).toMatch(/no fixes were started/);
    expect(calls).toHaveLength(0);
    expect(created(join(r.resultsDir, "project"))).toEqual([]);
    expect(r).toMatchObject({ claimedDone: false, started: true, finalCommit: r.baseRevision });
  });

  it("refuses a report the session made a symlink, even to a file in its checkout", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const harness = reviewer((ws) => { put(ws, "notes.md", REPORT); symlinkSync("notes.md", join(ws, "REVIEW.md")); put(ws, REVIEW_FINDINGS_FILE, FINDINGS); }).harness;
    const r = await runJarvis(reviewTask(fx), options(fx, { harness, runLoop: reviewFixLoop(calls) }));
    expect(r.outcome).toBe("review-failed");
    expect(r.error).toMatch(/REVIEW\.md is refused/);
    expect(calls).toHaveLength(0);
    expect(() => show(r.workspace, fx.home, r.finalCommit, "REVIEW.md")).toThrow();
  });

  it("starts no fixes when the review session didn't finish, and stops on a usage limit", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const timeout = { status: "timeout", exitCode: null, durationMs: 5, usage: [], usageWaitUntil: undefined } as TaskOutcome;
    const r = await runJarvis(reviewTask(fx), options(fx, { harness: reviewer(writesReport, timeout).harness, runLoop: reviewFixLoop(calls) }));
    expect(r.outcome).toBe("review-failed");
    expect(r.error).toMatch(/review session timeout/);
    expect(calls).toHaveLength(0);
    const fx2 = fixture();
    const limited = { status: "usage-limited", resetAt: 1_792_790_000, exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: 1_792_790_000 } as TaskOutcome;
    const u = await runJarvis(reviewTask(fx2), options(fx2, { harness: reviewer(() => {}, limited).harness, runLoop: reviewFixLoop([]) }));
    expect(u).toMatchObject({ outcome: "usage-limited", usageLimited: true, usageWaitUntil: 1_792_790_000 });
  });

  it("delivers the report alone when the review found nothing to fix, and discards anything else the session changed", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const clean = JSON.stringify({ request: REQUEST, report: "REVIEW.md", findings: [], cleared: [{ file: "src/citizen.mjs", line: 2, what: "the regex", why: "checked" }] });
    const harness = reviewer((ws) => { put(ws, "REVIEW.md", "# Review\n\nNo problems.\n\n## Not a problem\n- src/citizen.mjs:2\n"); put(ws, REVIEW_FINDINGS_FILE, clean); put(ws, "src/citizen.mjs", "// edited by the review\n"); }).harness;
    const r = await runJarvis(reviewTask(fx), options(fx, { harness, runLoop: reviewFixLoop(calls) }));
    expect(r).toMatchObject({ outcome: "complete", claimedDone: true });
    expect(calls).toHaveLength(0);
    expect(r.finalCommit).toBe(r.review!.reportRevision);
    expect(show(r.workspace, fx.home, r.finalCommit, "REVIEW.md")).toContain("No problems.");
    expect(show(r.workspace, fx.home, r.finalCommit, "src/citizen.mjs")).not.toContain("edited by the review");
    expect(r.metrics.problems.join("\n")).toMatch(/review session also changed src\/citizen\.mjs; discarded/);
  });

  it("hands the opt-in's limits to every fix task, and never derives a limit from the request's words", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(reviewTask(fx, REQUEST, "03-limited", { limits: ["make no changes to the public API"] }), options(fx, { harness: reviewer(writesReport).harness, runLoop: reviewFixLoop(calls) }));
    expect(r.outcome).toBe("complete");
    const fixTask = created(calls[0]!.projectDir)[0]!;
    expect(fixTask.goal).toContain("The request limits the fixes: \"make no changes to the public API\"");
    expect(fixTask.exitCondition).toContain("keeps the request's limits: \"make no changes to the public API\"");
    const prose = fixture();
    const proseCalls: RunLoopOptions[] = [];
    await runJarvis(reviewTask(prose, `${REQUEST.replace(/\.$/, "")}; make no changes to the public API.`, "03-prose"), options(prose, { harness: reviewer(writesReport).harness, runLoop: reviewFixLoop(proseCalls) }));
    expect(created(proseCalls[0]!.projectDir)[0]!.goal).not.toMatch(/limits the fixes/);
  });

  // Rounds 2 and 3: the report commit is ungated, so it never replaces a file the snapshot already has, whoever wrote it.
  it("refuses a report path the snapshot already has, before any session", async () => {
    const fx = fixture();
    put(fx.sourceRepo, "REVIEW.md", "# The project's own review notes\n");
    git(fx.sourceRepo, fx.home, ["add", "--", "REVIEW.md"]);
    git(fx.sourceRepo, fx.home, ["commit", "-q", "--no-verify", "-m", "notes"]);
    addTask(fx, "03-existing", REQUEST, { revert: [fx.fixRev], rev: git(fx.sourceRepo, fx.home, ["rev-parse", "HEAD"]) });
    addHidden(fx, "03-existing", "checks", { unit: [] });
    addHidden(fx, "03-existing", "gate", { unit: [] });
    setReviewFix(fx, "03-existing", true);
    const s = reviewer(writesReport);
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(loadTask(fx.evalsRepo, "03-existing"), options(fx, { harness: s.harness, runLoop: reviewFixLoop(calls) }));
    expect(r.outcome).toBe("review-failed");
    expect(r.error).toMatch(/REVIEW\.md already exists in the base revision/);
    expect(s.inputs).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(show(r.workspace, fx.home, r.finalCommit, "REVIEW.md")).toBe("# The project's own review notes");
  });

  it("a plain review still has no Jarvis build-loop arm: it stops before the preflight", async () => {
    const fx = fixture();
    let preflights = 0;
    const task = reviewTask(fx, "Review the citizenship filter before I ship it.", "03-plain", null);
    await expect(runJarvis(task, options(fx, { preflight: async () => { preflights++; return { ok: true }; }, runLoop: reviewFixLoop([]) }))).rejects.toThrow(/triage says review: not a build-loop task/);
    expect(preflights).toBe(0);
  });

  it("needs the unit gate check its fix tasks require, before the preflight", async () => {
    const fx = fixture();
    addTask(fx, "03-nounit", REQUEST, { revert: [fx.fixRev] });
    addHidden(fx, "03-nounit", "checks", { unit: [] });
    addHidden(fx, "03-nounit", "gate", { lint: [] });
    setReviewFix(fx, "03-nounit", true);
    let preflights = 0;
    await expect(runJarvis(loadTask(fx.evalsRepo, "03-nounit"), options(fx, { preflight: async () => { preflights++; return { ok: true }; }, runLoop: reviewFixLoop([]) }))).rejects.toThrow(/unit/);
    expect(preflights).toBe(0);
    rmSync(join(fx.evalsRepo, "tasks", "03-nounit"), { recursive: true, force: true });
  });
});
