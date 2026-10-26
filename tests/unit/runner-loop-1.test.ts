// Runner loop tests, part 1 of 6 (gating, promotion, repairs, tampering, usage-limited resume). The loop tests are spread over six files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import { data, finished, fixture, recordGate, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

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
});
