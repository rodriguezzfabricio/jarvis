import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

interface Mutation { name: string; file: string; anchor: string; replacement: string }
it("keeps unique eval-jarvis-prefixed mutation names and exactly one occurrence of every anchor", () => {
  const definitions = JSON.parse(readFileSync("packages/cli/src/eval/mutations-jarvis.json", "utf8")) as Mutation[];
  expect(definitions.length).toBeGreaterThanOrEqual(30);
  expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
  for (const d of definitions) {
    expect(d.name).toMatch(/^eval jarvis /);
    expect(d.file).toMatch(/^packages\/cli\/src\/eval\/(jarvis|hidden|compare|schedule)\.ts$/);
    expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1, d.name).toBe(1);
    expect(d.replacement).not.toBe(d.anchor);
  }
});
