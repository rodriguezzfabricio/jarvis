import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSpec, parseSpec } from "../../packages/cli/src/spec/parser.ts";

const source = readFileSync(new URL("../fixtures/spec/v1.md", import.meta.url), "utf8");
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

describe("spec format (decisions 9, 10)", () => {
  it("parses the agreed format with stable IDs and source lines", () => {
    const { spec, problems } = parseSpec(source);
    expect(problems).toEqual([]);
    expect(spec).toMatchObject({ version: 1, date: "2026-10-24", status: "unconfirmed", supersedes: null });
    expect(spec.stories).toHaveLength(3);
    expect(spec.stories[0]).toMatchObject({ id: "S1", priority: "P1", text: "As a user, I can record a habit.", line: lineOf(source, "**S1") });
    expect(spec.criteria[0]).toMatchObject({ id: "AC1", storyId: "S1", text: "WHEN I save a habit THE SYSTEM SHALL store it locally." });
    expect(spec.assumptions.map((a) => [a.id, a.kind])).toEqual([["A1", "fixed"], ["A2", "delegated"]]);
    expect(checkSpec(source, "v1.md")).toMatchObject({ ok: true, problems: [] });
  });

  it.each(["draft", "confirmed", "unconfirmed"])("accepts status %s without deciding approval", (status) => {
    expect(checkSpec(source.replace("status: unconfirmed", `status: ${status}`), "v1.md").ok).toBe(true);
  });

  it("accepts no H1, narrative, subheadings, CRLF and explicitly absent assumptions", () => {
    const text = source.replace("# Spec v1", "A local habit tracker.")
      .replace("## User stories", "## User stories\n### Daily use\nThese are ranked by importance.")
      .replace("- **A1 [fixed]:** No paid services.\n- **A2 [delegated]:** Use a local file for storage.", "None.")
      .replaceAll("\n", "\r\n");
    expect(checkSpec(text, "v1.md")).toMatchObject({ ok: true, problems: [] });
  });

  it("accepts positive later versions with their immediate predecessor", () => {
    const text = source.replace("spec: 1", "spec: 12").replace("Spec v1", "Spec v12").replace("supersedes: none", "supersedes: 11");
    expect(checkSpec(text, "v12.md").ok).toBe(true);
  });

  const cases: [string, string, string, string][] = [
    ["front matter opening", "---", "not front matter", "front-matter"],
    ["version", "spec: 1", "spec: 0", "version"],
    ["unsafe version", "spec: 1", "spec: 9007199254740992", "version"],
    ["date syntax", "date: 2026-10-24", "date: today", "date"],
    ["calendar date", "date: 2026-10-24", "date: 2026-02-30", "date"],
    ["status", "status: unconfirmed", "status: accepted", "status"],
    ["v1 predecessor", "supersedes: none", "supersedes: 0", "supersedes"],
    ["front matter order", "spec: 1\ndate: 2026-10-24", "date: 2026-10-24\nspec: 1", "version"],
    ["H1 version", "# Spec v1", "# Spec v2", "heading-version"],
    ["story ID", "**S1 (P1):**", "**S0 (P1):**", "malformed-id"],
    ["story priority", "**S1 (P1):**", "**S1 (P4):**", "story"],
    ["story form", "As a user, I can record a habit.", "Record a habit.", "story"],
    ["empty story", "As a user, I can record a habit.", "As ", "story"],
    ["criterion ID", "**AC1 (S1):**", "**AC0 (S1):**", "malformed-id"],
    ["criterion reference syntax", "**AC1 (S1):**", "**AC1 (X1):**", "malformed-id"],
    ["unknown story", "**AC1 (S1):**", "**AC1 (S99):**", "unknown-story"],
    ["EARS keyword", "WHEN I save a habit", "IF I save a habit", "ears"],
    ["empty condition", "WHEN I save a habit", "WHEN ", "ears"],
    ["empty result", "store it locally.", " ", "ears"],
    ["empty assumption", "No paid services.", " ", "assumption"],
    ["assumption kind", "**A1 [fixed]:**", "**A1 [taste]:**", "assumption"],
    ["missing assumption kind", "**A1 [fixed]:**", "**A1:**", "assumption"],
    ["assumption ID", "**A1 [fixed]:**", "**A0 [fixed]:**", "malformed-id"],
    ["story priority order", "**S1 (P1):**", "**S1 (P3):**", "priority-order"],
  ];
  it.each(cases)("reports %s on its source line", (_name, old, replacement, code) => {
    const text = source.replace(old, replacement);
    const expectedLine = code === "priority-order" ? lineOf(text, "**S2") : lineOf(source, old.split("\n")[0]!);
    expect(checkSpec(text, "v1.md").problems).toContainEqual(expect.objectContaining({ line: expectedLine, code }));
  });

  it.each(["Goals", "Non-goals", "User stories", "Acceptance criteria", "Assumptions", "Open questions"])("requires the %s section", (section) => {
    expect(checkSpec(source.replace(`## ${section}`, `### ${section}`)).problems)
      .toContainEqual(expect.objectContaining({ code: "missing-section", line: 1, message: expect.stringContaining(section) }));
  });

  it.each(["Goals", "Non-goals", "User stories", "Acceptance criteria", "Assumptions", "Open questions"])("requires nonempty %s content", (section) => {
    const text = source.replace(new RegExp(`(## ${section}\\n)[\\s\\S]*?(?=\\n## |$)`), "$1");
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ code: "section-content", line: lineOf(text, `## ${section}`) }));
  });

  it.each([["S2 (P2)", "S1 (P2)"], ["AC2 (S2)", "AC1 (S2)"], ["A2 [delegated]", "A1 [delegated]"]])("rejects duplicate IDs: %s", (old, replacement) => {
    const text = source.replace(old, replacement);
    const lines = text.split("\n");
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ code: "duplicate-id", line: lines.findIndex((line) => line.includes(replacement)) + 1 }));
  });

  it("requires a criterion for every story, including P2 and P3", () => {
    const text = source.replace(/^- \*\*AC[123].*\n/gm, "");
    const result = checkSpec(text);
    for (const id of ["S1", "S2", "S3"]) {
      expect(result.problems).toContainEqual(expect.objectContaining({ code: "story-without-criterion", line: lineOf(text, `**${id} `) }));
    }
  });

  it("reports all independent problems together", () => {
    const text = source.replace("status: unconfirmed", "status: wrong").replace("**S2 (P2):**", "**S1 (P2):**").replace("WHEN I save", "IF I save").replace("[fixed]", "[unknown]");
    const result = checkSpec(text);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["status", "duplicate-id", "ears", "assumption", "unknown-story"]));
    expect(result.problems.every((p) => Number.isInteger(p.line) && p.line >= 1)).toBe(true);
  });

  it("rejects duplicate and extra H2 headings, wrong section order and a second H1", () => {
    const text = source.replace("## Non-goals", "## Goals\n## Extra\n## Non-goals").replace("## Open questions", "## Open questions\n# Spec v1");
    expect(checkSpec(text).problems.map((p) => p.code)).toEqual(expect.arrayContaining(["duplicate-section", "unknown-section", "h1"]));
    const swapped = source.replace("## Goals", "## TEMP").replace("## Non-goals", "## Goals").replace("## TEMP", "## Non-goals");
    expect(checkSpec(swapped).problems.map((p) => p.code)).toContain("section-order");
  });

  it("requires front matter to end on line 6 and rejects extra metadata", () => {
    const text = source.replace("supersedes: none\n---", "supersedes: none\nextra: true\n---");
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ line: 6, code: "front-matter" }));
  });

  it("checks the file name, the optional H1, and later supersedes", () => {
    expect(checkSpec(source, "/repo/docs/spec/v2.md").problems).toContainEqual(expect.objectContaining({ code: "filename-version", line: 2 }));
    expect(checkSpec(source, "latest.md").problems).toContainEqual(expect.objectContaining({ code: "filename-version", line: 2 }));
    const text = source.replace("spec: 1", "spec: 3").replace("Spec v1", "Spec v3");
    expect(checkSpec(text, "v3.md").problems).toContainEqual(expect.objectContaining({ code: "supersedes", line: 5 }));
  });

  it("does not treat fenced examples as real sections, stories or criteria", () => {
    const text = source.replace("## User stories", "```md\n## User stories").replace("## Acceptance criteria", "```\n## Acceptance criteria");
    expect(checkSpec(text).problems.map((p) => p.code)).toContain("missing-section");
    expect(parseSpec(text).spec.stories).toHaveLength(0);
  });

  it("rejects None mixed with assumptions and keeps attached narrative for ID diffs", () => {
    expect(checkSpec(source.replace("## Assumptions", "## Assumptions\nNone.")).ok).toBe(false);
    const text = source.replace("No paid services.", "No paid services.\nThis includes trials that need a card.");
    expect(parseSpec(text).spec.assumptions[0]?.details).toContain("trials");
    expect(checkSpec(text).ok).toBe(true);
  });

  it.each(["  ## Extra", "##\tExtra", "##"])("rejects extra Markdown H2 headings spelled %j", (heading) => {
    const text = `${source}\n${heading}\nUnexpected section.\n`;
    const line = text.split("\n").findIndex((value) => value === heading) + 1;
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ line, code: "unknown-section" }));
  });

  it("requires literal H1 and H2 spelling even when Markdown permits leading spaces", () => {
    expect(checkSpec(source.replace("# Spec v1", "  # Spec v1")).ok).toBe(false);
    expect(checkSpec(source.replace("## Goals", "  ## Goals")).ok).toBe(false);
  });

  it.each(["#", "  # Spec v1", "#\tSpec v1"])("rejects extra or nonliteral H1 headings spelled %j", (heading) => {
    expect(checkSpec(`${source}\n${heading}\n`).ok).toBe(false);
  });
});

describe("spec review regressions", () => {
  const sections = [
    { heading: "User stories", code: "story", first: "- **S1 (P1):** As a user, I can record a habit.", entries: "stories" },
    { heading: "Acceptance criteria", code: "criterion", first: "- **AC1 (S1):** WHEN I save a habit THE SYSTEM SHALL store it locally.", entries: "criteria" },
    { heading: "Assumptions", code: "assumption", first: "- **A1 [fixed]:** No paid services.", entries: "assumptions" },
  ] as const;
  const candidates = ["- Uses Postgres.", "* Plain entry.", "+ Plain entry.", "1. Plain entry.", "1) Plain entry.",
    "WHEN offline THE SYSTEM SHALL queue.", "**S9 (P3):** As a user, I can export.", "**AC9 (S1):** WHEN offline THE SYSTEM SHALL queue.", "**A9 [fixed]:** Keep data locally."];
  for (const section of sections) {
    it.each(candidates)(`reports entry-like text in ${section.heading} at its own line: %s`, (candidate) => {
      const text = source.replace(section.first, `${section.first}\n${candidate}`);
      expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ line: lineOf(text, candidate), code: section.code }));
      expect(parseSpec(text).spec[section.entries][0]?.details).not.toContain(candidate);
    });

    it(`keeps indented sub-bullets as details in ${section.heading}`, () => {
      const detail = `  - ${section.first.slice(2).replaceAll("1", "99")}`;
      const text = source.replace(section.first, `${section.first}\n${detail}`);
      const parsed = parseSpec(text);
      expect(parsed.spec[section.entries]).toHaveLength(section.entries === "assumptions" ? 2 : 3);
      expect(checkSpec(text).ok).toBe(true);
      expect(parsed.spec[section.entries][0]?.details).toContain(detail.trim());
    });

    it(`ends the current entry at a subheading in ${section.heading}`, () => {
      const text = source.replace(section.first, `${section.first}\n### Notes\nShared context.`);
      expect(parseSpec(text).spec[section.entries][0]?.details).toBe("");
      expect(checkSpec(text).ok).toBe(true);
    });

    it(`ignores entries inside HTML comments in ${section.heading}`, () => {
      const hidden = section.first.replaceAll("1", "99");
      const text = source.replace(section.first, `${section.first}\n<!--\n${hidden}\n-->`);
      const parsed = parseSpec(text);
      expect(parsed.spec[section.entries]).toHaveLength(section.entries === "assumptions" ? 2 : 3);
      expect(parsed.spec[section.entries][0]?.details).toBe("");
      expect(checkSpec(text).ok).toBe(true);
    });
  }

  it.each(["* **S2 (P2):** As a user, I can export.", "1. **S1 (P1):** As a user, I can export."])("rejects a non-dash story entry: %s", (candidate) => {
    const text = source.replace("## User stories", `## User stories\n${candidate}`);
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ code: "story", line: lineOf(text, candidate) }));
  });

  it("reports an ID-less EARS bullet on its own line", () => {
    const candidate = "- WHEN offline THE SYSTEM SHALL queue.";
    const text = source.replace("## Acceptance criteria", `## Acceptance criteria\n${candidate}`);
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ code: "criterion", line: lineOf(text, candidate) }));
  });

  it.each([["Goals", "- Keep a local list of habits."], ["Non-goals", "- None."]])("accepts prose-only %s under decision 83", (_section, old) => {
    expect(checkSpec(source.replace(old, "A plain paragraph with no list marker.")).ok).toBe(true);
  });

  it.each(["Goals", "Non-goals", "Open questions"])("does not count HTML comments as %s content", (heading) => {
    const text = source.replace(new RegExp(`(## ${heading}\\n)[\\s\\S]*?(?=\\n## |$)`), "$1<!--\n- Hidden content.\n-->");
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ line: lineOf(text, `## ${heading}`), code: "section-content" }));
  });

  it("ignores inline comments without losing visible content or source line numbers", () => {
    const text = source.replace("No paid services.", "<!-- hidden -->No paid services.<!-- extra -->");
    const assumption = parseSpec(text).spec.assumptions[0];
    expect(assumption?.text).toBe("No paid services.");
    expect(assumption?.line).toBe(lineOf(text, "**A1"));
    expect(checkSpec(text).ok).toBe(true);
  });

  it("tells an author to write None. without the bullet", () => {
    const text = source.replace(/(## Assumptions\n)[\s\S]*?(?=\n## )/, "$1- None.\n");
    expect(checkSpec(text).problems).toContainEqual(expect.objectContaining({ line: lineOf(text, "## Assumptions") + 1, message: expect.stringContaining("None. without the bullet") }));
  });

  it.each(["S", "AC", "A"])("caps an echoed malformed %s ID at 80 characters", (prefix) => {
    const text = source.replace(`**${prefix}1`, `**${prefix}${"9".repeat(200)}`);
    const message = checkSpec(text).problems.find((p) => p.code === "malformed-id")?.message ?? "";
    expect(message).not.toContain("9".repeat(81));
    expect(message).toContain(`${prefix}${"9".repeat(80 - prefix.length)}`);
  });

  it("caps an echoed unknown heading at 80 characters", () => {
    const text = `${source}\n## ${"H".repeat(200)}\n`;
    const message = checkSpec(text).problems.find((p) => p.code === "unknown-section")?.message ?? "";
    expect(message).not.toContain("H".repeat(81));
    expect(message).toContain("H".repeat(80));
  });
});
