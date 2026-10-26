// Shared helpers for the Jarvis eval run tests (tests/unit/eval-jarvis-run-*.test.ts), on top of
// ../eval-jarvis-fixture.ts. Each test file calls `afterEach(removeFixtures)` so every fixture is cleaned up.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTask, type GoldenTask } from "../../../packages/cli/src/eval/baseline.ts";
import { runJarvis, type JarvisEvalOptions, type JarvisRunResult, type RunLoopOptions } from "../../../packages/cli/src/eval/jarvis.ts";
import { Ledger } from "../../../packages/cli/src/ledger/ledger.ts";
import type { Harness, TaskInput, TaskOutcome } from "../../../packages/cli/src/runner/harness.ts";
import { addHidden, addTask, createEvalFixture, fakeLoop, FEATURE_PROMPT, markerGate, SPEC, type EvalFixture } from "../eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
export const removeFixtures = () => fixtures.splice(0).forEach((f) => f.cleanup());
export const fixture = () => { const f = createEvalFixture(); fixtures.push(f); return f; };

export const counter = () => { let n = 0; return { fn: async () => { n++; return { ok: true }; }, get count() { return n; } }; };
export const noHarness: Harness = { runTask: async () => { throw new Error("no session expected"); } };
export const passReview = async () => "pass" as const;
export function options(fx: EvalFixture, o: Partial<JarvisEvalOptions> & Pick<JarvisEvalOptions, "runLoop">): JarvisEvalOptions {
  return { preflight: async () => ({ ok: true }), evalsRepo: fx.evalsRepo, harness: noHarness, review: passReview, gate: markerGate().gate, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, ...o };
}
export const json = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
export const finished = (extra: Partial<TaskOutcome> = {}): TaskOutcome => ({ status: "finished", exitCode: 0, durationMs: 5, usage: [], usageWaitUntil: undefined, ...extra } as TaskOutcome);

// ---- The planning path (task 2's shape: a feature with a written spec) ------------------------------

export const planFile = (tasks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, tasks });
export const T = (id: string, acs: string[], checks: string[], deps: string[] = []) => ({ id, title: id, goal: `do ${id}`, exitCondition: `${id} checks pass`, acceptanceCriteria: acs, storyIds: ["S1"], dependencies: deps, priority: 1, requiredChecks: checks, requiredReviews: ["code"] });
/** A plan that covers the fixture spec's AC1 and AC2 with the gate's checks. */
export const validTasks = () => [T("T1", ["AC1"], ["unit", "greet"]), T("T2", ["AC2"], ["greet"], ["T1"])];

/**
 * A fake planner harness. Session n writes `writes[n]` to .jarvis/plan.json (null writes nothing) and
 * returns `outcomes[n]`; past the end of either list, the last item repeats. A single value is one list item.
 */
export function planner(writes: string | null | readonly (string | null)[], outcomes: TaskOutcome | readonly TaskOutcome[] = finished()): { harness: Harness; inputs: TaskInput[] } {
  const inputs: TaskInput[] = [];
  const pick = <V>(list: readonly V[], n: number) => list[Math.min(n, list.length - 1)]!;
  const writeList: readonly (string | null)[] = Array.isArray(writes) ? writes : [writes as string | null];
  const outcomeList: readonly TaskOutcome[] = Array.isArray(outcomes) ? outcomes : [outcomes as TaskOutcome];
  return { inputs, harness: { runTask: async (input) => {
    const n = inputs.push(input) - 1;
    const write = pick(writeList, n);
    if (write !== null) { const dir = join(input.workspace, ".jarvis"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "plan.json"), write); }
    return pick(outcomeList, n);
  } } };
}

export function featureTask(fx: EvalFixture, spec: string | null = SPEC, gate: Record<string, string[]> = { unit: [], greet: ["AC1", "AC2"] }): GoldenTask {
  addTask(fx, "02-greet", FEATURE_PROMPT, { revert: [fx.fixRev], ...(spec ? { spec } : {}) });
  addHidden(fx, "02-greet", "checks", { greet: ["AC1", "AC2"] });
  addHidden(fx, "02-greet", "gate", gate);
  return loadTask(fx.evalsRepo, "02-greet");
}

// ---- The planner's corrective attempt (decision 113; eval-jarvis-run-3 and -4) ----------------------

/** What the planner wrote in the stage 3 eval of task 02: a valid plan with an extra top-level key. */
export const withExtraKey = () => planFile(validTasks(), { feature: "Greet each user by name" });
export const ac2Uncovered = () => planFile([T("T1", ["AC1"], ["greet"])]);
export const usageLimited: TaskOutcome = { status: "usage-limited", resetAt: 1_792_790_000, exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: 1_792_790_000 };
/** Task 2's shape through the fake loop, planned by the given fake planner. */
export const runFeature = (fx: EvalFixture, p: ReturnType<typeof planner>, calls: RunLoopOptions[] = []): Promise<JarvisRunResult> =>
  runJarvis(featureTask(fx), options(fx, { harness: p.harness, runLoop: fakeLoop("fix", { "src/greet.mjs": "FIXED\n" }, calls), gate: markerGate("src/greet.mjs").gate }));
export const usageRows = (projectDir: string) => Ledger.open(projectDir).entries().filter((e) => e.kind === "session_usage").map((e) => [e.task_id, e.attempt_id]);
