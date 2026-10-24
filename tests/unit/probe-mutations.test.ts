import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

interface Mutation { name: string; file: string; anchor: string; replacement: string }
it("keeps unique probe-prefixed mutation names and exactly one occurrence of every anchor", () => {
  const definitions = JSON.parse(readFileSync("packages/cli/src/harness/claude/mutations-probe.json", "utf8")) as Mutation[];
  expect(definitions.length).toBeGreaterThanOrEqual(12);
  expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
  for (const d of definitions) {
    expect(d.name).toMatch(/^probe /);
    expect(d.file).toBe("packages/cli/src/harness/claude/probe.ts");
    expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1).toBe(1);
    expect(d.replacement).not.toBe(d.anchor);
  }
});
