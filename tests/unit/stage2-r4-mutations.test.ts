import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Like skills-mutations.test.ts: this checks applicability only. The phrase tests must catch each
// mutation themselves; removing an anchor also fails this test, which is not mutation evidence.
describe("stage2-r4-mutations.json", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const file = fileURLToPath(new URL("./stage2-r4-mutations.json", import.meta.url));

  it("names one mutation per rule with an anchor that appears exactly once", () => {
    expect(existsSync(file)).toBe(true);
    const mutations = JSON.parse(readFileSync(file, "utf8")) as { name: string; file: string; anchor: string; replacement: string }[];
    expect(mutations).toHaveLength(6);
    expect(new Set(mutations.map((m) => m.name)).size).toBe(mutations.length);
    for (const mutation of mutations) {
      for (const key of ["name", "file", "anchor", "replacement"] as const) expect(typeof mutation[key], `${mutation.name}.${key}`).toBe("string");
      expect(mutation.name).toMatch(/^stage2 r4 \S/);
      expect(mutation.file).toMatch(/^skills\/(?:intake|spec|design)\/SKILL\.md$/);
      expect(mutation.anchor.length, mutation.name).toBeGreaterThan(0);
      expect(mutation.replacement, mutation.name).not.toBe(mutation.anchor);
      expect(readFileSync(`${repo}${mutation.file}`, "utf8").split(mutation.anchor).length - 1, mutation.name).toBe(1);
    }
  });
});
