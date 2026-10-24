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

/** Splits a document into its visible `## ` sections, with HTML comments removed. */
function visibleSections(text: string): Map<string, string[]> {
  const visible = text.replace(/<!--[\s\S]*?-->/g, "");
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of visible.split("\n")) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2) out.set(h2[1]!.trim(), (current = []));
    else if (current && line.trim()) current.push(line.trim());
  }
  return out;
}

describe("templates/spec.md (decision 83's grammar)", () => {
  const SECTIONS = ["Goals", "Non-goals", "User stories", "Acceptance criteria", "Assumptions", "Open questions"];

  it("starts with exactly the six front matter lines, then the optional H1", () => {
    const lines = read("spec.md").split("\n");
    expect(lines.slice(0, 7)).toEqual(["---", "spec: 1", "date: YYYY-MM-DD", "status: draft", "supersedes: none", "---", "# Spec v1"]);
  });

  it("has exactly the six sections, in order, and no other H1 or H2", () => {
    const text = read("spec.md");
    expect(headings(text)).toEqual(SECTIONS);
    const visible = text.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible.match(/^ {0,3}# /gm)).toHaveLength(1);
  });

  it("never puts a heading or an entry-shaped line inside a comment, where a line-based checker would read it", () => {
    const comments = read("spec.md").match(/<!--[\s\S]*?-->/g) ?? [];
    for (const line of comments.join("\n").split("\n")) {
      expect(line, line).not.toMatch(/^ {0,3}#/);
      expect(line.trim(), line).not.toMatch(/^-\s+(?:\*\*|(?:S|AC|A)\d)/);
    }
  });

  it("writes every entry in its exact form, with references that resolve", () => {
    const s = visibleSections(read("spec.md"));
    const stories = s.get("User stories")!.filter((l) => l.startsWith("- "));
    const priorities: string[] = [];
    const ids = new Set<string>();
    for (const l of stories) {
      const m = /^- \*\*(S[1-9]\d*) \((P[123])\):\*\* As \S.*$/.exec(l);
      expect(m, l).not.toBeNull();
      ids.add(m![1]!);
      priorities.push(m![2]!);
    }
    expect(priorities).toEqual([...priorities].sort());
    const covered = new Set<string>();
    for (const l of s.get("Acceptance criteria")!.filter((x) => x.startsWith("- "))) {
      const m = /^- \*\*AC[1-9]\d* \((S[1-9]\d*)\):\*\* WHEN \S.* THE SYSTEM SHALL \S.*$/.exec(l);
      expect(m, l).not.toBeNull();
      expect(ids.has(m![1]!), l).toBe(true);
      covered.add(m![1]!);
    }
    expect([...covered].sort()).toEqual([...ids].sort());
    const assumptions = s.get("Assumptions")!.filter((l) => l.startsWith("- "));
    expect(assumptions.length).toBeGreaterThan(0);
    for (const l of assumptions) expect(l, l).toMatch(/^- \*\*A[1-9]\d* \[(fixed|delegated)\]:\*\* \S/);
    expect(s.get("Open questions")).toEqual(["None."]);
  });

  it("says how an empty section is written", () => {
    expect(read("spec.md")).toContain("`None.`");
  });
});

describe("templates/DESIGN.md (decisions 51–53)", () => {
  it("exists", () => {
    expect(existsSync(`${templatesDir}DESIGN.md`)).toBe(true);
  });

  it("opens with YAML front matter holding the token groups of Google's format, in order", () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(read("DESIGN.md"));
    expect(m, "front matter").not.toBeNull();
    const keys = [...m![1]!.matchAll(/^([a-z][a-z-]*):/gm)].map((k) => k[1]);
    expect(keys).toEqual(["name", "colors", "typography", "rounded", "spacing", "components"]);
    // Components refer to tokens instead of repeating raw values.
    expect(m![1]).toMatch(/\{colors\.[a-z-]+\}/);
  });

  it("has the rationale sections in the format's order", () => {
    expect(headings(read("DESIGN.md"))).toEqual([
      "Overview",
      "Colors",
      "Typography",
      "Layout",
      "Elevation & Depth",
      "Shapes",
      "Components",
      "Do's and Don'ts",
    ]);
  });

  it("records the picked direction, its dials and who picked it", () => {
    const overview = visibleSections(read("DESIGN.md")).get("Overview")!.join("\n");
    expect(overview).toContain("Direction:");
    expect(overview).toMatch(/Dials: layout variance <[^>]+>, motion <[^>]+>, density <[^>]+>/);
    expect(overview).toMatch(/Picked by: user \| default accepted \| default unconfirmed/);
  });

  it("lists the tells the brief asked for, and says theme code is generated, never hand-edited", () => {
    const text = read("DESIGN.md");
    expect(visibleSections(text).get("Do's and Don'ts")!.join("\n")).toMatch(/Tells the brief asks for: /);
    expect(text).toContain("--*: initial");
    expect(text.toLowerCase()).toContain("never edited by hand");
  });
});
