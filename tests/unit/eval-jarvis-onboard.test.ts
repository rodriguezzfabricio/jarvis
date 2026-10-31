// The Jarvis arm on an onboarding request that also asks for edits (golden task 7's shape; decisions 89, 148):
// triage reads a question with onboarding words and a `then` refactor; one onboarding session maps the repo
// read-only in a fresh checkout, writes the report the request names and the cleanup plan
// (.jarvis/onboard/plan.json); the runner commits the report, reads the plan against the installed gate
// checks (as `jarvis run --plan onboard` does), and the plan's tasks run through the loop. Fault injection:
// no plan, a refused plan, no report, a symlinked report, a report the snapshot already has, a session that
// didn't finish, stray edits.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { pipelineFor, runJarvis, type RunLoop, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Harness, TaskInput, TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ONBOARD_REPORT, ONBOARD_PLAN_FILE } from "../../packages/cli/src/runner/onboard-step.ts";
import { addHidden, addTask, type EvalFixture } from "./eval-jarvis-fixture.ts";
import { finished, fixture, json, options, removeFixtures } from "./helpers/eval-jarvis-run-fixture.ts";

afterEach(removeFixtures);

const REQUEST = "Get familiar with this repo and make it easier for agents to work in. Put what you find in ONBOARDING.md.";
const git = (cwd: string, home: string, args: string[]) => safeGit(cwd, args, { home }).toString().trim();
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const show = (repo: string, home: string, rev: string, path: string) => git(repo, home, ["show", `${rev}:${path}`]);

function onboardTask(fx: EvalFixture, request = REQUEST, id = "07-onboard", gate: Record<string, string[]> = { unit: [] }) {
  addTask(fx, id, request, { revert: [] });
  addHidden(fx, id, "checks", { unit: [] });
  addHidden(fx, id, "gate", gate);
  return loadTask(fx.evalsRepo, id);
}

const REPORT = [
  "# Onboarding: jobs", "",
  "## Map", "- The filter: `src/citizen.mjs`", "- Its tests: `test/citizen.test.mjs`", "",
  "## Findings", "1. There is no AGENTS.md: agents get no guidance. Fix: T1.", "",
  "## Needs your OK", "- A private backup remote, through the broker; nothing has been changed.", "",
].join("\n");
const TASK = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: `cleanup ${id}`, goal: `goal of ${id}`, exitCondition: `${id} done; the unit check and the code review pass`,
  acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 1, requiredChecks: ["unit"], requiredReviews: ["code"], mayTouch: ["AGENTS.md", "docs/agents"], ...o,
});
const PLAN = JSON.stringify({ tasks: [TASK("T1", { priority: 2 }), TASK("T2", { dependencies: ["T1"], mayTouch: ["AGENTS.md"] })] });

/** A fake onboarding session: `write` acts on its workspace; every call is recorded with its header. */
function onboarder(write: (ws: string) => void, outcome: TaskOutcome = finished()): { harness: Harness; inputs: (TaskInput & { header: string })[] } {
  const inputs: (TaskInput & { header: string })[] = [];
  return { inputs, harness: { runTask: async (input) => {
    inputs.push({ ...input, header: readFileSync(input.runHeaderPath, "utf8") });
    write(input.workspace);
    return outcome;
  } } };
}
const writes = (report: string | null = REPORT, plan: string | null = PLAN, reportPath = "ONBOARDING.md") => (ws: string) => {
  if (report !== null) put(ws, reportPath, report);
  if (plan !== null) put(ws, ONBOARD_PLAN_FILE, plan);
};

/** A fake runner/loop.ts: each created task appends a line to AGENTS.md, passes its checks and review, and is promoted. */
function cleanupLoop(calls: RunLoopOptions[]): RunLoop {
  return async (opts) => {
    calls.push(opts);
    const ledger = Ledger.open(opts.projectDir);
    const g = (args: string[]) => git(opts.repoPath, opts.gitHome!, args);
    const tasks = ledger.entries().filter((e) => e.kind === "task_created");
    ledger.append({ kind: "run_started", actor: "runner", data: { runId: "loop-1", pid: process.pid } });
    for (const e of tasks) {
      const id = e.task_id!;
      const def = e.data as { requiredChecks: string[] };
      ledger.append({ kind: "attempt_started", actor: "runner", task_id: id, attempt_id: "a1", data: { runId: "loop-1", baseRevision: g(["rev-parse", "HEAD"]) } });
      let agents = "";
      try { agents = readFileSync(join(opts.repoPath, "AGENTS.md"), "utf8"); } catch { agents = "# AGENTS.md\n"; }
      put(opts.repoPath, "AGENTS.md", `${agents}- ${id}\n`);
      g(["add", "-A"]);
      g(["commit", "-q", "-m", `candidate ${id}`]);
      const rev = g(["rev-parse", "HEAD"]);
      ledger.append({ kind: "attempt_ended", actor: "runner", task_id: id, attempt_id: "a1", data: { status: "completed", candidateRevision: rev } });
      for (const check of def.requiredChecks) ledger.append({ kind: "gate_result", actor: "runner", task_id: id, attempt_id: "a1", data: { check, revision: rev, status: "pass" } });
      const verdict = await opts.review({ taskId: id, attemptId: "a1", revision: rev });
      ledger.append({ kind: "review_result", actor: "runner", task_id: id, attempt_id: "a1", data: { reviewer: "code", revision: rev, status: verdict } });
      ledger.append({ kind: "state_reached", actor: "runner", task_id: id, attempt_id: "a1", data: { state: "passed", revision: rev } });
      g(["tag", "-f", "last-green", rev]);
    }
    ledger.append({ kind: "run_ended", actor: "runner", data: { runId: "loop-1" } });
    return { status: "complete", done: tasks.map((e) => e.task_id!), blocked: [] };
  };
}
const created = (projectDir: string) => Ledger.open(projectDir).entries().filter((e) => e.kind === "task_created").map((e) => ({ id: e.task_id!, ...(e.data as { goal: string; exitCondition: string; mayTouch?: string[]; requiredChecks: string[]; dependencies: string[] }) }));

describe("eval jarvis: onboarding that also asks for edits (golden task 7's shape)", () => {
  it("has a pipeline only for an onboarding question whose edits are a refactor or a bug", () => {
    expect(pipelineFor("question", false, { onboarding: true, then: "refactor" })).toBe("onboard");
    expect(pipelineFor("question", false, { onboarding: true, then: "bug" })).toBe("onboard");
    expect(() => pipelineFor("question", false, { onboarding: true, then: null })).toThrow(/not a build-loop task/);
    expect(() => pipelineFor("question", false, { onboarding: false, then: "refactor" })).toThrow(/not a build-loop task/);
    expect(() => pipelineFor("question", false, { onboarding: true, then: "feature" })).toThrow(/research skill/);
    expect(() => pipelineFor("question")).toThrow(/not a build-loop task/);
    expect(pipelineFor("refactor")).toBe("single-task");
  });

  it("maps the repo in one session, commits the report, and runs the plan's cleanup tasks through the loop", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const s = onboarder(writes());
    const r = await runJarvis(onboardTask(fx), options(fx, { harness: s.harness, runLoop: cleanupLoop(calls), runId: "jarvis-ob" }));

    expect(r).toMatchObject({ outcome: "complete", claimedDone: true, pipeline: "onboard", triage: { type: "question" }, started: true });
    // The onboarding step: one session in a fresh checkout of the snapshot, as the architect, with the onboard skill as text.
    expect(s.inputs).toHaveLength(1);
    const step = s.inputs[0]!;
    expect(step.role).toBe("architect");
    expect(step.prompt).toContain(REQUEST);
    expect(step.prompt).toContain("ONBOARDING.md");
    expect(step.prompt).toContain(ONBOARD_PLAN_FILE);
    expect(step.prompt).toMatch(/- unit/);
    expect(step.prompt).toMatch(/Change no other file/);
    expect(step.header).toContain("<skill name=\"onboard\">");
    expect(step.header).not.toContain("<skill name=\"build\">");
    expect(step.workspace.startsWith(join(fx.workRoot, "evals", "07-onboard", "jarvis-ob.wt"))).toBe(true);

    // The report is the session's file, committed by the runner on the snapshot before any cleanup task: the loop's base.
    const ws = r.workspace;
    expect(r.onboard).toMatchObject({ report: "ONBOARDING.md", tasks: ["T1", "T2"] });
    expect(r.onboard!.reportRevision).toBe(r.baseRevision);
    expect(show(ws, fx.home, r.baseRevision, "ONBOARDING.md")).toBe(REPORT.trimEnd());
    expect(git(ws, fx.home, ["rev-parse", `${r.baseRevision}^`])).toBe(r.snapshot.commit);
    expect(git(ws, fx.home, ["diff-tree", "--no-commit-id", "--name-only", "-r", r.baseRevision])).toBe("ONBOARDING.md");

    // Both cleanup tasks reach the loop's ledger as the plan wrote them (the stage 6 review's missing consumer).
    expect(calls).toHaveLength(1);
    const tasks = created(calls[0]!.projectDir);
    expect(tasks.map((t) => [t.id, t.goal, t.requiredChecks, t.mayTouch, t.dependencies])).toEqual([
      ["T1", "goal of T1", ["unit"], ["AGENTS.md", "docs/agents"], []],
      ["T2", "goal of T2", ["unit"], ["AGENTS.md"], ["T1"]],
    ]);
    expect(r.finalCommit).toBe(r.lastGreen);
    expect(show(ws, fx.home, r.finalCommit, "AGENTS.md")).toContain("- T2");
    expect(show(ws, fx.home, r.finalCommit, "ONBOARDING.md")).toBe(REPORT.trimEnd());
    expect(r.metrics.sessions.planner).toBe(1); // the onboarding step, counted with the sessions before the loop
    expect(json(join(r.resultsDir, "summary.json"))).toMatchObject({ pipeline: "onboard", onboard: { report: "ONBOARDING.md", tasks: ["T1", "T2"] } });
    expect(json(join(r.resultsDir, "manifest.json"))).toMatchObject({ pipeline: "onboard", onboard: { report: "ONBOARDING.md" } });
    expect(r.grade).toMatchObject({ pass: true });
  });

  it("writes the report where the request says, and to ONBOARDING.md when it names no file", async () => {
    const fx = fixture();
    const named = await runJarvis(onboardTask(fx, "Get familiar with this repo and make it easier for agents to work in. Write what you find to docs/onboarding.md.", "07-named"),
      options(fx, { harness: onboarder(writes(REPORT, PLAN, "docs/onboarding.md")).harness, runLoop: cleanupLoop([]) }));
    expect(named.onboard?.report).toBe("docs/onboarding.md");
    expect(show(named.workspace, fx.home, named.baseRevision, "docs/onboarding.md")).toBe(REPORT.trimEnd());
    const fx2 = fixture();
    const plain = await runJarvis(onboardTask(fx2, "Get familiar with this repo and make it easier for agents to work in.", "07-plain"),
      options(fx2, { harness: onboarder(writes()).harness, runLoop: cleanupLoop([]) }));
    expect(DEFAULT_ONBOARD_REPORT).toBe("ONBOARDING.md");
    expect(plain.onboard?.report).toBe("ONBOARDING.md");
    expect(plain.outcome).toBe("complete");
    // A path a report may not have (an agent-instruction file, decision 126's rules) falls back to the default.
    const fx3 = fixture();
    const refused = await runJarvis(onboardTask(fx3, "Get familiar with this repo and make it easier for agents to work in. Put what you find in AGENTS.md.", "07-refused"),
      options(fx3, { harness: onboarder(writes()).harness, runLoop: cleanupLoop([]) }));
    expect(refused).toMatchObject({ outcome: "complete", onboard: { report: "ONBOARDING.md" } });
  });

  it("keeps every onboarding mutation's anchor in place, once", () => {
    const defs = JSON.parse(readFileSync("packages/cli/src/runner/mutations-onboard.json", "utf8")) as { name: string; file: string; anchor: string; replacement: string }[];
    expect(defs.length).toBeGreaterThanOrEqual(12);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.name).toMatch(/^onboard: /);
      expect(d.file).toMatch(/^packages\/cli\/src\/(eval\/jarvis|runner\/onboard-step|triage\/triage)\.ts$/);
      expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1, d.name).toBe(1);
      expect(d.replacement).not.toBe(d.anchor);
    }
  });

  it.each([
    ["no plan", writes(REPORT, null), /wrote no \.jarvis\/onboard\/plan\.json/],
    ["a plan that isn't JSON", writes(REPORT, "{ tasks: oops"), /\.jarvis\/onboard\/plan\.json is refused/],
    ["a check the gate doesn't have", writes(REPORT, JSON.stringify({ tasks: [TASK("T1", { requiredChecks: ["agents-size"] })] })), /unknown required check: agents-size/],
    ["acceptance criteria", writes(REPORT, JSON.stringify({ tasks: [TASK("T1", { acceptanceCriteria: ["AC1"] })] })), /no acceptance criteria or stories/],
    ["a boundary in runner metadata", writes(REPORT, JSON.stringify({ tasks: [TASK("T1", { mayTouch: [".jarvis/onboard"] })] })), /mayTouch/],
    ["no report", writes(null), /wrote no report at ONBOARDING\.md/],
    ["an empty report", writes("  \n"), /ONBOARDING\.md is empty/],
  ])("starts no cleanup and commits nothing when the session left %s", async (_label, write, error) => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(onboardTask(fx), options(fx, { harness: onboarder(write).harness, runLoop: cleanupLoop(calls) }));
    expect(r.outcome).toBe("onboard-failed");
    expect(r.error).toMatch(error);
    expect(r.error).toMatch(/no cleanup was started/);
    expect(calls).toHaveLength(0);
    expect(created(join(r.resultsDir, "project"))).toEqual([]);
    expect(r).toMatchObject({ claimedDone: false, started: true, finalCommit: r.snapshot.commit, onboard: null });
  });

  it("refuses a report the session made a symlink, even to a file in its checkout", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const harness = onboarder((ws) => { put(ws, "notes.md", REPORT); symlinkSync("notes.md", join(ws, "ONBOARDING.md")); put(ws, ONBOARD_PLAN_FILE, PLAN); }).harness;
    const r = await runJarvis(onboardTask(fx), options(fx, { harness, runLoop: cleanupLoop(calls) }));
    expect(r.outcome).toBe("onboard-failed");
    expect(r.error).toMatch(/ONBOARDING\.md is refused/);
    expect(calls).toHaveLength(0);
    expect(() => show(r.workspace, fx.home, r.finalCommit, "ONBOARDING.md")).toThrow();
  });

  it("refuses a report path the snapshot already has, before any session", async () => {
    const fx = fixture();
    put(fx.sourceRepo, "ONBOARDING.md", "# The project's own onboarding notes\n");
    git(fx.sourceRepo, fx.home, ["add", "--", "ONBOARDING.md"]);
    git(fx.sourceRepo, fx.home, ["commit", "-q", "--no-verify", "-m", "notes"]);
    addTask(fx, "07-existing", REQUEST, { rev: git(fx.sourceRepo, fx.home, ["rev-parse", "HEAD"]) });
    addHidden(fx, "07-existing", "checks", { unit: [] });
    addHidden(fx, "07-existing", "gate", { unit: [] });
    const s = onboarder(writes());
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(loadTask(fx.evalsRepo, "07-existing"), options(fx, { harness: s.harness, runLoop: cleanupLoop(calls) }));
    expect(r.outcome).toBe("onboard-failed");
    expect(r.error).toMatch(/ONBOARDING\.md already exists in the base revision/);
    expect(s.inputs).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(show(r.workspace, fx.home, r.finalCommit, "ONBOARDING.md")).toBe("# The project's own onboarding notes");
  });

  it("discards anything else the session changed, and says so", async () => {
    const fx = fixture();
    const harness = onboarder((ws) => { writes()(ws); put(ws, "AGENTS.md", "# edited by the onboarding session\n"); put(ws, "src/citizen.mjs", "// edited\n"); }).harness;
    const r = await runJarvis(onboardTask(fx), options(fx, { harness, runLoop: cleanupLoop([]) }));
    expect(r.outcome).toBe("complete");
    expect(git(r.workspace, fx.home, ["diff-tree", "--no-commit-id", "--name-only", "-r", r.baseRevision])).toBe("ONBOARDING.md");
    expect(show(r.workspace, fx.home, r.finalCommit, "AGENTS.md")).not.toContain("edited by the onboarding session");
    expect(show(r.workspace, fx.home, r.finalCommit, "src/citizen.mjs")).not.toContain("// edited");
    const said = r.metrics.problems.join("\n");
    expect(said).toMatch(/the onboarding session also changed .*; discarded \(the onboarding step writes only its report and its plan\)/);
    expect(said).toContain("AGENTS.md");
    expect(said).toContain("src/citizen.mjs");
  });

  it("starts no cleanup when the session didn't finish, and stops on a usage limit", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const timeout = { status: "timeout", exitCode: null, durationMs: 5, usage: [], usageWaitUntil: undefined } as TaskOutcome;
    const r = await runJarvis(onboardTask(fx), options(fx, { harness: onboarder(writes(), timeout).harness, runLoop: cleanupLoop(calls) }));
    expect(r.outcome).toBe("onboard-failed");
    expect(r.error).toMatch(/onboarding session timeout/);
    expect(calls).toHaveLength(0);
    const fx2 = fixture();
    const limited = { status: "usage-limited", resetAt: 1_792_790_000, exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: 1_792_790_000 } as TaskOutcome;
    const u = await runJarvis(onboardTask(fx2), options(fx2, { harness: onboarder(() => {}, limited).harness, runLoop: cleanupLoop([]) }));
    expect(u).toMatchObject({ outcome: "usage-limited", usageLimited: true, usageWaitUntil: 1_792_790_000 });
  });

  it("needs the unit gate check the cleanup tasks require, before the preflight", async () => {
    const fx = fixture();
    let preflights = 0;
    const task = onboardTask(fx, REQUEST, "07-nounit", { lint: [] });
    await expect(runJarvis(task, options(fx, { preflight: async () => { preflights++; return { ok: true }; }, runLoop: cleanupLoop([]) }))).rejects.toThrow(/unit/);
    expect(preflights).toBe(0);
  });

  it("a plain question, or onboarding without edits, still has no build-loop arm: it stops before the preflight", async () => {
    for (const [i, request] of ["How does the citizenship filter work?", "Get familiar with this repo.", "Get familiar with this repo and add a dark mode."].entries()) {
      const fx = fixture();
      let preflights = 0;
      const error = await runJarvis(onboardTask(fx, request, `07-q${i}`), options(fx, { preflight: async () => { preflights++; return { ok: true }; }, runLoop: cleanupLoop([]) })).then(() => "ran", (e: unknown) => String(e));
      expect(error, request).toMatch(/triage says question/);
      expect(preflights, request).toBe(0);
    }
  });
});
