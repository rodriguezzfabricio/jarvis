import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask, runBaseline } from "../../packages/cli/src/eval/baseline.ts";
import { armStats, formatCompare, readRuns, verdict, writeRating, type RunRow } from "../../packages/cli/src/eval/compare.ts";
import { gradeRecordedRun, hiddenDir, loadHiddenChecks } from "../../packages/cli/src/eval/hidden.ts";
import { runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import { fakeClaudeBin } from "../helpers.ts";
import { createEvalFixture, fakeLoop, markerGate, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const TASK = "05-citizenship";

/** Two runs of each arm on the fake claude and a fake loop, graded on the same hidden check. */
async function bothArms(fx: EvalFixture) {
  const task = loadTask(fx.evalsRepo, TASK);
  const hidden = loadHiddenChecks(hiddenDir(fx.evalsRepo, TASK));
  const bin = fakeClaudeBin(fx.root);
  const gate = markerGate().gate;
  for (const runId of ["baseline-r1", "baseline-r2"]) {
    const r = await runBaseline(task, { preflight: async () => ({ ok: true }), claudeBin: bin, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, runId, parentEnv: { HOME: fx.home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "baseline" } });
    await gradeRecordedRun(r.resultsDir, hidden, { jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, gate });
  }
  for (const runId of ["jarvis-r1", "jarvis-r2"]) {
    await runJarvis(task, { preflight: async () => ({ ok: true }), evalsRepo: fx.evalsRepo, runLoop: fakeLoop("fix"), harness: { runTask: async () => { throw new Error("none"); } }, review: async () => "pass", gate, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId });
  }
  return join(fx.jarvisHome, "evals");
}

describe("jarvis eval compare: both arms, run for run", () => {
  it("reads both arms' folders, grades, claims and usage, and stays undecided until every run is rated", async () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    const evals = await bothArms(fx);
    mkdirSync(join(evals, TASK, "baseline-r3"));
    writeFileSync(join(evals, TASK, "baseline-r3", "manifest.json"), JSON.stringify({ variant: "baseline-plain-claude-code" })); // a run that died before its summary

    const rows = readRuns(evals, TASK);
    // Every grade carries the same suite fingerprint: both arms were graded on identical hidden checks.
    expect(new Set(rows.filter((r) => r.counted).map((r) => r.suite)).size).toBe(1);
    expect(rows[0]!.suite).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.map((r) => [r.arm, r.runId, r.counted, r.hidden, r.claimedDone, r.falseDone])).toEqual([
      ["baseline", "baseline-r1", true, "fail", true, true],
      ["baseline", "baseline-r2", true, "fail", true, true],
      ["baseline", "baseline-r3", false, "ungraded", null, null],
      ["jarvis", "jarvis-r1", true, "pass", true, false],
      ["jarvis", "jarvis-r2", true, "pass", true, false],
    ]);
    const j = rows.find((r) => r.runId === "jarvis-r1")!;
    // The review session logged no usage, so the figures are lower bounds, and say so.
    expect(j).toMatchObject({ sessions: 2, repairs: 0, inputTokens: 120_000, outputTokens: 8_000, costUsd: 0.75, usagePartial: true, waitMs: 0 });
    expect(rows.find((r) => r.runId === "baseline-r1")).toMatchObject({ sessions: 1, repairs: null, outcome: "success" });
    expect(armStats(rows, "baseline")).toMatchObject({ runs: 2, graded: 2, hiddenPass: 0, claimedDone: 2, falseDone: 2, rated: 0 });
    expect(armStats(rows, "jarvis")).toMatchObject({ runs: 2, graded: 2, hiddenPass: 2, claimedDone: 2, falseDone: 0 });

    const text = formatCompare(TASK, rows);
    expect(text).toMatch(/^arm\s+run\s+counted\s+outcome\s+hidden\s+suite\s+claimed done\s+false done\s+wall\s+waited\s+sessions\s+repairs\s+tokens in\/out\s+cost\s+rating\s+vetoes$/m);
    expect(text).toMatch(/^jarvis\s+jarvis-r1\s+yes\s+complete\s+pass\s+[0-9a-f]{8}\s+yes\s+no\s+/m);
    expect(text).toMatch(/^baseline\s+baseline-r3\s+no\s+incomplete \(no summary\)\s+ungraded/m);
    expect(text).toContain(">=120.0k/8.0k");
    expect(text).toContain("Beats the baseline: UNDECIDED (baseline has 2 unrated run(s) (jarvis eval rate); jarvis has 2 unrated run(s) (jarvis eval rate))");

    for (const [run, rating] of [["baseline-r1", 2], ["baseline-r2", 3], ["jarvis-r1", 4], ["jarvis-r2", 4]] as const) writeRating(evals, TASK, run, { rating, vetoes: 0 });
    expect(verdict(readRuns(evals, TASK))).toEqual({ verdict: "beats", reasons: ["rating 4.00 vs 2.50", "false done 0/2 vs 2/2", "hidden checks 2/2 vs 0/2"] });
  }, 180_000);
});

describe("the beats-the-baseline rule (proposed; decision 47 names rating and false-done rate)", () => {
  const row = (arm: "baseline" | "jarvis", o: Partial<RunRow> = {}): RunRow => ({
    arm, runId: `${arm}-x`, counted: true, outcome: "x", hidden: "pass", suite: "a".repeat(64), claimedDone: true, falseDone: false, wallMs: 1, waitMs: 0, sessions: 1, repairs: 0,
    inputTokens: null, outputTokens: null, costUsd: null, usagePartial: false, rating: 3, vetoes: 0, ...o,
  });
  const two = (arm: "baseline" | "jarvis", o: Partial<RunRow> = {}) => [row(arm, o), row(arm, o)];

  it("is undecided with fewer than 2 counted runs per arm, or with an ungraded or unrated run", () => {
    expect(verdict([row("baseline"), ...two("jarvis", { rating: 5 })]).verdict).toBe("undecided");
    expect(verdict([...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { counted: false, rating: 5 })]).verdict).toBe("undecided");
    expect(verdict([...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { rating: null })]).reasons).toEqual(["jarvis has 1 unrated run(s) (jarvis eval rate)"]);
    expect(verdict([...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { hidden: "ungraded", falseDone: null, rating: 5 })]).reasons).toEqual(["jarvis has 1 ungraded run(s) (jarvis eval grade)"]);
  });

  it("is undecided when counted runs were graded with different suites (a relaxed check can't decide it)", () => {
    const v = verdict([...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { rating: 5, suite: "b".repeat(64) })]);
    expect(v.verdict).toBe("undecided");
    expect(v.reasons[0]).toMatch(/^graded with different suites: aaaaaaaaaaaa, bbbbbbbbbbbb/);
    expect(formatCompare(TASK, [...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { rating: 5, suite: "b".repeat(64) })])).toContain("Beats the baseline: UNDECIDED (graded with different suites");
  });

  it("beats only with a higher rating, a false-done rate no higher, and a hidden pass rate no lower", () => {
    expect(verdict([...two("baseline"), ...two("jarvis", { rating: 4 })]).verdict).toBe("beats");
    expect(verdict([...two("baseline"), ...two("jarvis")]).verdict).toBe("does not beat"); // equal rating
    expect(verdict([...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { rating: 5, hidden: "fail", falseDone: true })]).verdict).toBe("does not beat");
    expect(verdict([...two("baseline"), row("jarvis", { rating: 5 }), row("jarvis", { rating: 5, hidden: "fail", claimedDone: false, falseDone: false })]).verdict).toBe("does not beat");
    // Same hidden pass rate, higher rating, but Jarvis said done on a broken result once: it does not beat.
    const honestFail = { hidden: "fail" as const, claimedDone: false, falseDone: false };
    expect(verdict([...two("baseline", honestFail), row("jarvis", { ...honestFail, rating: 5 }), row("jarvis", { rating: 5, hidden: "fail", falseDone: true })]).verdict).toBe("does not beat");
    // A blocked-but-honest stop is not a false done: Jarvis can lose on hidden checks without lying.
    expect(verdict([...two("baseline", { hidden: "fail", falseDone: true }), row("jarvis", { rating: 4, hidden: "fail", claimedDone: false, falseDone: false }), row("jarvis", { rating: 4 })]).verdict).toBe("beats");
  });

  it("treats a grade without a suite fingerprint (or with a malformed one) as ungraded", () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    const evals = join(fx.jarvisHome, "evals");
    for (const [run, grade] of [["jarvis-old", { pass: true }], ["jarvis-bad", { pass: true, suite: "x" }], ["jarvis-new", { pass: true, suite: "c".repeat(64) }]] as const) {
      mkdirSync(join(evals, TASK, run), { recursive: true });
      writeFileSync(join(evals, TASK, run, "manifest.json"), JSON.stringify({ variant: "jarvis" }));
      writeFileSync(join(evals, TASK, run, "summary.json"), JSON.stringify({ started: true, outcome: "complete", claimedDone: true }));
      writeFileSync(join(evals, TASK, run, "grade.json"), JSON.stringify(grade));
    }
    expect(readRuns(evals, TASK).map((r) => [r.runId, r.hidden, r.suite, r.falseDone])).toEqual([["jarvis-bad", "ungraded", null, null], ["jarvis-new", "pass", "c".repeat(64), false], ["jarvis-old", "ungraded", null, null]]);
  });

  it("does not count a usage-limited or never-started baseline run", () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    const evals = join(fx.jarvisHome, "evals");
    const put = (run: string, summary: object, stream = "") => {
      mkdirSync(join(evals, TASK, run), { recursive: true });
      writeFileSync(join(evals, TASK, run, "manifest.json"), JSON.stringify({ variant: "baseline-plain-claude-code" }));
      writeFileSync(join(evals, TASK, run, "summary.json"), JSON.stringify(summary));
      writeFileSync(join(evals, TASK, run, "stream.jsonl"), stream);
    };
    put("baseline-a", { started: true, usageLimited: true, exitCode: 0, resultSubtype: "success", durationMs: 5 });
    put("baseline-b", { started: false, exitCode: 1, durationMs: 1 });
    put("baseline-c", { started: true, exitCode: 0, timedOut: true, resultSubtype: undefined, durationMs: 9 }, `${JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 2 } } })}\n`);
    const rows = readRuns(evals, TASK);
    expect(rows.map((r) => [r.runId, r.counted, r.outcome, r.claimedDone])).toEqual([["baseline-a", false, "usage-limited", false], ["baseline-b", false, "not started", false], ["baseline-c", true, "timed out", false]]);
    expect(rows[2]).toMatchObject({ inputTokens: 10, outputTokens: 2, usagePartial: true });
    expect(formatCompare(TASK, rows)).toContain(">=10/2");
  });
});

describe("jarvis eval rate", () => {
  it("records a 1–5 rating and vetoes for a recorded run, and refuses anything else", () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    const evals = join(fx.jarvisHome, "evals");
    mkdirSync(join(evals, TASK, "jarvis-r1"), { recursive: true });
    writeFileSync(join(evals, TASK, "jarvis-r1", "manifest.json"), "{}");
    const p = writeRating(evals, TASK, "jarvis-r1", { rating: 4, vetoes: 1, note: "good" });
    expect(JSON.parse(readFileSync(p, "utf8"))).toMatchObject({ rating: 4, vetoes: 1, note: "good" });
    for (const rating of [0, 6, 3.5]) expect(() => writeRating(evals, TASK, "jarvis-r1", { rating })).toThrow(/1 to 5/);
    expect(() => writeRating(evals, TASK, "jarvis-r1", { rating: 3, vetoes: -1 })).toThrow(/vetoes/);
    expect(() => writeRating(evals, TASK, "jarvis-r9", { rating: 3 })).toThrow(/no recorded run/);
    expect(() => writeRating(evals, TASK, "../x", { rating: 3 })).toThrow(/invalid/);
    expect(existsSync(join(evals, TASK, "jarvis-r9"))).toBe(false);
  });
});
