import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GateInput, GateResult, GateStatus } from "../../packages/cli/src/checks/gate.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runLoop, type LoopTaskInput, type RunLoopOptions } from "../../packages/cli/src/runner/loop.ts";
import type { TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { submitSteer } from "../../packages/cli/src/runner/inbox.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const finished = (status: TaskOutcome["status"] = "finished"): TaskOutcome => ({ status, exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined, ...(status === "usage-limited" ? { resetAt: 2 } : {}) } as TaskOutcome);
function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), "loop-")); roots.push(root);
  const repoPath = join(root, "repo"), jarvisHome = join(root, "jarvis"), projectDir = join(jarvisHome, "projects/p");
  mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]) => safeGit(repoPath, args, { home: root }).toString().trim();
  git(["init", "-q", "-b", "main"]); writeFileSync(join(repoPath, ".gitignore"), ".jarvis/\n");
  git(["add", "-A"]); git(["commit", "-qm", "base"]);
  const ledger = Ledger.open(projectDir);
  for (let i = 1; i <= count; i++) ledger.append({ kind: "task_created", actor: "runner", task_id: `T${i}`, data: { title: `Task ${i}`, goal: `Goal ${i}`, exitCondition: "proven", mayTouch: [`T${i}.txt`], requiredChecks: ["unit"], requiredReviews: ["code"] } });
  let pgid = 2_000_000_000;
  const calls: LoopTaskInput[] = [];
  let body = async (input: LoopTaskInput): Promise<TaskOutcome> => { writeFileSync(join(input.workspace, `${/Task: (T\d+)/.exec(input.prompt)![1]}.txt`), "built"); return finished(); };
  const harness = { runTask: vi.fn(async (input: LoopTaskInput) => {
    calls.push(input); const id = pgid++;
    if (calls.length > 12) throw new Error("fake harness call budget exceeded");
    if (!input.onSpawn(id)) { input.onGroupExit(id); return finished("error"); }
    try { return await body(input); } finally { input.onGroupExit(id); }
  }) };
  const gate = vi.fn(async (g: GateInput): Promise<GateResult> => recordGate(g, "pass"));
  const review = vi.fn(async () => "pass" as const);
  let t = 1000;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const options: RunLoopOptions = { projectId: "p", projectDir, jarvisHome, repoPath, runBranch: "main", workRoot: join(root, "work"), worktreeRoot: join(root, "work/trees"), gitHome: root, harness, checks: { unit: { name: "unit", cases: [{ id: "x", command: "true" }], verify: "true", timeoutMs: 10 } }, review, gate, verifyEvidence: () => ({ ok: true, problems: [] }), readProcessStartTime: () => "started", kill: () => {}, now: () => t, sleep, reprobe: async () => true, usageMarginMs: 0 };
  return { root, repoPath, projectDir, ledger, git, calls, harness, gate, review, sleep, options, setBody: (fn: typeof body) => { body = fn; } };
}
function recordGate(g: GateInput, status: GateStatus): GateResult {
  const entry = g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { status, revision: g.revision, check: g.check.name, evidence: { dir: "unused", files: {} } } });
  return { status, entry, evidenceDir: "unused" };
}
const data = (e: { data: unknown }) => e.data as Record<string, unknown>;

describe("runner loop", () => {
  it("preserves planner fields and defaults in rebuilt task definitions", () => {
    const f = fixture(); const task = rebuildState(f.ledger.entries(), { now: 0 }).tasks.T1!;
    expect(task.definition).toMatchObject({ goal: "Goal 1", exitCondition: "proven", mayTouch: ["T1.txt"] });
    f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: {} });
    expect(rebuildState(f.ledger.entries(), { now: 0 }).tasks.T2!.definition).toMatchObject({ goal: "", exitCondition: "" });
  });
  it("gates, reviews, promotes and reports, excludes notes, and never reruns a finished task", async () => {
    const f = fixture(); f.setBody(async (input) => {
      const notes = join(input.workspace, ".jarvis/notes/T1.md"); mkdirSync(dirname(notes), { recursive: true }); writeFileSync(notes, "agent claim"); writeFileSync(join(input.workspace, "T1.txt"), "built"); return finished();
    });
    expect(await runLoop(f.options)).toEqual({ status: "complete", done: ["T1"], blocked: [] });
    expect(f.git(["show", "last-green:T1.txt"])).toBe("built");
    expect(f.git(["ls-tree", "-r", "--name-only", "last-green"])).not.toContain(".jarvis/");
    expect(f.git(["for-each-ref", "refs/heads/jarvis/candidates/"])).toBe("");
    expect(readFileSync(join(f.repoPath, ".jarvis/REPORT.md"), "utf8")).toContain("agent claim");
    expect(f.review).toHaveBeenCalledOnce(); expect(f.gate).toHaveBeenCalledOnce();
    const entries = f.ledger.entries();
    expect(entries.find((e) => e.kind === "attempt_started" && data(e).processGroupRecord)?.data).toMatchObject({ processGroupRecord: { exited: false, startedAt: "started" } });
    expect(entries.find((e) => e.kind === "attempt_ended")?.data).toMatchObject({ processGroupRecord: { exited: true } });
    await runLoop(f.options); expect(f.harness.runTask).toHaveBeenCalledOnce();
  });
  it("requires every check and every named reviewer at the candidate revision", async () => {
    const f = fixture(); f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { dependencies: ["T1"], requiredChecks: ["unit", "acceptance"], requiredReviews: ["code", "security"] } });
    f.options.checks = { ...f.options.checks, acceptance: { ...f.options.checks.unit!, name: "acceptance" } };
    await runLoop(f.options);
    expect(f.gate.mock.calls.map(([g]) => `${g.taskId}:${g.check.name}`)).toEqual(["T1:unit", "T2:unit", "T2:acceptance"]);
    expect(f.review.mock.calls).toHaveLength(3);
    expect(f.calls[1]!.prompt).toContain("T2");
  });
  it("uses at most maxConcurrent sessions and serializes promotion", async () => {
    const f = fixture(3); let active = 0, peak = 0;
    f.setBody(async (input) => { peak = Math.max(peak, ++active); await new Promise((r) => setTimeout(r, 10)); const id = /Task: (T\d+)/.exec(input.prompt)![1]; writeFileSync(join(input.workspace, `${id}.txt`), "ok"); active--; return finished(); });
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).done).toHaveLength(3); expect(peak).toBe(2);
    for (const id of ["T1", "T2", "T3"]) expect(f.git(["show", `last-green:${id}.txt`])).toBe("ok");
  });
  it("repairs two failures then blocks while independent tasks finish", async () => {
    const f = fixture(2); f.gate.mockImplementation(async (g) => recordGate(g, g.taskId === "T1" ? "fail" : "pass"));
    expect(await runLoop({ ...f.options, maxConcurrent: 1 })).toEqual({ status: "blocked", done: ["T2"], blocked: ["T1"] });
    expect(f.calls.filter((c) => c.prompt.includes("Task: T1"))).toHaveLength(3);
    expect(f.calls[1]!.prompt).toContain("Repair T1 (1/2)");
    expect(f.git(["ls-tree", "-r", "--name-only", "last-green"])).not.toContain("T1.txt");
  });
  it("blocks protected-check tampering immediately and notifies", async () => {
    const f = fixture(); f.gate.mockImplementation(async (g) => recordGate(g, "tampered")); const notify = vi.fn(async () => {});
    expect((await runLoop({ ...f.options, notifyBlocked: notify })).blocked).toEqual(["T1"]);
    expect(f.calls).toHaveLength(1); expect(f.review).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledWith({ taskId: "T1", reason: "protected check changed" });
    expect(f.ledger.entries().some((e) => e.kind === "blocked" && data(e).reason === "protected check changed")).toBe(true);
  });
  it.each([".jarvis-routing.json", ".jarvis/forged.txt"])("refuses candidate changes to %s", async (path) => {
    const f = fixture(); f.setBody(async (input) => { const p = join(input.workspace, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "forged"); if (path.startsWith(".jarvis/")) safeGit(input.workspace, ["add", "-f", path], { home: f.root }); return finished(); });
    expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
  });
  it("resumes a usage-limited attempt in the same workspace without charging repairs", async () => {
    const f = fixture(); let n = 0;
    f.setBody(async (input) => { if (++n === 1) { writeFileSync(join(input.workspace, "checkpoint"), "keep"); return finished("usage-limited"); } expect(readFileSync(join(input.workspace, "checkpoint"), "utf8")).toBe("keep"); return finished(); });
    expect((await runLoop({ ...f.options, maxConcurrent: 1 })).done).toEqual(["T1"]);
    expect(f.calls[0]!.workspace).toBe(f.calls[1]!.workspace); expect(f.gate).toHaveBeenCalledOnce(); expect(f.sleep).toHaveBeenCalled();
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(0);
    expect(new Set(f.ledger.entries().filter((e) => e.kind === "attempt_started").map((e) => e.attempt_id)).size).toBe(1);
  });
  it("holds all new dispatch during an account-wide wait and reprobes", async () => {
    const f = fixture(2); const reprobe = vi.fn(async () => true);
    f.ledger.append({ kind: "usage_wait", actor: "runner", data: { until: 3000 } });
    f.setBody(async () => { expect(f.options.now!()).toBeGreaterThanOrEqual(3000); expect(reprobe).toHaveBeenCalled(); return finished(); });
    await runLoop({ ...f.options, reprobe }); expect(f.sleep).toHaveBeenCalled();
  });
  it("a failed reset probe prevents further dispatch", async () => {
    const f = fixture(); f.setBody(async () => finished("usage-limited"));
    await expect(runLoop({ ...f.options, reprobe: async () => false })).rejects.toThrow(/probe/); expect(f.calls).toHaveLength(1);
  });
  it("charges timeout as a failure even when the partial candidate's checks would pass", async () => {
    const f = fixture(); let n = 0; f.setBody(async () => finished(++n === 1 ? "timeout" : "finished"));
    expect((await runLoop({ ...f.options, taskTimeoutMs: 1234 })).done).toEqual(["T1"]); expect(f.calls).toHaveLength(2); expect(f.calls[0]!.timeoutMs).toBe(1234);
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(1);
  });
  it("a refused session blocks without gates or a repair", async () => {
    const f = fixture(); f.setBody(async () => ({ ...finished(), status: "refused", reason: "sandbox unavailable" }));
    expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.calls).toHaveLength(1); expect(f.gate).not.toHaveBeenCalled();
  });
  it("fails closed when process identity cannot be captured", async () => {
    const f = fixture(); expect((await runLoop({ ...f.options, readProcessStartTime: () => null })).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
  });
  it("does not accept an attempt whose whole process group has not exited", async () => {
    const f = fixture(); f.options.harness = { runTask: async (input: LoopTaskInput) => { input.onSpawn(60000); return finished(); } };
    await expect(runLoop(f.options)).rejects.toThrow(/group.*exit/); expect(f.gate).not.toHaveBeenCalled();
  });
  it("holds an exclusive run lease even between task dispatches", async () => {
    const f = fixture(); let release!: () => void, entered!: () => void; const enteredPromise = new Promise<void>((r) => { entered = r; });
    f.setBody(async () => { entered(); await new Promise<void>((r) => { release = r; }); return finished(); });
    const first = runLoop(f.options); await enteredPromise;
    await expect(runLoop(f.options)).rejects.toThrow(/lease|active/); release(); await first;
  });
  it("replays inbox actions only after their effects are durable", async () => {
    const f = fixture(); submitSteer(f.projectDir, "T1 change the goal"); let first = true;
    const applyInbox = vi.fn(async (_action, ledger: Ledger) => { if (first) { first = false; throw new Error("inbox crash"); } ledger.append({ kind: "decision", actor: "runner", data: { applied: true } }); });
    await expect(runLoop({ ...f.options, applyInbox })).rejects.toThrow("inbox crash");
    await runLoop({ ...f.options, applyInbox, pidAlive: () => false }); expect(applyInbox).toHaveBeenCalledTimes(2);
    const cursor = JSON.parse(readFileSync(join(f.projectDir, "inbox-cursor.json"), "utf8")); expect(cursor.seq).toBeGreaterThan(0);
  });
  it("recovers a crash mid-attempt, cleans its workspace and never reruns finished tasks", async () => {
    const f = fixture(2); let crash = true;
    const onCheckpoint = (name: string, taskId?: string) => { if (name === "spawned" && taskId === "T2" && crash) { crash = false; throw new Error("injected kill"); } };
    await expect(runLoop({ ...f.options, maxConcurrent: 1, onCheckpoint })).rejects.toThrow("injected kill");
    expect(f.ledger.entries().filter((e) => e.kind === "run_ended")).toHaveLength(0);
    expect((await runLoop({ ...f.options, maxConcurrent: 1, pidAlive: () => false })).done).toEqual(["T1", "T2"]);
    expect(f.calls.filter((c) => c.prompt.includes("Task: T1"))).toHaveLength(1);
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T2!)).toBe(0);
  });
  it.each(["candidate-committed", "passed"])("recovers at %s without rerunning the completed session", async (point) => {
    const f = fixture(); let crash = true;
    await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === point && crash) { crash = false; throw new Error("power loss"); } } })).rejects.toThrow("power loss");
    expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1"]); expect(f.calls).toHaveLength(1); expect(f.git(["show", "last-green:T1.txt"])).toBe("built");
  });
  it("does not count unverified evidence as completion", async () => {
    const f = fixture(); expect((await runLoop({ ...f.options, verifyEvidence: () => ({ ok: false, problems: ["changed"] }) })).blocked).toEqual(["T1"]);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
  });
  it("blocks missing checks and unsatisfied dependencies without dispatching them", async () => {
    const f = fixture(); f.options.checks = {}; expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.calls).toHaveLength(0);
    const g = fixture(); g.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { dependencies: ["missing"] } });
    expect((await runLoop(g.options)).blocked).toEqual(["T2"]);
  });
});
it("loads routing once from the main checkout and passes the snapshot to the harness factory", async () => {
  const f = fixture(2); writeFileSync(join(f.repoPath, ".jarvis-routing.json"), JSON.stringify({ tiers: { fast: { effort: "high" } } }));
  f.git(["add", ".jarvis-routing.json"]); f.git(["commit", "-qm", "routing"]);
  const createHarness = vi.fn(() => f.harness);
  await runLoop({ ...f.options, createHarness }); expect(createHarness).toHaveBeenCalledOnce(); expect(createHarness.mock.calls[0]).toEqual([expect.objectContaining({ tiers: expect.objectContaining({ fast: expect.objectContaining({ effort: "high" }) }) })]);
});
it("rejects a harness that omits spawn identity callbacks", async () => {
  const f = fixture(); expect((await runLoop({ ...f.options, harness: { runTask: async () => finished() } })).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
});
it("a gate infrastructure error blocks rather than spinning forever", async () => {
  const f = fixture(); f.gate.mockImplementation(async (g) => recordGate(g, "error")); expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.calls).toHaveLength(1);
});
it("a failed independent review gets two repairs and cannot promote", async () => {
  const f = fixture(); const review = vi.fn(async () => "fail" as const); expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]); expect(review).toHaveBeenCalledTimes(3); expect(f.calls[1]!.failure).toBe("review_fail");
  expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
});
it("keeps a failed reset globally paused across a restart", async () => {
  const f = fixture(); let limited = true; f.setBody(async () => { if (limited) { limited = false; return finished("usage-limited"); } return finished(); });
  await expect(runLoop({ ...f.options, reprobe: async () => false })).rejects.toThrow(/probe/);
  const reprobe = vi.fn(async () => false);
  await expect(runLoop({ ...f.options, pidAlive: () => false, reprobe })).rejects.toThrow(/probe/); expect(f.calls).toHaveLength(1);
});
it("uses final text only as an unverified claim when no notes file exists", async () => {
  const f = fixture(); f.setBody(async () => ({ ...finished(), finalMessage: "fallback claim" })); await runLoop(f.options);
  expect(readFileSync(join(f.repoPath, ".jarvis/REPORT.md"), "utf8")).toContain("fallback claim");
});
it("calls injected intake recovery and seeds an optional plan just once", async () => {
  const f = fixture(); const recoverIntake = vi.fn(async () => {});
  const plan = { tasks: [{ id: "T2", goal: "added", exitCondition: "verified", dependencies: ["T1"] }] };
  expect((await runLoop({ ...f.options, plan, recoverIntake })).done).toEqual(["T1", "T2"]);
  await runLoop({ ...f.options, plan, recoverIntake }); expect(f.calls).toHaveLength(2); expect(recoverIntake).toHaveBeenCalledTimes(2);
});
it("records default steer effects durably and includes them in subsequent prompts", async () => {
  const f = fixture(); submitSteer(f.projectDir, "T1 use the new requirement"); await runLoop(f.options); expect(f.calls[0]!.prompt).toContain("use the new requirement");
  expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "inbox_applied")).toBe(true);
});
it("excludes notes even when the base checkout has no .jarvis ignore rule", async () => {
  const f = fixture(); writeFileSync(join(f.repoPath, ".gitignore"), ""); f.git(["add", "-A"]); f.git(["commit", "-qm", "no ignore"]);
  f.setBody(async (input) => { const path = join(input.workspace, ".jarvis/notes/T1.md"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "claim"); return finished(); });
  expect((await runLoop(f.options)).done).toEqual(["T1"]); expect(f.git(["ls-tree", "-r", "--name-only", "last-green"])).not.toContain(".jarvis/");
});
it("refuses an inherited tracked .jarvis tree as well as additions", async () => {
  const f = fixture(); mkdirSync(join(f.repoPath, ".jarvis")); writeFileSync(join(f.repoPath, ".jarvis/forged.txt"), "old claim"); f.git(["add", "-f", ".jarvis/forged.txt"]); f.git(["commit", "-qm", "tracked runner metadata"]);
  expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
});
it("does not lose an uncharged usage checkpoint when the process restarts", async () => {
  const f = fixture(); let n = 0;
  f.setBody(async (input) => { if (++n === 1) { writeFileSync(join(input.workspace, "checkpoint"), "resume me"); return finished("usage-limited"); } expect(readFileSync(join(input.workspace, "checkpoint"), "utf8")).toBe("resume me"); return finished(); });
  await expect(runLoop({ ...f.options, reprobe: async () => false })).rejects.toThrow(/probe/);
  expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1"]); expect(f.calls[1]!.workspace).toBe(f.calls[0]!.workspace);
});
it("does not trust new evidence after it passed earlier checks but changed during review", async () => {
  const f = fixture(); let valid = true;
  const review = async () => { valid = false; return "pass" as const; };
  expect((await runLoop({ ...f.options, review, verifyEvidence: () => ({ ok: valid, problems: valid ? [] : ["changed"] }) })).blocked).toEqual(["T1"]);
  expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
});
it("does not release the run lease while other attempts are still shutting down", async () => {
  const f = fixture(2); let release!: () => void; let inInbox!: () => void;
  const entered = new Promise<void>((r) => { inInbox = r; });
  f.setBody(async (input) => { if (input.prompt.includes("Task: T1")) await new Promise<void>((r) => { release = r; }); else submitSteer(f.projectDir, "T1 update"); return finished(); });
  let settled = false;
  const pending = runLoop({ ...f.options, applyInbox: async () => { inInbox(); throw new Error("stop inbox"); } }).catch((e: unknown) => { settled = true; return e; });
  await entered; await new Promise((r) => setTimeout(r, 10)); const settledBeforeExit = settled; release();
  const error = await pending; expect(settledBeforeExit).toBe(false); expect(String(error)).toContain("stop inbox");
});
it("a recovery pass cannot review a candidate while usage dispatch is paused", async () => {
  const f = fixture(); await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "candidate-committed") throw new Error("stop"); } })).rejects.toThrow("stop");
  f.ledger.append({ kind: "usage_wait", actor: "runner", data: { until: 4000 } });
  await expect(runLoop({ ...f.options, pidAlive: () => false, reprobe: async () => false })).rejects.toThrow(/probe/); expect(f.gate).not.toHaveBeenCalled();
});
it("enforces the task timeout on the captured process group even if a harness reports success", async () => {
  const f = fixture(); let n = 0; let release!: () => void;
  const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => { release?.(); });
  const harness = { runTask: vi.fn(async (input: LoopTaskInput) => { const id = 70000 + n++; input.onSpawn(id); if (n === 1) await new Promise<void>((r) => { release = r; }); input.onGroupExit(id); return finished(); }) };
  expect((await runLoop({ ...f.options, harness, kill, taskTimeoutMs: 20 })).done).toEqual(["T1"]);
  expect(kill).toHaveBeenCalledWith(-70000, "SIGTERM"); expect(harness.runTask).toHaveBeenCalledTimes(2);
});
it("ships unique mutation definitions whose anchors each occur once", () => {
  const definitions = JSON.parse(readFileSync(new URL("../../packages/cli/src/runner/mutations-loop.json", import.meta.url), "utf8")) as { name: string; file: string; anchor: string; replacement: string }[];
  expect(definitions.length).toBeGreaterThanOrEqual(12); expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
  for (const d of definitions) expect(readFileSync(new URL(`../../${d.file}`, import.meta.url), "utf8").split(d.anchor)).toHaveLength(2);
});
it("uses the injected process killer when cleaning a crashed attempt", async () => {
  const f = fixture(); const kill = vi.fn();
  await expect(runLoop({ ...f.options, kill, onCheckpoint: () => { throw new Error("kill here"); } })).rejects.toThrow("kill here");
  await runLoop({ ...f.options, kill, pidAlive: () => false }); expect(kill).toHaveBeenCalledWith(-2_000_000_000, "SIGKILL");
});
it("runs every required check before deciding repair, even when the first check fails", async () => {
  const f = fixture(); f.options.plan = { tasks: [{ id: "T2", dependencies: ["T1"], requiredChecks: ["unit"] }] };
  f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T3", data: { requiredChecks: ["unit", "acceptance"] } });
  f.options.checks = { ...f.options.checks, acceptance: { ...f.options.checks.unit!, name: "acceptance" } };
  f.gate.mockImplementation(async (g) => recordGate(g, g.check.name === "unit" ? "fail" : "pass"));
  await runLoop({ ...f.options, maxConcurrent: 1 });
  expect(f.gate.mock.calls.filter(([g]) => g.taskId === "T3").map(([g]) => g.check.name)).toEqual(["unit", "acceptance", "unit", "acceptance", "unit", "acceptance"]); expect(f.review).not.toHaveBeenCalled();
});
it("recovers a recorded timeout candidate as a charged failure", async () => {
  const f = fixture(); let n = 0; f.setBody(async () => finished(++n === 1 ? "timeout" : "finished"));
  await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "candidate-committed") throw new Error("timeout crash"); } })).rejects.toThrow("timeout crash");
  await runLoop({ ...f.options, pidAlive: () => false });
  expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(1);
});
it("holds fresh reviews while another in-flight task is waiting for account usage", async () => {
  const f = fixture(2); let limited = false, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const released = new Promise<void>((r) => { release = r; });
  f.setBody(async (input) => { if (input.prompt.includes("Task: T1") && !limited) { limited = true; return finished("usage-limited"); } return finished(); });
  const sleep = async (ms: number) => { entered(); await released; await f.sleep(ms); };
  const pending = runLoop({ ...f.options, sleep });
  await waiting; await new Promise((r) => setTimeout(r, 20)); const reviewsBeforeReset = f.review.mock.calls.length; release();
  // T1's candidate is built on the old head, so it is merged onto T2's promotion and reviewed again.
  await pending; expect(reviewsBeforeReset).toBe(0); expect(f.review).toHaveBeenCalledTimes(3);
});
it("resumes no attempt before the latest account-wide reset and does not acknowledge future waits", async () => {
  const f = fixture(2); const limited = new Set<string>(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), released = new Promise<void>((r) => { release = r; });
  f.setBody(async (input) => { const id = /Task: (T\d+)/.exec(input.prompt)![1]!; if (limited.has(id)) return finished(); limited.add(id); return { ...finished("usage-limited"), resetAt: id === "T1" ? 2 : 5 }; });
  const sleep = async (ms: number) => { if (ms > 1000) { entered(); await released; } await f.sleep(ms); };
  const pending = runLoop({ ...f.options, sleep });
  await waiting; await new Promise((r) => setTimeout(r, 20)); const callsBeforeLastReset = f.calls.length; release();
  await pending; expect(callsBeforeLastReset).toBe(2); expect(f.calls).toHaveLength(4);
});

// ---- Opus review of loop.ts (H1, M1, M2, L1-L5, test gaps) ----------------------------------------

type Fixture = ReturnType<typeof fixture>;
/** Every run-branch revision since the base, and last-green, was gated (every check) and reviewed (every reviewer) as that exact revision. */
function expectEveryPromotedRevisionGated(f: Fixture, start: string, checks = ["unit"], reviewers = ["code"]): void {
  const entries = f.ledger.entries();
  const chain = f.git(["rev-list", "--first-parent", `${start}..main`]).split("\n").filter(Boolean);
  expect(chain.length).toBeGreaterThan(0);
  const promoted = new Set([...chain, f.git(["rev-parse", "last-green"])]);
  for (const revision of promoted) {
    for (const check of checks) expect(entries.some((e) => e.kind === "gate_result" && data(e).revision === revision && data(e).check === check && data(e).status === "pass"), `${check} gate at ${revision}`).toBe(true);
    for (const reviewer of reviewers) expect(entries.some((e) => e.kind === "review_result" && data(e).revision === revision && data(e).reviewer === reviewer && data(e).status === "pass"), `${reviewer} review at ${revision}`).toBe(true);
  }
}
const taskOf = (input: LoopTaskInput) => /Task: (T\d+)/.exec(input.prompt)![1]!;
const commitBase = (f: Fixture, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(f.repoPath, path), text);
  f.git(["add", "-A"]); f.git(["commit", "-qm", "base files"]);
};
const showAt = (f: Fixture, revision: string, path: string) => { try { return safeGit(f.repoPath, ["show", `${revision}:${path}`], { home: f.root }).toString().trim(); } catch { return null; } };

describe("promotion integrity", () => {
  it("promotes concurrent tasks only as revisions that were gated and reviewed", async () => {
    const f = fixture(3);
    f.setBody(async (input) => { await new Promise((r) => setTimeout(r, 10)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    const start = f.git(["rev-parse", "main"]);
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).status).toBe("complete");
    expectEveryPromotedRevisionGated(f, start);
  });

  it("re-gates a candidate merged onto a moved branch: a stale caller of a renamed API is caught and repaired", async () => {
    const f = fixture(2); commitBase(f, { "api.txt": "v1" });
    f.setBody(async (input) => {
      if (taskOf(input) === "T1") writeFileSync(join(input.workspace, "api.txt"), "v2");
      else { await new Promise((r) => setTimeout(r, 30)); writeFileSync(join(input.workspace, "caller.txt"), `uses ${readFileSync(join(input.workspace, "api.txt"), "utf8")}`); }
      writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished();
    });
    f.gate.mockImplementation(async (g) => { const caller = showAt(f, g.revision, "caller.txt"); return recordGate(g, caller !== null && caller !== `uses ${showAt(f, g.revision, "api.txt")}` ? "fail" : "pass"); });
    const start = f.git(["rev-parse", "main"]);
    expect(await runLoop({ ...f.options, maxConcurrent: 2 })).toEqual({ status: "complete", done: ["T1", "T2"], blocked: [] });
    expect(showAt(f, "last-green", "caller.txt")).toBe("uses v2");
    expect(f.calls.filter((c) => taskOf(c) === "T2")).toHaveLength(2);
    expect(f.calls.at(-1)!.prompt).toContain("Repair T2 (1/2)");
    expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "merge_candidate" && e.task_id === "T2")).toBe(true);
    expectEveryPromotedRevisionGated(f, start);
  });

  it("redoes a task whose candidate conflicts with the moved branch, without charging a repair", async () => {
    const f = fixture(2); commitBase(f, { "shared.txt": "base" });
    f.setBody(async (input) => {
      const shared = join(input.workspace, "shared.txt");
      if (taskOf(input) === "T1") writeFileSync(shared, "one");
      else { await new Promise((r) => setTimeout(r, 30)); writeFileSync(shared, `${readFileSync(shared, "utf8")}+two`); }
      return finished();
    });
    const start = f.git(["rev-parse", "main"]);
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).status).toBe("complete");
    const t2 = f.calls.filter((c) => taskOf(c) === "T2");
    expect(t2).toHaveLength(2);
    expect(t2[1]!.prompt).toMatch(/run branch moved/i); expect(t2[1]!.prompt).not.toContain("Repair");
    expect(showAt(f, "last-green", "shared.txt")).toBe("one+two");
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T2!)).toBe(0);
    expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "stale_base" && e.task_id === "T2")).toBe(true);
    expectEveryPromotedRevisionGated(f, start);
  });

  it("a promotion that git refuses blocks the task instead of crashing this run or the next", async () => {
    const f = fixture();
    const git: NonNullable<RunLoopOptions["git"]> = (cwd, args, opts) => { if (args.includes("--ff-only")) throw new Error("merge refused"); return safeGit(cwd, args, opts); };
    expect(await runLoop({ ...f.options, git })).toEqual({ status: "blocked", done: [], blocked: ["T1"] });
    expect(f.ledger.entries().some((e) => e.kind === "blocked" && /promotion/.test(String(data(e).reason)))).toBe(true);
    await expect(runLoop({ ...f.options, git })).resolves.toMatchObject({ status: "blocked" });
  });

  it("records a task passed only once it is promoted, so dependents wait for the promotion", async () => {
    const f = fixture(); f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { dependencies: ["T1"] } });
    let crash = true;
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "passed" && taskId === "T1" && crash) { crash = false; throw new Error("before promotion"); } } })).rejects.toThrow("before promotion");
    expect(f.ledger.entries().filter((e) => e.kind === "state_reached")).toEqual([]);
    expect(f.calls.map(taskOf)).toEqual(["T1"]);
    expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1", "T2"]);
    expect(f.calls.map(taskOf)).toEqual(["T1", "T2"]);
  });

  it("keeps promoting across consecutive runs when the repo doesn't ignore .jarvis/", async () => {
    const f = fixture(); writeFileSync(join(f.repoPath, ".gitignore"), ""); f.git(["add", "-A"]); f.git(["commit", "-qm", "no ignore"]);
    expect((await runLoop(f.options)).done).toEqual(["T1"]);
    f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: {} });
    expect((await runLoop(f.options)).done).toEqual(["T1", "T2"]);
    expect(f.git(["status", "--porcelain"])).toBe("");
  });
});

describe("attempt bookkeeping", () => {
  it("keeps the repair prompt when a repair attempt crashed before finishing", async () => {
    const f = fixture(); let gates = 0; let spawns = 0;
    f.gate.mockImplementation(async (g) => recordGate(g, ++gates === 1 ? "fail" : "pass"));
    await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "spawned" && ++spawns === 2) throw new Error("crash in repair"); } })).rejects.toThrow("crash in repair");
    expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1"]);
    expect(f.calls).toHaveLength(3); expect(f.calls[2]!.prompt).toContain("Repair T1 (1/2)"); expect(f.calls[2]!.failure).toBe("gate_fail");
  });

  it("requires a captured process group for a usage-limited session that ran", async () => {
    const f = fixture();
    const usage = { reportedModel: undefined, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 1, complete: false };
    f.options.harness = { runTask: vi.fn(async () => ({ ...finished("usage-limited"), sessionUsage: usage })) };
    expect((await runLoop(f.options)).blocked).toEqual(["T1"]); expect(f.gate).not.toHaveBeenCalled();
  });

  it("waits out a usage limit reported before any session started (no group to capture)", async () => {
    const f = fixture(); const runTask = f.harness.runTask; let first = true;
    f.options.harness = { runTask: vi.fn(async (input: LoopTaskInput) => { if (first) { first = false; return { ...finished("usage-limited"), exitCode: null, durationMs: 0 }; } return runTask(input); }) };
    expect((await runLoop(f.options)).done).toEqual(["T1"]); expect(f.sleep).toHaveBeenCalled();
  });

  it("keeps the SIGKILL escalation armed after the harness returns while the group is alive", async () => {
    const f = fixture(); const kill = vi.fn();
    const harness = { runTask: async (input: LoopTaskInput) => { input.onSpawn(80_000); await new Promise((r) => setTimeout(r, 60)); return finished(); } };
    await expect(runLoop({ ...f.options, harness, kill, taskTimeoutMs: 20 })).rejects.toThrow(/group.*exit/);
    expect(kill).toHaveBeenCalledWith(-80_000, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(kill).toHaveBeenCalledWith(-80_000, "SIGKILL");
  });

  it("does not let a reused PID hold a dead run's lease", async () => {
    const f = fixture();
    f.ledger.append({ kind: "reconciled", actor: "runner", data: { type: "run_lease_acquired", runId: "old-run", pid: process.pid, startedAt: "a process that has since exited" } });
    expect((await runLoop(f.options)).done).toEqual(["T1"]);
  });

  it("still refuses a lease whose holder is the same live process", async () => {
    const f = fixture();
    f.ledger.append({ kind: "reconciled", actor: "runner", data: { type: "run_lease_acquired", runId: "live-run", pid: process.pid, startedAt: "started" } });
    await expect(runLoop(f.options)).rejects.toThrow(/lease/);
  });

  it("stops an in-flight session's candidate from being gated once the run has failed", async () => {
    const f = fixture(2);
    f.setBody(async (input) => { if (taskOf(input) === "T1") await new Promise((r) => setTimeout(r, 50)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "spawned" && taskId === "T2") throw new Error("fatal"); } })).rejects.toThrow("fatal");
    expect(f.gate).not.toHaveBeenCalled();
  });

  it("stops an in-flight verification from promoting once the run has failed", async () => {
    const f = fixture(2);
    f.setBody(async (input) => { if (taskOf(input) === "T2") await new Promise((r) => setTimeout(r, 10)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    f.gate.mockImplementation(async (g) => { await new Promise((r) => setTimeout(r, 60)); return recordGate(g, "pass"); });
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "spawned" && taskId === "T2") throw new Error("fatal"); } })).rejects.toThrow("fatal");
    expect(f.gate).toHaveBeenCalled();
    expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
    expect(f.ledger.entries().filter((e) => e.kind === "state_reached")).toEqual([]);
  });

  it("logs one session_usage entry per session with its route", async () => {
    const f = fixture();
    const usage = { reportedModel: "claude-sonnet-5-5", inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, turns: 2, complete: true };
    f.setBody(async (input) => { writeFileSync(join(input.workspace, "T1.txt"), "ok"); return { ...finished(), sessionUsage: usage }; });
    await runLoop(f.options);
    const logged = f.ledger.entries().filter((e) => e.kind === "session_usage");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ task_id: "T1", data: { role: "build", tier: 1, model: "claude-sonnet-5-5", status: "finished", tokens: { input: 5, output: 6 } } });
    const report = readFileSync(join(f.repoPath, ".jarvis/REPORT.md"), "utf8");
    expect(report).toContain("## Usage"); expect(report).toContain("## Footprint");
    expect(f.ledger.entries().filter((e) => e.kind === "footprint")).toHaveLength(1);
  });
});

describe("recorded review verdicts (review service)", () => {
  // The service appends its own review_result; the loop must not add a second one.
  const recordingReview = (f: Fixture, statuses: ("pass" | "fail" | "investigate" | "error")[]) => vi.fn(async (r: { taskId: string; attemptId: string; revision: string }) => {
    const status = statuses.shift() ?? "pass";
    f.ledger.append({ kind: "review_result", actor: "runner", task_id: r.taskId, attempt_id: r.attemptId, data: { reviewer: "code", revision: r.revision, status } });
    return { status, recorded: true as const };
  });
  const reviewEntries = (f: Fixture) => f.ledger.entries().filter((e) => e.kind === "review_result");

  it("passes on a recorded pass without recording a second verdict", async () => {
    const f = fixture(); const review = recordingReview(f, ["pass"]);
    expect((await runLoop({ ...f.options, review })).done).toEqual(["T1"]);
    expect(reviewEntries(f)).toHaveLength(1);
  });

  it("retries a review infrastructure error once, without a builder repair", async () => {
    const f = fixture(); const review = recordingReview(f, ["error", "pass"]);
    expect((await runLoop({ ...f.options, review })).done).toEqual(["T1"]);
    expect(review).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(1);
  });

  it("blocks after a second review error, still without a builder repair", async () => {
    const f = fixture(); const review = recordingReview(f, ["error", "error", "pass"]);
    expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]);
    expect(review).toHaveBeenCalledTimes(2); expect(f.calls).toHaveLength(1);
  });

  it("blocks for a person when the review needs investigation", async () => {
    const f = fixture(); const review = recordingReview(f, ["investigate"]);
    expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]);
    expect(f.calls).toHaveLength(1);
    expect(f.ledger.entries().some((e) => e.kind === "blocked" && /investigation/.test(String(data(e).reason)))).toBe(true);
  });

  it("refuses a recorded verdict that the ledger doesn't show", async () => {
    const f = fixture(); const review = vi.fn(async () => ({ status: "pass" as const, recorded: true as const }));
    expect((await runLoop({ ...f.options, review })).blocked).toEqual(["T1"]);
    expect(f.git(["for-each-ref", "refs/tags/last-green"])).toBe("");
  });
});
