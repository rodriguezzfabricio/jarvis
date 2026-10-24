import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The templates the skills fill: the fields each decision requires, in a fixed order.

const templatesDir = fileURLToPath(new URL("../../templates/", import.meta.url));

function read(name: string): string {
  return readFileSync(`${templatesDir}${name}`, "utf8");
}

/** `## ` headings outside HTML comments and fenced code. */
function headings(text: string): string[] {
  const visible = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
  return [...visible.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
}

describe("templates/PRODUCT.md (decision 51)", () => {
  it("exists", () => {
    expect(existsSync(`${templatesDir}PRODUCT.md`)).toBe(true);
  });

  it("has decision 51's product facts, plus first value (decision 55) and taste (decision 39), in order", () => {
    expect(headings(read("PRODUCT.md"))).toEqual([
      "Who it's for",
      "The main job",
      "Where it's used",
      "First value",
      "Voice",
      "Words",
      "Constraints",
      "Taste",
    ]);
  });

  it("keeps visual style out: color, font and token words only in the taste profile", () => {
    const visible = read("PRODUCT.md").replace(/<!--[\s\S]*?-->/g, "");
    const taste = visible.indexOf("\n## Taste\n");
    expect(taste).toBeGreaterThan(0);
    const outsideTaste = visible
      .slice(0, taste)
      .split("\n")
      .filter((l) => !l.startsWith("# ") && !l.startsWith("## "))
      .join("\n")
      .toLowerCase();
    for (const word of ["#", "hex", "color", "colour", "font", "typeface", "token", "palette", "spacing", "radius"]) {
      expect(outsideTaste, word).not.toContain(word);
    }
  });

  it("leaves the first-value budget to the spec (decision 55) and sources every constraint", () => {
    const text = read("PRODUCT.md");
    expect(text).toMatch(/- Budget: see docs\/spec\/v<N>\.md, AC<n>/);
    expect(text).toMatch(/- <constraint> \(source: /);
  });
});
