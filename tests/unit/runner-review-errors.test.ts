import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GateInput, GateResult } from "../../packages/cli/src/checks/gate.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { runLoop, type LoopTaskInput, type RunLoopOptions } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";

/**
 * A review whose verdict is "error" is an infrastructure failure (no reviewer verdict), not a code
 * failure: the loop retries it without a builder repair and, if it keeps failing, blocks the task with
 * its own reason (decision 100; decision 111). The live run of Oct 25 spent all three attempts of a task
 * whose gate passed every time on "Review code failed after two repairs", with no reviewer ever run.
 */
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const finished = (): TaskOutcome => ({ status: "finished", exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined } as TaskOutcome);
type Status = "pass" | "fail" | "investigate" | "error";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loop-review-")); roots.push(root);
  const repoPath = join(root, "repo"), jarvisHome = join(root, "jarvis"), projectDir = join(jarvisHome, "projects/p");
  const git = (args: string[]) => safeGit(repoPath, args, { home: root }).toString().trim();
  mkdirSync(repoPath, { recursive: true }); git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repoPath, ".gitignore"), ".jarvis/\n"); git(["add", "-A"]); git(["commit", "-qm", "base"]);
  const ledger = Ledger.open(projectDir);
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Task 1", goal: "Goal 1", exitCondition: "proven", requiredChecks: ["unit"], requiredReviews: ["code"] } });
  let pgid = 2_100_000_000;
  const calls: LoopTaskInput[] = [];
  const harness = { runTask: vi.fn(async (input: LoopTaskInput) => {
    calls.push(input); const id = pgid++;
    if (calls.length > 6) throw new Error("fake harness call budget exceeded");
    if (!input.onSpawn(id)) { input.onGroupExit(id); return { ...finished(), status: "error" } as TaskOutcome; }
    try { writeFileSync(join(input.workspace, "T1.txt"), `built ${calls.length}`); return finished(); } finally { input.onGroupExit(id); }
  }) };
  const gate = vi.fn(async (g: GateInput): Promise<GateResult> => {
    const entry = g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { status: "pass", revision: g.revision, check: g.check.name, evidence: { dir: "unused", files: {} } } });
    return { status: "pass", entry, evidenceDir: "unused" };
  });
  const blockedNotices: { taskId: string; reason: string }[] = [];
  const options: RunLoopOptions = { projectId: "p", projectDir, jarvisHome, repoPath, runBranch: "main", workRoot: join(root, "work"), worktreeRoot: join(root, "work/trees"), gitHome: root, harness,
    checks: { unit: { name: "unit", cases: [{ id: "x", command: "true" }], verify: "true", timeoutMs: 10 } }, review: async () => "pass", gate,
    verifyEvidence: () => ({ ok: true, problems: [] }), readProcessStartTime: () => "started", kill: () => {}, now: () => 1000, sleep: async () => {}, reprobe: async () => true, usageMarginMs: 0,
    notifyBlocked: async (n) => { blockedNotices.push(n); } };
  /** The review service's contract: it appends its own review_result (with the infrastructure error it hit) and returns the recorded status. */
  const recordingReview = (statuses: Status[]) => vi.fn(async (r: { taskId: string; attemptId: string; revision: string }) => {
    const status = statuses.shift() ?? "error";
    ledger.append({ kind: "review_result", actor: "runner", task_id: r.taskId, attempt_id: r.attemptId, data: {
      reviewer: "code", revision: r.revision, status, verdict: status, reviews: [],
      ...(status === "error" ? { reason: "review_error", summary: "Review infrastructure error; retry the review", error: "invalid or oversized review evidence" } : {}) } });
    return { status, recorded: true as const };
  });
  const task = () => rebuildState(ledger.entries(), { now: 9999, verifyEvidence: options.verifyEvidence! }).tasks.T1!;
  return { root, repoPath, git, ledger, calls, harness, gate, options, recordingReview, blockedNotices, task };
}
const data = (e: { data: unknown }) => e.data as Record<string, unknown>;

describe("a review infrastructure error is not a code failure", () => {
  it("is retried without a builder repair, and a passing retry promotes the candidate", async () => {
    const f = fixture(); const review = f.recordingReview(["error", "pass"]);
    expect(await runLoop({ ...f.options, review })).toEqual({ status: "complete", done: ["T1"], blocked: [] });
    expect(review).toHaveBeenCalledTimes(2);
    expect(f.calls).toHaveLength(1); // one build session: the error spent no repair
    expect(repairsUsed(f.task())).toBe(0);
    expect(f.git(["show", "last-green:T1.txt"])).toBe("built 1");
    const reviews = f.ledger.entries().filter((e) => e.kind === "review_result").map((e) => data(e).status);
    expect(reviews).toEqual(["error", "pass"]); // the loop never adds a "fail" of its own
    expect(f.ledger.entries().filter((e) => e.kind === "blocked")).toEqual([]);
  });

  it("blocks with an infrastructure reason when every retry errors: no repair, no fix prompt, no failed review", async () => {
    const f = fixture(); const review = f.recordingReview([]);
    expect(await runLoop({ ...f.options, review })).toEqual({ status: "blocked", done: [], blocked: ["T1"] });
    expect(review).toHaveBeenCalledTimes(2); // the first try and one retry (decision 100)
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.prompt).not.toMatch(/Repair T1/);
    expect(f.calls[0]!.failure).toBeUndefined();
    expect(repairsUsed(f.task())).toBe(0);
    const blocked = f.ledger.entries().filter((e) => e.kind === "blocked");
    expect(blocked.map((e) => data(e).reason)).toEqual(["review infrastructure error: invalid or oversized review evidence"]);
    expect(f.task()).toMatchObject({ status: "blocked", blockedReason: "review infrastructure error: invalid or oversized review evidence" });
    expect(f.blockedNotices).toEqual([{ taskId: "T1", reason: "review infrastructure error: invalid or oversized review evidence" }]);
    expect(f.ledger.entries().filter((e) => e.kind === "review_result").map((e) => data(e).status)).toEqual(["error", "error"]);
    expect(JSON.stringify(f.ledger.entries())).not.toMatch(/Review code failed/);
    expect(readFileSync(join(f.repoPath, ".jarvis/REPORT.md"), "utf8")).toContain("review infrastructure error: invalid or oversized review evidence");
  });

  it("stays blocked across a restart without starting a build session", async () => {
    const f = fixture();
    await runLoop({ ...f.options, review: f.recordingReview([]) });
    const again = f.recordingReview(["pass"]);
    expect((await runLoop({ ...f.options, review: again, pidAlive: () => false })).blocked).toEqual(["T1"]);
    expect(f.calls).toHaveLength(1);
    expect(again).not.toHaveBeenCalled();
    expect(repairsUsed(f.task())).toBe(0);
  });

  it("still spends a repair on a review that fails the code (the control)", async () => {
    const f = fixture(); const review = f.recordingReview(["fail", "pass"]);
    expect((await runLoop({ ...f.options, review })).done).toEqual(["T1"]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.failure).toBe("review_fail");
    expect(repairsUsed(f.task())).toBe(1);
  });

  it("ships unique mutation definitions whose anchors each occur once", () => {
    const definitions = JSON.parse(readFileSync(new URL("../../packages/cli/src/runner/mutations-review-errors.json", import.meta.url), "utf8")) as { name: string; file: string; anchor: string; replacement: string }[];
    expect(definitions.length).toBeGreaterThanOrEqual(3);
    expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
    for (const d of definitions) {
      expect(d.name).toMatch(/^runner review errors /);
      expect(readFileSync(new URL(`../../${d.file}`, import.meta.url), "utf8").split(d.anchor), d.name).toHaveLength(2);
      expect(d.replacement).not.toBe(d.anchor);
    }
  });
});
