// The loop's task allowlist (RunLoopOptions.only; decision 126, Codex security review round 4): a review run
// dispatches, retries, recovers and blocks only the task ids it created. Every other unfinished ledger task is left
// alone, and the run's result, its run_ended entry and REPORT.md say so. An empty allowlist runs nothing.
import { existsSync, readFileSync } from "node:fs";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { data, fixture, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

it("never dispatches, recovers or blocks a task outside the allowlist, and says it left it alone", async () => {
  const f = fixture();
  // T1 is the project's own unfinished work, with a committed candidate waiting for recovery.
  await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "candidate-committed") throw new Error("crash after the candidate"); } })).rejects.toThrow("crash after the candidate");
  const before = f.ledger.entries().filter((e) => e.task_id === "T1").length;
  const gatesBefore = f.gate.mock.calls.length;
  f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T8", data: { requiredChecks: ["unit"] } });
  const result = await runLoop({ ...f.options, only: ["T8"], pidAlive: () => false });
  expect(result).toMatchObject({ status: "complete", done: ["T8"], blocked: [], leftAlone: ["T1"] });
  expect(f.gate.mock.calls.slice(gatesBefore).map(([g]) => g.taskId)).toEqual(["T8"]);
  expect(f.calls.filter((c) => c.prompt.includes("Task: T1"))).toHaveLength(1); // only the first, crashed run's session
  expect(f.ledger.entries().filter((e) => e.task_id === "T1" && e.seq > 0).length).toBe(before);
  const ended = f.ledger.entries().filter((e) => e.kind === "run_ended").at(-1)!;
  expect(data(ended)).toMatchObject({ done: ["T8"], blocked: [], leftAlone: ["T1"] });
  expect(readFileSync(join(f.options.repoPath, ".jarvis", "REPORT.md"), "utf8")).toMatch(/## Left alone by this run\n\n- T1: other work in this project's ledger/);
});

// Codex round 5: a scoped run keeps the recovery checkpoint of a task it left alone (its candidate ref and its
// workspace), so the next unrestricted run still recovers that task.
it("keeps a left-alone task's candidate and workspace, and the next unrestricted run recovers it", async () => {
  const f = fixture();
  await expect(runLoop({ ...f.options, onCheckpoint: (name) => { if (name === "candidate-committed") throw new Error("crash after the candidate"); } })).rejects.toThrow("crash after the candidate");
  const git = (args: string[]) => safeGit(f.options.repoPath, args, { home: f.options.gitHome ?? process.env.HOME ?? "/" }).toString().trim();
  const t1Refs = () => git(["for-each-ref", "--format=%(refname)", "refs/heads/jarvis/candidates/T1/"]);
  const workspace = (f.ledger.entries().find((e) => e.kind === "attempt_started" && e.task_id === "T1")!.data as { workspace: string }).workspace;
  expect(t1Refs()).not.toBe("");
  expect(existsSync(workspace)).toBe(true);
  f.ledger.append({ kind: "task_created", actor: "runner", task_id: "T8", data: { requiredChecks: ["unit"] } });
  expect(await runLoop({ ...f.options, only: ["T8"], pidAlive: () => false })).toMatchObject({ done: ["T8"], leftAlone: ["T1"] });
  expect(t1Refs()).not.toBe("");
  expect(existsSync(workspace)).toBe(true);
  const gatesBefore = f.gate.mock.calls.length;
  const unrestricted = await runLoop({ ...f.options, pidAlive: () => false });
  expect(unrestricted.done.sort()).toEqual(["T1", "T8"]);
  // Recovered from its kept candidate (merged onto the head T8 moved, so gated again), with no new session for T1.
  expect(new Set(f.gate.mock.calls.slice(gatesBefore).map(([g]) => g.taskId))).toEqual(new Set(["T1"]));
  expect(f.calls.filter((c) => c.prompt.includes("Task: T1"))).toHaveLength(1);
  expect(t1Refs()).toBe("");
});

it("runs nothing at all with an empty allowlist", async () => {
  const f = fixture(2);
  const result = await runLoop({ ...f.options, only: [] });
  expect(result).toMatchObject({ status: "complete", done: [], blocked: [], leftAlone: ["T1", "T2"] });
  expect(f.calls).toHaveLength(0);
  expect(f.ledger.entries().filter((e) => e.kind === "blocked")).toEqual([]);
});

it("still runs every task when no allowlist is given", async () => {
  const f = fixture(2);
  const result = await runLoop(f.options);
  expect(result.done.sort()).toEqual(["T1", "T2"]);
  expect(result.leftAlone).toBeUndefined();
});
