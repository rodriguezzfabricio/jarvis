// Runner loop tests, part 6 of 9 (promotion integrity). The loop tests are spread over nine files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-loop-fixture.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runLoop, type RunLoopOptions } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { commitBase, data, expectEveryPromotedRevisionGated, finished, fixture, recordGate, removeFixtureRoots, showAt, taskOf } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

describe("promotion integrity", () => {
  it("promotes concurrent tasks only as revisions that were gated and reviewed", async () => {
    const f = fixture(3);
    f.setBody(async (input) => { await new Promise((r) => setTimeout(r, 10)); writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished(); });
    const start = f.git(["rev-parse", "main"]);
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).status).toBe("complete");
    expectEveryPromotedRevisionGated(f, start);
  });

  it("re-gates a candidate merged onto a moved branch: a stale caller of a renamed API is caught and repaired", async () => {
    const f = fixture(2); commitBase(f, { "api.txt": "v1" });
    f.setBody(async (input) => {
      if (taskOf(input) === "T1") writeFileSync(join(input.workspace, "api.txt"), "v2");
      else { await new Promise((r) => setTimeout(r, 30)); writeFileSync(join(input.workspace, "caller.txt"), `uses ${readFileSync(join(input.workspace, "api.txt"), "utf8")}`); }
      writeFileSync(join(input.workspace, `${taskOf(input)}.txt`), "ok"); return finished();
    });
    f.gate.mockImplementation(async (g) => { const caller = showAt(f, g.revision, "caller.txt"); return recordGate(g, caller !== null && caller !== `uses ${showAt(f, g.revision, "api.txt")}` ? "fail" : "pass"); });
    const start = f.git(["rev-parse", "main"]);
    expect(await runLoop({ ...f.options, maxConcurrent: 2 })).toEqual({ status: "complete", done: ["T1", "T2"], blocked: [] });
    expect(showAt(f, "last-green", "caller.txt")).toBe("uses v2");
    expect(f.calls.filter((c) => taskOf(c) === "T2")).toHaveLength(2);
    expect(f.calls.at(-1)!.prompt).toContain("Repair T2 (1/2)");
    expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "merge_candidate" && e.task_id === "T2")).toBe(true);
    expectEveryPromotedRevisionGated(f, start);
  });

  it("redoes a task whose candidate conflicts with the moved branch, without charging a repair", async () => {
    const f = fixture(2); commitBase(f, { "shared.txt": "base" });
    f.setBody(async (input) => {
      const shared = join(input.workspace, "shared.txt");
      if (taskOf(input) === "T1") writeFileSync(shared, "one");
      else { await new Promise((r) => setTimeout(r, 30)); writeFileSync(shared, `${readFileSync(shared, "utf8")}+two`); }
      return finished();
    });
    const start = f.git(["rev-parse", "main"]);
    expect((await runLoop({ ...f.options, maxConcurrent: 2 })).status).toBe("complete");
    const t2 = f.calls.filter((c) => taskOf(c) === "T2");
    expect(t2).toHaveLength(2);
    expect(t2[1]!.prompt).toMatch(/run branch moved/i); expect(t2[1]!.prompt).not.toContain("Repair");
    expect(showAt(f, "last-green", "shared.txt")).toBe("one+two");
    expect(repairsUsed(rebuildState(f.ledger.entries(), { now: 9999, verifyEvidence: f.options.verifyEvidence! }).tasks.T2!)).toBe(0);
    expect(f.ledger.entries().some((e) => e.kind === "reconciled" && data(e).type === "stale_base" && e.task_id === "T2")).toBe(true);
    expectEveryPromotedRevisionGated(f, start);
  });

  it("a promotion that git refuses blocks the task instead of crashing this run or the next", async () => {
    const f = fixture();
    const git: NonNullable<RunLoopOptions["git"]> = (cwd, args, opts) => { if (args.includes("--ff-only")) throw new Error("merge refused"); return safeGit(cwd, args, opts); };
    expect(await runLoop({ ...f.options, git })).toEqual({ status: "blocked", done: [], blocked: ["T1"] });
    expect(f.ledger.entries().some((e) => e.kind === "blocked" && /promotion/.test(String(data(e).reason)))).toBe(true);
    await expect(runLoop({ ...f.options, git })).resolves.toMatchObject({ status: "blocked" });
  });

  it("records a task passed only once it is promoted, so dependents wait for the promotion", async () => {
    const f = fixture(); f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { dependencies: ["T1"] } });
    let crash = true;
    await expect(runLoop({ ...f.options, onCheckpoint: (name, taskId) => { if (name === "passed" && taskId === "T1" && crash) { crash = false; throw new Error("before promotion"); } } })).rejects.toThrow("before promotion");
    expect(f.ledger.entries().filter((e) => e.kind === "state_reached")).toEqual([]);
    expect(f.calls.map(taskOf)).toEqual(["T1"]);
    expect((await runLoop({ ...f.options, pidAlive: () => false })).done).toEqual(["T1", "T2"]);
    expect(f.calls.map(taskOf)).toEqual(["T1", "T2"]);
  });

  it("keeps promoting across consecutive runs when the repo doesn't ignore .jarvis/", async () => {
    const f = fixture(); writeFileSync(join(f.repoPath, ".gitignore"), ""); f.git(["add", "-A"]); f.git(["commit", "-qm", "no ignore"]);
    expect((await runLoop(f.options)).done).toEqual(["T1"]);
    f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: {} });
    expect((await runLoop(f.options)).done).toEqual(["T1", "T2"]);
    expect(f.git(["status", "--porcelain"])).toBe("");
  });
});
