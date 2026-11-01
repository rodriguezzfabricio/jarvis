import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Round 4's defects as general rules, checked where the session applies them. These assertions
// establish instruction coverage; session behavior still needs the independent stage 2 proof.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const skill = (name: string) => read(`skills/${name}/SKILL.md`);
const section = (text: string, heading: string) => {
  const body = text.split(`\n## ${heading}\n`)[1]?.split(/\n## /)[0];
  expect(body, `## ${heading}`).toBeDefined();
  return body!;
};

describe("stage 2 round 5 rules", () => {
  it("1. caps all fresh-reader passes per spec version and brings remaining gaps to confirmation", () => {
    const text = section(skill("spec"), "Check with a fresh reader");
    expect(text).toContain("At most 3 fresh-reader passes in total per spec version, including checks after confirmation changes.");
    expect(text).toContain("Never reset the count, even for new blockers or revised wording.");
    expect(text).toContain('At the cap, turn every remaining blocking product question into a `[delegated]` assumption labeled "default unconfirmed", listed first in the confirmation; report every other remaining blocker there as a known gap. Then start confirmation, never another reader.');
    expect(text).toContain("Record the pass count and unresolved gaps in the intake record under Spec check vN.");
    expect(section(skill("spec"), "Confirm")).toContain("Include every known gap from the reader cap in the confirmation question and the printed page.");
    expect(read("skills/intake/references/intake-record.md")).toContain("Fresh-reader passes: <0–3 total, never reset>");
    for (const old of ["3 passes with no new blocking gap", "until a pass finds no blocking gaps", "unresolved blocking gaps leave the spec draft and prevent hand-off", "run the checker and reader again"]) expect(skill("spec")).not.toContain(old);
    expect(read("skills/intake/references/principles.md")).not.toContain("unresolved blockers still prevent hand-off");
  });

  it("2. thins an oversized skeleton and keeps criteria observable by the user", () => {
    const text = section(skill("spec"), "Write the spec");
    expect(text).toContain("A walking skeleton over the budget is too thick: thin it to the shortest complete path and move the rest to P2/P3.");
    expect(text).toContain("Acceptance criteria state behavior the user can observe. Implementation mechanics belong in the intake record's Engineering decisions, unless a safeguard needs them to be checkable.");
    expect(text).toContain("Never drop a safeguard or a fixed constraint, or merge independent assumptions, to fit.");
    expect(text).not.toContain("if the walking skeleton alone is over the budget, keep it whole");
    expect(text).not.toContain("Implementation mechanics belong in acceptance criteria");
  });

  it("3. defaults about personal circumstances never invent the user's history", () => {
    const text = section(skill("intake"), "Write the questions");
    expect(text).toContain("For a question about the user's own past or situation, use a neutral default stating what the product assumes when unknown; never invent a first-person answer or record an unknown history as fact.");
    expect(text).not.toMatch(/default (?:may|should) invent a first-person answer/i);
  });

  it("4. defaults cannot choose their own stated failure risk without a reason", () => {
    const text = section(skill("intake"), "Write the questions");
    expect(text).toContain("A recommended default must not choose the option its own trade-off names as a product failure risk, unless the question says in one line why that risk is accepted.");
    expect(text).not.toContain("Choose the failure-risk option without explaining why");
  });

  it("5. asks the product need and decides the provider as engineering", () => {
    const text = section(skill("intake"), "Sort product from engineering");
    expect(text).toContain("Ask the product need, not which storage provider to use; decide the provider as engineering unless the user must hold an account, pay, or would notice the difference.");
    expect(text).not.toContain("Ask the user to choose between storage providers");
  });

  it("6. checks the complete question against both kinds of constraint before sending", () => {
    const text = section(skill("intake"), "Send the round");
    expect(text).toContain("Before sending, check each question's text, trade-off and default against the fixed constraints and build constraints; remove promises the build cannot keep and surface real conflicts under Request fidelity.");
    expect(text).not.toContain("Check only the default against constraints");
  });

  it("7. surfaces later scope expansion and safeguard overrides as unconfirmed assumptions", () => {
    const text = section(skill("spec"), "Write the spec");
    expect(text).toContain('A decision after intake that widens who or what the product acts on, or overrides a safeguard research found, is a `[delegated]` assumption labeled "default unconfirmed" in the confirmation, never a silent Mechanical or Taste call.');
    expect(text).toContain("This label never authorizes bypassing a fixed constraint or a hard stop.");
    expect(text).not.toContain("Scope expansion after intake is a silent Taste call");
  });

  it("8. looks at newly rendered mockups after every edit and names the revisions in confirmation", () => {
    const text = section(skill("design"), "After the pick");
    expect(text).toContain("After any edit to a mockup, re-render it at its phone width and re-render the comparison page; look at both screenshots before the confirmation round.");
    expect(text).toContain("The confirmation names the revised HTML and screenshot files.");
    expect(text).toContain("If rendering is unavailable, keep confirmation pending and report the missing visual check; never present an old screenshot as the revised file.");
    expect(text).not.toContain("or local HTML paths when screenshots are unavailable");
    expect(text).not.toContain("After a mockup edit, reuse the old screenshot");
  });

  it("9. records a decision statement with attribution and question ID, and classifies the design pick as Taste", () => {
    const text = section(skill("intake"), "Take the answers");
    expect(text).toContain("An entry states the decision itself, with who gave it and the question ID; never use a bare acknowledgement as decision text. A design direction pick is Taste, whoever gave it.");
    expect(text).toContain('--recorded-answer "<the exact recorded answer>"');
    expect(text).toContain('"<the decision itself, with question ID>"');
    expect(text).not.toContain('--source docs/intake/<file>.md "<the exact recorded answer>"');
    expect(text).not.toContain("| `user` | `mechanical` |");
    const examples = read("skills/intake/references/decision-examples.md");
    expect(examples).toContain('--recorded-answer "<the exact recorded answer>"');
    expect(examples).not.toContain('--source docs/intake/<file>.md "<the exact recorded answer>"');
    const confirm = section(skill("spec"), "Confirm");
    expect(confirm).toContain("record the answer once with its exact words as evidence, the decision itself as entry text");
    expect(confirm).not.toContain("its text the exact recorded answer");
  });

  it("10. keeps learnings in project notes and never writes Claude Code memory", () => {
    const text = section(read("plugin/commands/jarvis.md"), "1. Triage");
    expect(text).toContain("Never write Claude Code memory files, including its auto-memory folders, through any tool. Put learnings in the project's own notes named by the skills, such as `.jarvis/notes/` or `docs/intake/`.");
    expect(text).not.toContain("Write learnings to Claude Code memory");
  });
});
