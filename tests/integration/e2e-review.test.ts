import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GateCheck } from "../../packages/cli/src/checks/gate.ts";
import { createClaudeHarness } from "../../packages/cli/src/harness/claude/task.ts";
import { createClaudeReviewer } from "../../packages/cli/src/harness/claude/review.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { createReviewService, DEFAULT_REVIEW_ROUTING } from "../../packages/cli/src/review/index.ts";
import { runLoop, type RunLoopOptions } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { createE2EProject, expectRunSound, expectTaskDone, failedAttempts, harnessOptions, sessionCalls, virtualClock, type E2EProject } from "./e2e-helpers.ts";

// The Oct 25 live run (`jarvis eval jarvis 05-citizenship-filter`), end to end on the fake claude: the real
// loop, the real gate, the production review service and Claude reviewer. The protected check prints a
// multi-MB `go test -json` log, as FreeHire's suite did. Then the reviewer refused nothing for size and
// was never called; now it gets a bounded excerpt, and its own crash is retried without a builder repair.
const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));

/** About 5 MB of passing `go test -json` events, ending with the final package line. */
const BULK_SCRIPT = [
  "const w=(o)=>process.stdout.write(JSON.stringify(o)+\"\\n\");",
  "for(let i=0;i<20000;i++){const P=\"example.com/e2e/p\"+(i%50),T=\"TestBulk\"+i;w({Action:\"run\",Package:P,Test:T});w({Action:\"output\",Package:P,Test:T,Output:\"=== RUN   \"+T+\"\\n\"});w({Action:\"pass\",Package:P,Test:T,Elapsed:0})}",
  "w({Action:\"output\",Package:\"example.com/e2e/last\",Output:\"ok  \\texample.com/e2e/last\\t0.1s\\n\"});w({Action:\"pass\",Package:\"example.com/e2e/last\",Elapsed:0.1})",
].join("");
const BULK: GateCheck = { name: "bulk", cases: [{ id: "bulk", command: `node -e '${BULK_SCRIPT}'` }], verify: "sh \"$JARVIS_CHECKS/verify.sh\" bulk exit-only", timeoutMs: 60_000 };

const SCENARIO = {
  description: "T1 builds multiply; the first review session crashes, the second returns no findings.",
  sessions: [
    { name: "T1-good", task: "T1", steps: [
      { write: "src/multiply.mjs", lines: ["/** Returns the product of two numbers. */", "export function multiply(a, b) {", "  return a * b;", "}"] },
      { notes: "Added multiply." },
    ] },
    { name: "review-crashes", match: "Independently review", steps: [{ exit: 1 }] },
    { name: "review-passes", match: "Independently review", steps: [{ result: { subtype: "success", text: "{\"findings\":[]}" } }] },
  ],
};

describe("e2e: a multi-MB gate log is reviewed, and a reviewer crash is not a code failure", { timeout: 300_000 }, () => {
  it("reviews from a bounded excerpt, retries the crashed review without a repair, and promotes", async () => {
    const p = createE2EProject({ scenario: SCENARIO, approveChecks: false }); projects.push(p);
    writeFileSync(join(p.store.checksDir, "bulk.check.json"), JSON.stringify({ ...BULK, criteria: ["AC1"] }));
    p.store.approve(p.ledger, "e2e fixture plus the bulk check");
    // One task, gated by the bulk check alone (the helpers' assertions read p.tasks).
    p.tasks.splice(0, p.tasks.length, { ...p.tasks[0]!, requiredChecks: ["bulk"] });
    const { id, ...definition } = p.tasks[0]!;
    p.ledger.append({ kind: "task_created", actor: "runner", task_id: id, data: definition });

    const reviewRoot = join(p.root, "review"); mkdirSync(reviewRoot, { mode: 0o700 });
    const service = createReviewService({
      ledger: p.ledger, projectDir: p.projectDir, workRoot: reviewRoot, routing: DEFAULT_REVIEW_ROUTING, home: p.gitHome, codex: null,
      claude: createClaudeReviewer({ jarvisHome: p.jarvisHome, workRoot: reviewRoot, cacheRoot: p.cacheRoot, home: p.home, preflight: async () => ({ ok: true }),
        binaryRealpath: () => "/usr/bin/true", session: (spec) => runSession({ ...spec, bin: p.claudeBin }) }),
      resolveMaterial: async () => ({ repoPath: p.repoPath, baseRevision: p.baseRevision, tier: 1, spec: "Add multiply(a, b).", acceptanceCriteria: ["AC1: multiply returns the product"] }),
    });
    const review: RunLoopOptions["review"] = async (input) => ({ status: (await service.reviewDetailed(input)).verdict, recorded: true });
    const clock = virtualClock();
    const result = await runLoop({
      projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, runBranch: p.runBranch,
      worktreeRoot: p.worktreeRoot, workRoot: p.workRoot, checks: { ...p.checks, bulk: BULK }, review,
      createHarness: (routing) => createClaudeHarness({ ...harnessOptions(p), worktreeRoot: p.worktreeRoot, routing, binaryRealpath: () => p.claudeBin, session: (spec) => runSession({ ...spec, bin: p.claudeBin }) }),
      taskTimeoutMs: 20_000, maxTurns: 20, now: clock.now, sleep: clock.sleep, usageMarginMs: 0, reprobe: async () => true, notify: async () => {}, gitHome: p.gitHome,
    });

    expect(result).toEqual({ status: "complete", done: ["T1"], blocked: [] });
    expectTaskDone(p, "T1");
    expectRunSound(p);
    // One build session; the crashed review was retried, never charged to the builder.
    expect(sessionCalls(p).map((c) => c.session)).toEqual(["T1-good", "review-crashes", "review-passes"]);
    expect(failedAttempts(p, "T1")).toEqual([]);
    expect(repairsUsed(rebuildState(p.ledger.entries(), { now: Date.now() }).tasks.T1!)).toBe(0);
    const reviews = p.ledger.entries().filter((e) => e.kind === "review_result").map((e) => e.data as { status: string; model: string | null; error?: string });
    expect(reviews.map((r) => r.status)).toEqual(["error", "pass"]);
    expect(reviews[0]).toMatchObject({ model: "claude-sonnet-5-5", error: "Claude review failed or timed out" });

    // The gate's log was several MB; the reviewer got a bounded excerpt that still shows how the suite ended.
    const gate = p.ledger.entries().find((e) => e.kind === "gate_result")!.data as { status: string; evidence: { dir: string } };
    expect(gate.status).toBe("pass");
    expect(statSync(join(gate.evidence.dir, "cases", "bulk", "stdout")).size).toBeGreaterThan(4 * 1024 * 1024);
    const prompts = sessionCalls(p).filter((c) => c.session?.startsWith("review-")).map((c) => c.prompt);
    for (const prompt of prompts) {
      expect(Buffer.byteLength(prompt)).toBeLessThan(256 * 1024);
      expect(prompt).toContain("example.com/e2e/last");
      expect(prompt).toContain("+  return a * b;");
    }
  });
});
