import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

interface Mutation { name: string; file: string; anchor: string; replacement: string }
it("keeps unique intake-prefixed mutation names and exactly one occurrence of every anchor", () => {
  const definitions = JSON.parse(readFileSync("packages/cli/src/intake/mutations.json", "utf8")) as Mutation[];
  expect(definitions.length).toBeGreaterThanOrEqual(17);
  expect(new Set(definitions.map((definition) => definition.name)).size).toBe(definitions.length);
  for (const definition of definitions) {
    expect(definition.name).toMatch(/^intake /);
    expect(definition.file).toMatch(/^packages\/cli\/src\/(intake\/|config\/project\.ts$)/);
    expect(readFileSync(definition.file, "utf8").split(definition.anchor).length - 1).toBe(1);
    expect(definition.replacement).not.toBe(definition.anchor);
  }
});
