// Decision 160: a repair starts from the failed candidate's files (runner/worktrees.ts seedWorkspace), so a
// candidate that failed one check is fixed, not rebuilt. The shared fixture is tests/unit/helpers/runner-loop-fixture.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";
import { data, finished, fixture, recordGate, removeFixtureRoots, showAt } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

it("a repair edits the failed candidate's files instead of starting over", async () => {
  const f = fixture();
  f.gate.mockImplementationOnce(async (g) => recordGate(g, "fail"));
  const seen: { helper: boolean; draft: string | null }[] = [];
  f.setBody(async (input) => {
    const file = (name: string) => join(input.workspace, name);
    seen.push({ helper: existsSync(file("helper.txt")), draft: existsSync(file("T1.txt")) ? readFileSync(file("T1.txt"), "utf8") : null });
    if (f.calls.length === 1) { writeFileSync(file("T1.txt"), "first draft\n"); writeFileSync(file("helper.txt"), "kept work\n"); }
    else if (seen.at(-1)!.draft !== null) writeFileSync(file("T1.txt"), seen.at(-1)!.draft!.replace("first draft", "repaired"));
    return finished();
  });
  expect((await runLoop(f.options)).status).toBe("complete");
  expect(seen).toEqual([{ helper: false, draft: null }, { helper: true, draft: "first draft\n" }]);
  expect(f.calls[1]!.prompt).toContain("Repair T1 (1/2)");
  expect(f.calls[1]!.prompt).toContain("starts from your previous attempt's files");
  expect(showAt(f, "last-green", "T1.txt")).toBe("repaired");
  expect(showAt(f, "last-green", "helper.txt")).toBe("kept work");
  expect(f.ledger.entries().filter((e) => data(e).type === "workspace_seeded").map((e) => data(e).result)).toEqual(["seeded"]);
  expect(repairsUsed(rebuildState(f.ledger.entries(), { now: f.options.now!(), verifyEvidence: f.options.verifyEvidence! }).tasks.T1!)).toBe(1);
});

it("a first attempt and a resumed usage wait are never seeded", async () => {
  const f = fixture();
  f.setBody(async (input) => {
    writeFileSync(join(input.workspace, "T1.txt"), "built");
    return f.calls.length === 1 ? { ...finished("usage-limited"), exitCode: 0 } : finished();
  });
  expect((await runLoop(f.options)).status).toBe("complete");
  expect(f.calls).toHaveLength(2);
  expect(f.ledger.entries().some((e) => data(e).type === "workspace_seeded")).toBe(false);
});
