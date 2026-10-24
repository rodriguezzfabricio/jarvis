import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps tests/unit/skills-build-mutations.json applicable. It lives apart from skills-build.test.ts on
// purpose: every mutation removes its own anchor, so this test fails on every mutation, and a mutation
// run of skills-build.test.ts must be caught by the skill checks themselves, not by this one.

describe("skills-build-mutations.json", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const file = fileURLToPath(new URL("./skills-build-mutations.json", import.meta.url));

  it("names mutations whose anchors each appear exactly once, so every one still applies", () => {
    expect(existsSync(file)).toBe(true);
    const muts = JSON.parse(readFileSync(file, "utf8")) as { name: string; file: string; anchor: string; replacement: string }[];
    expect(muts.length).toBeGreaterThanOrEqual(10);
    expect(new Set(muts.map((m) => m.name)).size).toBe(muts.length);
    for (const m of muts) {
      for (const k of ["name", "file", "anchor", "replacement"] as const) expect(typeof m[k], `${m.name}.${k}`).toBe("string");
      expect(m.anchor.length, m.name).toBeGreaterThan(0);
      expect(m.anchor, m.name).not.toBe(m.replacement);
      expect(existsSync(`${repo}${m.file}`), `${m.name}: ${m.file}`).toBe(true);
      expect(readFileSync(`${repo}${m.file}`, "utf8").split(m.anchor).length - 1, m.name).toBe(1);
    }
  });
});
