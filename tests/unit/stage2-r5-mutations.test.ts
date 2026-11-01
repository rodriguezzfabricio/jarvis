import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Applicability only. stage2-r5-rules.test.ts must catch each mutation independently.
describe("stage2-r5-mutations.json", () => {
  it("names one unique mutation per rule with one applicable anchor each", () => {
    const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const mutations = JSON.parse(read("tests/unit/stage2-r5-mutations.json")) as { name: string; file: string; anchor: string; replacement: string }[];
    // The lane's ten defects, plus three the Opus review added: no stall without a renderer, the dropped
    // hard stop, and the reader role's old stop rule (decision 168).
    expect(mutations).toHaveLength(13);
    expect(new Set(mutations.map((m) => m.name)).size).toBe(13);
    for (const mutation of mutations) {
      for (const key of ["name", "file", "anchor", "replacement"] as const) expect(typeof mutation[key], `${mutation.name}.${key}`).toBe("string");
      expect(mutation.name).toMatch(/^stage2 r5 \S/);
      expect(mutation.file).toMatch(/^(?:skills\/(?:intake|spec|design)\/SKILL\.md|plugin\/commands\/jarvis\.md|plugin\/agents\/spec-reader\.md)$/);
      expect(mutation.anchor.length, mutation.name).toBeGreaterThan(0);
      expect(mutation.replacement, mutation.name).not.toBe(mutation.anchor);
      expect(read(mutation.file).split(mutation.anchor).length - 1, mutation.name).toBe(1);
    }
  });
});
