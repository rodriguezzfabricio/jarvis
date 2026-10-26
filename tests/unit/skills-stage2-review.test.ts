import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Findings from the Opus review of the stage2-fixes lane (Oct 25). The stage 2 rerun re-rates golden
// tasks 01 and 11 (decision 105); the round-1 judges' findings are general rules here, not examples.
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, `## ${heading}`).toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("stage 2 skills teach rules, not the rerun's answers (decisions 35, 105)", () => {
  const files = [
    "skills/research/SKILL.md", "skills/intake/SKILL.md", "skills/spec/SKILL.md", "skills/design/SKILL.md",
    "plugin/commands/jarvis.md", "plugin/agents/researcher.md", "plugin/agents/spec-reader.md",
  ];
  // Specifics the round-1 verdicts found in the task 01 and task 11 runs (docs/reviews/stage2-run1-*).
  const specifics = [
    /calendar/i, /streak/i, /\.ics\b/i, /logged days/i, /re-import/i, /contact (finding|entry)/i, /\bRecruiter\b/,
    /reach(ing|ed) out/i, /mail client/i, /metering/i, /plan pricing/i, /\bA(24|25|33)\b/, /single-owner/i,
    /private forks?/i, /target edits?/i,
  ];
  it.each(files)("%s names none of the round-1 verdicts' task specifics", (file) => {
    const text = read(file);
    for (const pattern of specifics) expect(text, `${file}: ${pattern}`).not.toMatch(pattern);
  });
});

describe("intake keeps the guidance the lane's compression dropped", () => {
  const gotchas = section(read("skills/intake/SKILL.md"), "Gotchas");
  it("asks where the user will see the result when the request names no surface", () => {
    expect(gotchas).toContain("**\"Where will you see it?\" is usually a real question.**");
  });
  it("never asks engineering questions to look careful", () => {
    expect(gotchas).toContain("**Don't ask engineering questions to look careful.**");
  });
  it("keeps the unconfirmed label to the report", () => {
    expect(gotchas).toContain("**Unconfirmed isn't confirmed.**");
  });
});

describe("the taste offer never holds the round (decision 86)", () => {
  it("offers it in its own message and keeps working without waiting", () => {
    const inputs = section(read("skills/intake/SKILL.md"), "Inputs");
    expect(inputs).toContain("never end the turn on it");
    expect(inputs).toContain("send the round without a profile");
  });
});

describe("spec confirmation changes keep the user's exact words (decision 119)", () => {
  const confirm = section(read("skills/spec/SKILL.md"), "Confirm");
  it("records the change answer once, quoting it, with its answer reference", () => {
    expect(confirm).toContain("record the answer once as the user's decision, its text the exact recorded answer, with `--answer <answerSeq>:CONFIRM`");
    expect(confirm).not.toContain("record each change as the user's decision");
  });
});

describe("bundled skill templates are the canonical templates", () => {
  it.each([
    ["skills/intake/templates/PRODUCT.md", "templates/PRODUCT.md"],
    ["skills/spec/templates/spec.md", "templates/spec.md"],
    ["skills/design/templates/DESIGN.md", "templates/DESIGN.md"],
  ])("%s matches %s", (bundled, canonical) => {
    expect(read(bundled)).toBe(read(canonical));
  });
});
