// A review-fix task's reviews on the production wiring (decision 126): each fix task is a bug fix, so its
// reviewer gets decision 114's bug brief and the finding as its report; the report-update task's reviewer
// does not. Real gate evidence (the review service checks it), and a fake reviewer process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGate } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runJarvis, type RunLoop } from "../../packages/cli/src/eval/jarvis.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/harness/claude/session.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Harness } from "../../packages/cli/src/runner/harness.ts";
import { REVIEW_FINDINGS_FILE } from "../../packages/cli/src/runner/review-fix.ts";
import { writeFakeClaudeShim } from "../integration/e2e-helpers.ts";
import { addHidden, addTask, createEvalFixture, FIXED, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const REQUEST = "Review the citizenship filter before I ship it. Put what you find in REVIEW.md and fix the real problems.";

/** The loop's judging, per pending task: a candidate commit, every required check on the real gate, then o.review. */
function gatedLoop(): RunLoop {
  let runs = 0;
  return async (o) => {
    const ledger = Ledger.open(o.projectDir);
    const store = new ChecksStore(o.projectDir);
    const g = (args: string[]) => safeGit(o.repoPath, args, { home: o.gitHome! }).toString().trim();
    const runId = `loop-${++runs}`;
    ledger.append({ kind: "run_started", actor: "runner", data: { runId, pid: process.pid } });
    const settled = new Set(ledger.entries().filter((e) => e.kind === "state_reached" || e.kind === "blocked").map((e) => e.task_id));
    for (const e of ledger.entries().filter((x) => x.kind === "task_created" && !settled.has(x.task_id))) {
      const id = e.task_id!;
      const def = e.data as { mayTouch?: string[]; requiredChecks: string[] };
      ledger.append({ kind: "attempt_started", actor: "runner", task_id: id, attempt_id: "a1", data: { runId, baseRevision: g(["rev-parse", "HEAD"]) } });
      g(["checkout", "-q", "-b", `jarvis/candidates/${id}/a1`]);
      if (def.mayTouch?.includes("REVIEW.md")) put(o.repoPath, "REVIEW.md", `${readFileSync(join(o.repoPath, "REVIEW.md"), "utf8")}\nStatus: fixed.\n`);
      else put(o.repoPath, "src/citizen.mjs", FIXED);
      g(["add", "-A"]);
      g(["commit", "-q", "-m", `${id} candidate`]);
      const rev = g(["rev-parse", "HEAD"]);
      g(["checkout", "-q", o.runBranch]);
      ledger.append({ kind: "attempt_ended", actor: "runner", task_id: id, attempt_id: "a1", data: { status: "completed", candidateRevision: rev } });
      for (const name of def.requiredChecks) {
        const r = await runGate({ ledger, store, projectDir: o.projectDir, jarvisHome: o.jarvisHome, workRoot: o.workRoot, repoPath: o.repoPath, revision: rev, check: o.checks[name]!, taskId: id, attemptId: "a1" });
        if (r.status !== "pass") throw new Error(`gate ${name} ${r.status} for ${id}`);
      }
      const verdict = await o.review({ taskId: id, attemptId: "a1", revision: rev, reviewer: "code" });
      if ((typeof verdict === "string" ? verdict : verdict.status) !== "pass") throw new Error(`review of ${id} did not pass`);
      g(["merge", "-q", "--ff-only", rev]);
      ledger.append({ kind: "state_reached", actor: "runner", task_id: id, attempt_id: "a1", data: { state: "passed", revision: rev } });
      g(["tag", "-f", "last-green", rev]);
    }
    ledger.append({ kind: "run_ended", actor: "runner", data: { runId } });
    const all = ledger.entries().filter((x) => x.kind === "task_created").map((x) => x.task_id!);
    return { status: "complete", done: all, blocked: [] };
  };
}

describe("eval jarvis: a review-fix task's reviews", { timeout: 240_000 }, () => {
  it("reviews each fix against its finding with the bug brief, and the report update without it", async () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    addTask(fx, "03-review", REQUEST, { revert: [fx.fixRev] });
    addHidden(fx, "03-review", "checks", { unit: [] });
    addHidden(fx, "03-review", "gate", { unit: [] });
    // The task's runner-owned opt-in to fix (decision 126, round 3).
    const taskJson = join(fx.evalsRepo, "tasks", "03-review", "task.json");
    writeFileSync(taskJson, JSON.stringify({ ...JSON.parse(readFileSync(taskJson, "utf8")), reviewFix: true }));
    const scenarioPath = join(fx.root, "review-scenario", "scenario.json");
    mkdirSync(dirname(scenarioPath));
    writeFileSync(scenarioPath, JSON.stringify({ sessions: [{ name: "review", match: "Independently review", repeat: true, steps: [{ result: { subtype: "success", text: "{\"findings\":[]}" } }] }] }));
    const shim = join(fx.root, "bin", "claude");
    writeFakeClaudeShim(shim, scenarioPath);
    const specs: SessionSpec[] = [];
    const reviewStep: Harness = { runTask: async (input) => {
      put(input.workspace, "REVIEW.md", "# Review\n\n## F1: src/citizen.mjs:2 (high)\nThe phrase test reads raw markup.\n");
      put(input.workspace, REVIEW_FINDINGS_FILE, JSON.stringify({ request: REQUEST, report: "REVIEW.md", cleared: [], findings: [{ id: "F1", title: "Markup hides the phrase", severity: "high", confidence: "high", file: "src/citizen.mjs", line: 2, evidence: "Job pages pass HTML straight to requiresCitizenship.", fix: "Test the visible text." }] }));
      return { status: "finished", exitCode: 0, durationMs: 5, usage: [], usageWaitUntil: undefined };
    } };
    const r = await runJarvis(loadTask(fx.evalsRepo, "03-review"), {
      preflight: async () => ({ ok: true }), evalsRepo: fx.evalsRepo, runLoop: gatedLoop(), harness: reviewStep,
      jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId: "jarvis-rfb",
      reviewerSeams: { binaryRealpath: () => "/usr/bin/true", session: async (spec) => { specs.push(spec); return runSession({ ...spec, bin: shim }); } },
    });
    expect(r).toMatchObject({ outcome: "complete", pipeline: "review-fix", review: { updated: true } });
    const prompts = specs.map((s) => s.args[s.args.indexOf("-p") + 1]!);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("fixes a reported bug");
    expect(prompts[0]).toContain("src/citizen.mjs:2");
    expect(prompts[0]).toContain("Fix finding F1");
    expect(prompts[1]).not.toContain("fixes a reported bug");
    expect(prompts[1]).toContain("Update REVIEW.md");
  });
});
