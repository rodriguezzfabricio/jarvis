// Jarvis eval run tests, part 3 of 4 (the planner's one corrective attempt, decision 113). The tests are split over four
// files so they run in parallel; the shared fixture is tests/unit/helpers/eval-jarvis-run-fixture.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ac2Uncovered, finished, fixture, planFile, planner, removeFixtures, runFeature as run, T, usageLimited, usageRows, validTasks, withExtraKey } from "./helpers/eval-jarvis-run-fixture.ts";

afterEach(removeFixtures);

describe("eval jarvis: the planner gets one corrective attempt (decision 113)", () => {
  it("reruns a planner whose plan was refused once, in the same workspace, with the exact error, then runs the loop on the corrected plan", async () => {
    const fx = fixture();
    const p = planner([withExtraKey(), planFile(validTasks())]);
    const calls: RunLoopOptions[] = [];
    const r = await run(fx, p, calls);
    expect(r).toMatchObject({ outcome: "complete", claimedDone: true });
    expect(r.metrics.sessions).toMatchObject({ planner: 2, build: 2, review: 2, total: 6 });
    expect(p.inputs).toHaveLength(2);
    const [first, second] = p.inputs as [typeof p.inputs[0], typeof p.inputs[0]];
    // The same planning workspace, the same role and budget; its own log.
    expect(second.workspace).toBe(first.workspace);
    expect(second).toMatchObject({ role: "architect", maxTurns: 20, timeoutMs: 120_000 });
    expect(second.logPath).toBe(join(calls[0]!.projectDir, "sessions", "plan-a2.jsonl"));
    expect(second.logPath).not.toBe(first.logPath);
    expect(existsSync(first.workspace)).toBe(false);
    // The corrective prompt names the exact refusal, says what to rewrite, and keeps the full planning context.
    expect(second.prompt).toMatch(/Unrecognized key/);
    expect(second.prompt).toContain('"feature"');
    expect(second.prompt).toMatch(/Rewrite \.jarvis\/plan\.json only/);
    expect(second.prompt).toContain("- greet: AC1, AC2");
    expect(second.prompt).toContain("docs/spec/v1.md");
    expect(first.prompt).not.toMatch(/Unrecognized key/);
    // Both sessions are in the ledger's usage, like any session; the plan's tasks come from the second.
    expect(usageRows(calls[0]!.projectDir).slice(0, 2)).toEqual([["plan", "a1"], ["plan", "a2"]]);
    expect(Ledger.open(calls[0]!.projectDir).entries().filter((e) => e.kind === "task_created").map((e) => e.task_id)).toEqual(["T1", "T2"]);
  });

  it.each([
    ["not JSON", "{"],
    ["missing", null],
    ["uncovered", ac2Uncovered()],
  ])("gives a corrective attempt for a plan that is %s", async (_name, firstWrite) => {
    const fx = fixture();
    const p = planner([firstWrite, planFile(validTasks())]);
    const r = await run(fx, p);
    expect(r.outcome).toBe("complete");
    expect(p.inputs).toHaveLength(2);
    expect(r.metrics.sessions.planner).toBe(2);
  });

  it("records plan-failed with both refusals when the corrective plan is refused too, and never starts the loop", async () => {
    const fx = fixture();
    const calls: RunLoopOptions[] = [];
    const p = planner([withExtraKey(), ac2Uncovered()]);
    const r = await run(fx, p, calls);
    expect(r).toMatchObject({ outcome: "plan-failed", claimedDone: false, started: true });
    expect(r.error).toMatch(/Unrecognized key/);
    expect(r.error).toContain('"feature"');
    expect(r.error).toMatch(/plan does not cover AC2/);
    expect(p.inputs).toHaveLength(2); // at most one corrective attempt
    expect(r.metrics.sessions.planner).toBe(2);
    expect(calls).toHaveLength(0);
    expect(usageRows(join(r.resultsDir, "project"))).toEqual([["plan", "a1"], ["plan", "a2"]]);
  });

  it("reports a usage-limited corrective session as usage-limited, so the scheduler reruns the task; it counts both sessions", async () => {
    const fx = fixture();
    const p = planner([withExtraKey(), null], [finished(), usageLimited]);
    const r = await run(fx, p);
    expect(r).toMatchObject({ outcome: "usage-limited", usageLimited: true, usageWaitUntil: 1_792_790_000, grade: null });
    expect(p.inputs).toHaveLength(2);
    expect(r.metrics.sessions.planner).toBe(2);
  });

  it("bounds the refusal it quotes to the corrective session", async () => {
    const fx = fixture();
    // 300 tasks, each extra one with an unknown key: the schema reports one issue per task.
    const tasks = [...validTasks(), ...Array.from({ length: 298 }, (_, i) => ({ ...T(`T${i + 3}`, [], ["unit"]), storyIds: [], extra: true }))];
    const p = planner([planFile(tasks), planFile(validTasks())]);
    await run(fx, p);
    expect(p.inputs).toHaveLength(2);
    expect(p.inputs[1]!.prompt.length - p.inputs[0]!.prompt.length).toBeLessThan(5_000);
    expect(p.inputs[1]!.prompt).toMatch(/Unrecognized key/);
  });
});
