import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Decision 126's mutations (packages/cli/src/runner/mutations-review-fix.json): each anchor still applies, once.
interface Mutation { name: string; file: string; anchor: string; replacement: string }
it("keeps unique review-fix-prefixed mutation names and exactly one occurrence of every anchor", () => {
  const definitions = JSON.parse(readFileSync("packages/cli/src/runner/mutations-review-fix.json", "utf8")) as Mutation[];
  expect(definitions.length).toBeGreaterThanOrEqual(35);
  expect(new Set(definitions.map((d) => d.name)).size).toBe(definitions.length);
  for (const d of definitions) {
    expect(d.name).toMatch(/^review fix: /);
    expect(d.file).toMatch(/^packages\/cli\/src\/(triage\/(triage|fix-words)|runner\/(review-path|review-fix|session-skills|plan|loop|report)|eval\/jarvis|commands\/(run|run-compose))\.ts$/);
    expect(readFileSync(d.file, "utf8").split(d.anchor).length - 1, d.name).toBe(1);
    expect(d.replacement).not.toBe(d.anchor);
  }
});
