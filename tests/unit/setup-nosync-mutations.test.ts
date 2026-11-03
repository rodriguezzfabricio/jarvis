import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Decision 154's mutations (tests/unit/setup-nosync-mutations.json): each anchor still applies, once. This checks
// applicability only. setup-nosync.test.ts must catch each mutation itself; removing an anchor also fails this
// test, which is not mutation evidence.
interface Mutation { name: string; file: string; anchor: string; replacement: string }
it("keeps unique nosync-prefixed mutation names and exactly one occurrence of every anchor", () => {
  const definitions = JSON.parse(readFileSync("tests/unit/setup-nosync-mutations.json", "utf8")) as Mutation[];
  expect(definitions.length).toBeGreaterThanOrEqual(14);
  expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
  for (const d of definitions) {
    expect(d.name).toMatch(/^nosync: \S/);
    expect(d.file).toMatch(/^(?:vitest\.config\.ts|tests\/setup\/nosync(?:-fsync)?\.ts)$/);
    expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1, d.name).toBe(1);
    expect(d.replacement, d.name).not.toBe(d.anchor);
  }
});
