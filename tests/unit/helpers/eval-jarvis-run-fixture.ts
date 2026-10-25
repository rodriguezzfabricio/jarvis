// Shared helpers for the Jarvis eval run tests (tests/unit/eval-jarvis-run-*.test.ts), on top of
// ../eval-jarvis-fixture.ts. Each test file calls `afterEach(removeFixtures)` so every fixture is cleaned up.
import { readFileSync } from "node:fs";
import type { JarvisEvalOptions } from "../../../packages/cli/src/eval/jarvis.ts";
import type { Harness, TaskOutcome } from "../../../packages/cli/src/runner/harness.ts";
import { createEvalFixture, markerGate, type EvalFixture } from "../eval-jarvis-fixture.ts";

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
