import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Decision 148's mutations (packages/cli/src/runner/mutations-onboard.json): each anchor still applies, once.
// Apart from eval-jarvis-onboard.test.ts on purpose: every mutation removes its own anchor, so this test fails
// on every mutation, and the mutation check never counts a *-mutations.test.ts file as catching one.
interface Mutation { name: string; file: string; anchor: string; replacement: string }
it("keeps unique onboard-prefixed mutation names and exactly one occurrence of every anchor", () => {
  const defs = JSON.parse(readFileSync("packages/cli/src/runner/mutations-onboard.json", "utf8")) as Mutation[];
  expect(defs.length).toBeGreaterThanOrEqual(12);
  expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
  for (const d of defs) {
    expect(d.name).toMatch(/^onboard: /);
    expect(d.file).toMatch(/^packages\/cli\/src\/(eval\/jarvis|runner\/onboard-step|triage\/triage)\.ts$/);
    expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1, d.name).toBe(1);
    expect(d.replacement).not.toBe(d.anchor);
  }
});
