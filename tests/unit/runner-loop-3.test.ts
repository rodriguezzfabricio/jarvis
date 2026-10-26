// Runner loop tests, part 3 of 6 (recovery points, missing checks, routing snapshot, spawn identity, gate errors). The loop tests are spread over six files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { finished, fixture, recordGate, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

describe("runner loop", () => {
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
it("gives each build session its task's planner notes, as claims, and none to a task without them (decision 113)", async () => {
  const f = fixture(); const notes = ["Keep task files at the repo root.", "No new dependencies."];
  const plan = { tasks: [{ id: "T2", goal: "second", exitCondition: "proven", dependencies: ["T1"], mayTouch: ["T2.txt"], planNotes: notes }] };
  expect((await runLoop({ ...f.options, plan })).done).toEqual(["T1", "T2"]);
  const t2 = f.calls.find((c) => c.prompt.includes("Task: T2"))!;
  expect(t2.prompt).toMatch(/^Planner notes \(claims/m); for (const note of notes) expect(t2.prompt).toContain(`\n- ${note}`);
  expect(readFileSync(t2.runHeaderPath!, "utf8")).toContain("- No new dependencies.");
  expect(f.calls.find((c) => c.prompt.includes("Task: T1"))!.prompt).not.toContain("Planner notes");
});
