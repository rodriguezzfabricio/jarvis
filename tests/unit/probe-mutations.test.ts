import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

interface Mutation { name: string; file: string; anchor: string; replacement: string }
const sets = [
  { path: "packages/cli/src/harness/claude/mutations-probe.json", prefix: /^probe /, file: /^packages\/cli\/src\/harness\/claude\/probe\.ts$/, min: 19 },
  { path: "packages/cli/src/harness/claude/mutations-settings.json", prefix: /^settings /, file: /^packages\/cli\/src\/(harness\/claude\/(settings|task|desktop-evidence)|sandbox\/temp|checks\/gate)\.ts$/, min: 16 },
];
for (const set of sets) {
  it(`keeps unique prefixed mutation names and exactly one occurrence of every anchor (${set.path})`, () => {
    const definitions = JSON.parse(readFileSync(set.path, "utf8")) as Mutation[];
    expect(definitions.length).toBeGreaterThanOrEqual(set.min);
    expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
    for (const d of definitions) {
      expect(d.name).toMatch(set.prefix);
      expect(d.file).toMatch(set.file);
      expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1).toBe(1);
      expect(d.replacement).not.toBe(d.anchor);
    }
  });
}
