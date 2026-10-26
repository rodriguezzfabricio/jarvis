// Jarvis eval run tests, part 2 of 4 (fault cases and the planning path). The tests are split over four files so they run in parallel;
// the shared fixture is tests/unit/helpers/eval-jarvis-run-fixture.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runJarvis, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { runSchedule } from "../../packages/cli/src/eval/schedule.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { fakeLoop, HIDDEN_MARKER, markerGate, SPEC } from "./eval-jarvis-fixture.ts";
import { counter, featureTask, fixture, json, options, planFile, planner, removeFixtures, T } from "./helpers/eval-jarvis-run-fixture.ts";

afterEach(removeFixtures);

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
