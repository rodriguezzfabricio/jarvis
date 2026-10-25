import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runGate, verifyEvidence, type GateCheck, type GateResult } from "../../packages/cli/src/checks/gate.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import {
  createE2EProject, expectLastGreenMoved, expectNoFailures, expectNoPassAfter, expectRunSound, expectTampered,
  expectTaskBlocked, expectTaskDone, expectTaskNotDone, expectUsageWait, failedAttempts, fileAt, gateStatuses, harnessOptions,
  lastGreen, seedTasks, sessionCalls, taskEntries, virtualClock, type E2EOptions, type E2EProject,
} from "./e2e-helpers.ts";

const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));
const project = (scenario: E2EOptions["scenario"] = "happy") => { const p = createE2EProject({ scenario }); projects.push(p); return p; };

// ---- The fixture, proven on the real gate ---------------------------------------------------------

/** A hand-made candidate: `files` committed on top of the fixture, on a side branch. */
function candidate(p: E2EProject, branch: string, files: Record<string, string>): string {
  const g = (args: string[]) => safeGit(p.repoPath, args, { home: p.gitHome }).toString().trim();
  g(["checkout", "-q", "-b", branch, p.baseRevision]);
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(p.repoPath, path)), { recursive: true }); writeFileSync(join(p.repoPath, path), text); }
  g(["add", "-A"]);
  g(["commit", "-q", "-m", branch]);
  const rev = g(["rev-parse", "HEAD"]);
  g(["checkout", "-q", p.runBranch]);
  return rev;
}
const gate = (p: E2EProject, check: GateCheck, revision: string, attemptId: string): Promise<GateResult> =>
  runGate({ ledger: p.ledger, store: p.store, projectDir: p.projectDir, jarvisHome: p.jarvisHome, workRoot: p.workRoot, repoPath: p.repoPath, revision, check, taskId: "T1", attemptId });
const GOOD = {
  "src/multiply.mjs": "export function multiply(a, b) {\n  return a * b;\n}\n",
  "src/clamp.mjs": "export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}\n",
};
const WRONG = {
  "src/multiply.mjs": "export function multiply(a, b) {\n  return a + b;\n}\n",
  "src/clamp.mjs": "export function clamp(x, lo, hi) {\n  return Math.max(lo, x);\n}\n", // ignores hi: AC2 fails, AC3 still holds
};
const statuses = async (p: E2EProject, revision: string, names: string[], attemptId: string) => {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = (await gate(p, p.checks[name]!, revision, attemptId)).status;
  return out;
};

describe("e2e fixture: protected checks on the real gate (checks/gate.ts)", { timeout: 240_000 }, () => {
  it("has one approved check per acceptance criterion plus the project's own tests", () => {
    const p = project();
    expect(Object.keys(p.checks).sort()).toEqual(["ac1", "ac2", "ac3", "unit"]);
    expect(Object.values(p.criteria).flat().sort()).toEqual(["AC1", "AC2", "AC3"]);
    for (const t of p.tasks) for (const c of t.requiredChecks) expect(p.checks[c], `${t.id} needs ${c}`).toBeDefined();
    expect(p.tasks.flatMap((t) => t.criteria).sort()).toEqual(["AC1", "AC2", "AC3"]);
    expect(p.store.verify(p.ledger)).toMatchObject({ ok: true, problems: [] });
    expect(fileAt(p, p.baseRevision, "docs/spec/v1.md")).toMatch(/\*\*AC3 \(S2\):\*\* WHEN/);
  });

  it("passes a correct candidate, fails a wrong one criterion by criterion, and records hashed evidence", async () => {
    const p = project();
    const good = candidate(p, "good", GOOD);
    expect(await statuses(p, good, ["unit", "ac1", "ac2", "ac3"], "a1")).toEqual({ unit: "pass", ac1: "pass", ac2: "pass", ac3: "pass" });
    const wrong = candidate(p, "wrong", WRONG);
    expect(await statuses(p, wrong, ["unit", "ac1", "ac2", "ac3"], "a2")).toEqual({ unit: "pass", ac1: "fail", ac2: "fail", ac3: "pass" });
    // The fixture commit has no multiply yet: the import fails, the project's own tests still pass.
    expect(await statuses(p, p.baseRevision, ["ac1"], "a3")).toEqual({ ac1: "fail" });
    const results = p.ledger.entries().filter((e) => e.kind === "gate_result");
    expect(results).toHaveLength(9);
    for (const e of results) expect(verifyEvidence(e)).toEqual({ ok: true, problems: [] });
    expect(results[1]!.data).toMatchObject({ check: "ac1", revision: good, status: "pass", completed: true, caseResults: [{ id: "ac1", code: 0, timedOut: false }] });
  });

  it("reports tampered, and never passes, once a session rewrites a protected expectation to match its wrong code", async () => {
    const p = project("tamper");
    const wrong = candidate(p, "wrong", WRONG);
    // What the tamper scenario's session writes (an escaped sandbox): the expectations of its wrong code.
    writeFileSync(join(p.store.checksDir, "expected", "ac1.txt"), "multiply(2,3)=5\nmultiply(-4,5)=1\nmultiply(0,9)=9\nmultiply(1.5,2)=3.5\nmultiply(7,-1)=6\n");
    expect(await statuses(p, wrong, ["ac1", "unit"], "a1")).toEqual({ ac1: "tampered", unit: "tampered" });
    expectTampered(p);
  });
});

// ---- The loop, end to end (turned on by the integrator) -------------------------------------------
//
// The loop API these tests expect (packages/cli/src/runner/loop.ts, written by the integrator):
//
//   export interface RunLoopOptions {
//     projectId: string;
//     projectDir: string;                       // ~/.jarvis/projects/<id>: ledger, checks, checks.lock, evidence
//     jarvisHome: string;
//     repoPath: string;                         // the project repo; promotion merges into runBranch and tags last-green
//     runBranch: string;
//     worktreeRoot: string;                     // createWorkspace's root (decision 67)
//     workRoot: string;                         // runGate's workRoot
//     harness: Harness;                         // runner/harness.ts; here createClaudeHarness(harnessOptions(p))
//     checks: Readonly<Record<string, GateCheck>>;   // protected checks by name; task_created.requiredChecks name them
//     review: (r: { taskId: string; attemptId: string; revision: string }) => Promise<"pass" | "fail">;
//     taskTimeoutMs?: number;                   // TaskInput.timeoutMs
//     maxTurns?: number;
//     maxConcurrent?: number;                   // writing tasks at once (default 2)
//     now?: () => number;                       // ms; passed to waitForUsage
//     sleep?: (ms: number) => Promise<void>;
//     usageMarginMs?: number;                   // waitForUsage's marginMs
//     reprobe?: () => Promise<boolean>;         // waitForUsage's reprobe
//     notify?: (n: UsageWaitNotice) => Promise<void>;
//     gitHome?: string;                         // HOME for the runner's own git calls
//   }
//   export interface RunLoopResult { status: "complete" | "blocked"; done: string[]; blocked: string[] }
//   export function runLoop(opts: RunLoopOptions): Promise<RunLoopResult>;
//
// Tasks come from the ledger's task_created entries (seedTasks). A task is done when the loop appends
// state_reached {state: "passed", revision} for it (runner/state.ts), after passing gate_result entries
// for every required check at that revision; promotion moves the last-green tag (promoteCandidate).
// To turn these on: set LOOP_READY to true (and adjust loadLoop if the API differs).
const LOOP_READY = true;
interface RunLoopResult { status: string; done: string[]; blocked: string[] }
type RunLoop = (opts: Record<string, unknown>) => Promise<RunLoopResult>;
type CreateHarness = typeof import("../../packages/cli/src/harness/claude/task.ts").createClaudeHarness;
type RunSession = typeof import("../../packages/cli/src/proc/session.ts").runSession;
const src = (rel: string) => pathToFileURL(join(import.meta.dirname, "../../packages/cli/src", rel)).href;
async function loadLoop(): Promise<{ runLoop: RunLoop; createClaudeHarness: CreateHarness; runSession: RunSession }> {
  const loop = (await import(src("runner/loop.ts"))) as { runLoop: RunLoop };
  const task = (await import(src("harness/claude/task.ts"))) as { createClaudeHarness: CreateHarness };
  const session = (await import(src("proc/session.ts"))) as { runSession: RunSession };
  return { runLoop: loop.runLoop, createClaudeHarness: task.createClaudeHarness, runSession: session.runSession };
}
async function run(p: E2EProject, extra: Record<string, unknown> = {}) {
  const { runLoop, createClaudeHarness, runSession } = await loadLoop();
  seedTasks(p);
  const clock = virtualClock();
  const reviews: string[] = [];
  const result = await runLoop({
    projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, runBranch: p.runBranch,
    worktreeRoot: p.worktreeRoot, workRoot: p.workRoot,
    createHarness: (routing: Parameters<CreateHarness>[0]["routing"]) => createClaudeHarness({
      ...harnessOptions(p), worktreeRoot: p.worktreeRoot, routing, binaryRealpath: () => p.claudeBin,
      session: (spec) => runSession({ ...spec, bin: p.claudeBin }),
    }), checks: p.checks,
    review: async (r: { taskId: string }) => { reviews.push(r.taskId); return "pass"; },
    taskTimeoutMs: 20_000, maxTurns: 20, now: clock.now, sleep: clock.sleep, usageMarginMs: 0, reprobe: async () => true, notify: async () => {},
    gitHome: p.gitHome, ...extra,
  });
  return { result, clock, reviews };
}
const loopIt = LOOP_READY ? it : it.skip;

describe("e2e: the runner loop on the fake claude (decision 84)", { timeout: 600_000 }, () => {
  loopIt("(a) happy path: both tasks pass first time, last-green moves, the run is sound", async () => {
    const p = project("happy");
    const { result } = await run(p);
    expect(result).toMatchObject({ status: "complete" });
    const r1 = expectTaskDone(p, "T1");
    const r2 = expectTaskDone(p, "T2");
    expectNoFailures(p, "T1");
    expectNoFailures(p, "T2");
    const green = expectLastGreenMoved(p, p.baseRevision, "src/multiply.mjs");
    expect(fileAt(p, green, "src/clamp.mjs")).toContain("Math.min");
    expect(fileAt(p, green, ".jarvis/notes/T1.md")).toBeNull(); // notes are claims, never committed
    expect([r1, r2]).not.toContain(p.baseRevision);
    expect(sessionCalls(p).map((c) => c.session).sort()).toEqual(["T1-good", "T2-good"]);
    expectRunSound(p);
  });

  loopIt("(b) the first attempt fails its checks, the repair passes", async () => {
    const p = project("repair");
    await run(p);
    // A passing repair built on a head that T2's promotion moved past is merged and gated again
    // (decision 100), so a second pass may follow; nothing fails after the first attempt.
    const [first, ...rest] = gateStatuses(p, "T1", "ac1");
    expect(first).toBe("fail");
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((s) => s === "pass")).toBe(true);
    expect(failedAttempts(p, "T1")).toHaveLength(1);
    expectTaskDone(p, "T1");
    expectTaskDone(p, "T2");
    expect(fileAt(p, lastGreen(p)!, "src/multiply.mjs")).toContain("a * b");
    expect(sessionCalls(p).filter((c) => c.task === "T1").map((c) => c.session)).toEqual(["T1-wrong-sum", "T1-repair-good"]);
    expectRunSound(p);
  });

  loopIt("(c) three failures, then blocked; the other task still finishes", async () => {
    const p = project("blocked");
    const { result } = await run(p);
    expect(result.blocked).toEqual(["T1"]);
    expectTaskBlocked(p, "T1", 3);
    expect(gateStatuses(p, "T1", "ac1")).toEqual(["fail", "fail", "fail"]);
    expectTaskDone(p, "T2");
    const green = lastGreen(p)!;
    expect(fileAt(p, green, "src/multiply.mjs")).toBeNull();
    expect(fileAt(p, green, "src/product.mjs")).toBeNull();
    expect(sessionCalls(p).filter((c) => c.task === "T1")).toHaveLength(3); // no fourth session
    expectRunSound(p);
  });

  loopIt("(d) a usage-limit rejection mid-task: the loop waits, resumes, passes, and the wait is not a failure", async () => {
    const p = project("usage-limit");
    const { clock } = await run(p);
    const wait = expectUsageWait(p, "T1");
    expect(wait.data).toMatchObject({ reason: "usage-limited", countsAsFailure: false });
    expect(clock.slept.length).toBeGreaterThan(0);
    expectNoFailures(p, "T1");
    // The limited session's work was never judged: one attempt, and every gate on it passed (a re-gate
    // of its candidate merged onto T2's promotion may add a second pass, decision 100).
    expect(gateStatuses(p, "T1", "ac1").length).toBeGreaterThan(0);
    expect(gateStatuses(p, "T1", "ac1").every((s) => s === "pass")).toBe(true);
    expect(new Set(taskEntries(p, "T1", "attempt_started").map((e) => e.attempt_id)).size).toBe(1);
    expectTaskDone(p, "T1");
    expectTaskDone(p, "T2");
    expect(sessionCalls(p).filter((c) => c.task === "T1").map((c) => c.session)).toEqual(["T1-limited", "T1-resumed-good"]);
    expectRunSound(p);
  });

  loopIt("(e) a session that edits a protected check: the gate reports tampered and nothing passes after it", async () => {
    const p = project("tamper");
    const before = lastGreen(p);
    await run(p);
    const first = expectTampered(p, "T1");
    expectNoPassAfter(p, first.seq);
    expectTaskNotDone(p, "T1");
    expect(gateStatuses(p, "T1")).not.toContain("pass");
    if (lastGreen(p) !== before) expect(fileAt(p, lastGreen(p)!, "src/multiply.mjs")).toBeNull();
    expectRunSound(p);
  });

  loopIt("(extra) a session that hangs is stopped at its timeout and the next attempt passes", async () => {
    const p = project("timeout");
    await run(p, { taskTimeoutMs: 3_000 });
    expectTaskDone(p, "T1");
    expectTaskDone(p, "T2");
    expect(sessionCalls(p).filter((c) => c.task === "T1").map((c) => c.session)).toEqual(["T1-hang", "T1-good"]);
    expectRunSound(p);
  });
});
