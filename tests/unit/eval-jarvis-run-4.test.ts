// Jarvis eval run tests, part 4 of 4 (what the planner is never retried for, its prompt and its notes, decision 113). The
// tests are split over four files so they run in parallel; the shared fixture is tests/unit/helpers/eval-jarvis-run-fixture.ts.

import { afterEach, describe, expect, it } from "vitest";
import type { RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { finished, fixture, planFile, planner, removeFixtures, runFeature as run, T, usageLimited, validTasks, withExtraKey } from "./helpers/eval-jarvis-run-fixture.ts";

afterEach(removeFixtures);

describe("eval jarvis: the corrective attempt is only for a refused plan (decision 113)", () => {
  it.each([
    ["usage-limited", usageLimited, "usage-limited", 1],
    ["timeout", finished({ status: "timeout", exitCode: null } as Partial<TaskOutcome>), "plan-failed", 1],
    ["error", finished({ status: "error", message: "claude exited 1" } as Partial<TaskOutcome>), "plan-failed", 1],
    ["refused", { status: "refused", reason: "preflight failed", exitCode: null, durationMs: 0, usage: [], usageWaitUntil: undefined } as TaskOutcome, "plan-failed", 0],
  ] as const)("never retries a planner session that ended %s", async (_name, outcome, expected, plannerSessions) => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const p = planner(withExtraKey(), outcome);
    const r = await run(fx, p, calls);
    expect(r.outcome).toBe(expected);
    expect(p.inputs).toHaveLength(1);
    expect(r.metrics.sessions.planner).toBe(plannerSessions);
    expect(calls).toHaveLength(0);
    if (expected === "plan-failed") expect(r.error).toMatch(new RegExp(`planner session ${outcome.status}`));
  });

  it("records plan-failed with both reasons when the corrective session times out", async () => {
    const fx = fixture();
    const p = planner([withExtraKey(), null], [finished(), finished({ status: "timeout", exitCode: null } as Partial<TaskOutcome>)]);
    const r = await run(fx, p);
    expect(r.outcome).toBe("plan-failed");
    expect(r.error).toMatch(/Unrecognized key/);
    expect(r.error).toMatch(/planner session timeout/);
    expect(p.inputs).toHaveLength(2);
  });
});

describe("eval jarvis: the planner prompt and its notes (decision 113)", () => {
  it("shows the exact plan shape, says any other key is refused, and offers notes for cross-cutting constraints", async () => {
    const fx = fixture();
    const p = planner(planFile(validTasks()));
    await run(fx, p);
    const prompt = p.inputs[0]!.prompt;
    const fence = /```json\n([\s\S]*?)\n```/.exec(prompt);
    expect(fence, "a json skeleton").not.toBeNull();
    const skeleton = JSON.parse(fence![1]!) as { notes: unknown; tasks: Record<string, unknown>[] };
    expect(Object.keys(skeleton).sort()).toEqual(["notes", "tasks"]);
    expect(Object.keys(skeleton.tasks[0]!).sort()).toEqual(Object.keys(T("T1", [], [])).sort());
    expect(prompt).toMatch(/any other key/i);
    expect(prompt).toMatch(/notes/);
    expect(prompt).toMatch(/claims/);
  });

  it("carries the planner's notes into every task the ledger creates", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const notes = ["Keep the greeting in src/greet.mjs; add no dependencies.", "Names come from the CLI argument only."];
    const r = await run(fx, planner(planFile(validTasks(), { notes })), calls);
    expect(r.outcome).toBe("complete");
    const created = Ledger.open(calls[0]!.projectDir).entries().filter((e) => e.kind === "task_created");
    expect(created.map((e) => [e.task_id, (e.data as { planNotes?: string[] }).planNotes])).toEqual([["T1", notes], ["T2", notes]]);
  });
});
