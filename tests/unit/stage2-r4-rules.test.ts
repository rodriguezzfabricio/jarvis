import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roundSchema } from "../../packages/cli/src/intake/round.ts";

// Stage 2 round 3's six defects (docs/reviews/stage2-run3-summary.md) as general rules in the intake, spec
// and design skills (decision 155). Each test names its rule's section, so a rule moved out of the step
// where the session applies it fails too. stage2-r4-mutations.json breaks each rule; these tests catch it.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const skill = (name: string) => read(`skills/${name}/SKILL.md`);
const section = (text: string, heading: string) => {
  const body = text.split(`\n## ${heading}\n`)[1]?.split(/\n## /)[0];
  expect(body, `## ${heading}`).toBeDefined();
  return body!;
};

describe("stage 2 round 4 rules (decision 155)", () => {
  it("1. a default never narrows the requested outcome, and a build limit is not a product rule", () => {
    const questions = section(skill("intake"), "Write the questions");
    expect(questions).toContain("**Request fidelity.** A recommended default never narrows the requested outcome.");
    expect(questions).toContain("When a project rule really conflicts with the request, quote the exact doc line with its path and line number; the question states the conflict and the default keeps the request's outcome");
    expect(questions).toContain("accepting a default never authorizes the build to spend money, message a real person or bypass a build constraint");
    expect(section(skill("intake"), "Sort product from engineering")).toContain(
      "A project line that limits what the build may do (what it may not deploy, buy, send or connect) is a build constraint, not a product rule: it binds the build and never justifies a default against the request.",
    );
    expect(section(skill("intake"), "Check the decision register")).toContain("its default follows Request fidelity in Write the questions");
    expect(section(skill("intake"), "Frame the job")).toContain("Apply fixed product constraints, not build-action limits, to the map");
    // The superseded wording that made a constrained default look right (decisions 48 and 132).
    for (const old of ["say the default follows it", "Default: keep the old decision", "never weakens a project rule", 'default "keep"']) {
      expect(skill("intake")).not.toContain(old);
    }
  });

  it("2. engineering that protects people outside the project is decided and recorded, never asked", () => {
    const text = section(skill("intake"), "Sort product from engineering");
    expect(text).toContain("Engineering that protects people outside the project (anyone the product messages, stores data about or acts on) is decided by the session and recorded, never left open or asked.");
    expect(text).toContain("a refusal list checked before every message (anyone who declines gets none again)");
    expect(text).toContain("a retention rule for their data");
    expect(text).toContain("an idempotency rule (a retry never repeats a message or action)");
    expect(text).toContain("a mechanism never works against the job story's outcome");
  });

  it("3. the story map covers the new job only, with a later project stage as its boundary", () => {
    const text = section(skill("intake"), "Frame the job");
    expect(text).toContain("A **story map** of the new job only: every stage from its trigger to its last user-visible outcome");
    expect(text).toContain("Name an existing later stage of the project as a boundary, never pull it into the new job.");
  });

  it("4. a spec past one confirmation's budget is cut to the walking skeleton, and the count is the file's", () => {
    const writing = section(skill("spec"), "Write the spec");
    expect(writing).toContain("One confirmation can carry about 20 P1 acceptance criteria and 7 unconfirmed assumptions.");
    expect(writing).toContain("cut it to the walking skeleton as P1 and the rest as P2/P3 stories, each with its own criteria and assumptions");
    expect(writing).toContain("the runner still builds them all, P1 first"); // the planner must cover every criterion (runner/plan.ts)
    expect(writing).toContain("if the walking skeleton alone is over the budget, keep it whole and say so in the confirmation");
    expect(writing).not.toMatch(/keep the spec draft|not part of the build/);
    const confirm = section(skill("spec"), "Confirm");
    expect(confirm).toContain("List every unconfirmed assumption as a short numbered list, each one line with its ID");
    expect(confirm).toContain("the count you report is the count in the file, P2/P3 stories included");
    expect(confirm).toContain("The five-line summary is a digest, not a replacement for this list");
    expect(confirm).not.toContain("It must fit the round's summary of at most 5 lines");
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(confirm)![1]!) as { summary: string; questions: { question: string }[] };
    expect(roundSchema.safeParse(example).success, "the CLI accepts the confirmation example").toBe(true);
    const listed = example.questions[0]!.question.match(/^\d+\. A\d+: .+$/gm) ?? [];
    expect(listed.length).toBeGreaterThan(1);
    expect(example.summary).toContain(`Unconfirmed: ${listed.length} `);
  });

  it("5. what the user confirms is final: artifacts agree before confirmation and change only with a new one", () => {
    const confirm = section(skill("spec"), "Confirm");
    expect(confirm).toContain("Nothing in the spec, `DESIGN.md`, `PRODUCT.md`, the decision register or the picked mockup changes after confirmation without a new confirmation round");
    expect(confirm).toContain("make the spec, `DESIGN.md`, `PRODUCT.md`, the register and the picked mockup agree");
    expect(confirm).toContain('update or mark superseded every file line that states an earlier position, research and intake records included (a "pending" marker, a reversed recommendation');
    expect(confirm).toContain("When design revised the picked mockup, attach its new paths in `mockups`");
    expect(confirm).toContain("| Changes | stays `draft` |");
    expect(confirm).toContain("then show the revised artifacts in a new confirmation round");
    expect(confirm).not.toContain("there's no second round");
    expect(section(skill("spec"), "Check with a fresh reader")).toContain("run that design skill step first (After the pick, or An existing design system), so the reader and the confirmation see the final `DESIGN.md`");
    const handoff = section(skill("spec"), "Hand off");
    expect(handoff).toContain("drift found now goes back through Confirm, never a silent fix");
    expect(handoff).toContain("any step of the design skill already ran before the reader check");
    const design = skill("design");
    expect(section(design, "When to use")).toContain("| The spec skill, before its reader check | A direction was picked, or defaulted |");
    const pick = section(design, "After the pick");
    expect(pick).toContain("This step runs before the spec is confirmed: write every token and design rule decided here into `DESIGN.md` and record it (step 4) before the confirmation goes out.");
    expect(pick).toContain("If the spec changes a screen or flow the picked mockup shows, revise that mockup and give the spec its new screenshots");
    expect(pick).toContain("After confirmation, `DESIGN.md` and the mockup change only through the spec skill's Confirm rule.");
    const pipeline = section(read("plugin/commands/jarvis.md"), "2. Start the pipeline");
    expect(pipeline).toContain("spec runs the `design` skill's \"after the pick\" part before its reader check, so DESIGN.md is confirmed with the spec");
    expect(pipeline).toContain("never change a confirmed artifact here.");
    expect(pipeline).not.toContain("after spec hands back, run the `design` skill's");
    // Decision 86 still holds mid-run: a steer, veto or repair version is never sent for confirmation.
    expect(section(skill("spec"), "When to use")).toContain("a mid-run version never gets its own confirmation round");
  });

  it("6. an answer that contradicts another accepted default re-asks it once, before the spec", () => {
    const answers = section(skill("intake"), "Take the answers");
    expect(answers).toContain("When an answer contradicts an accepted default of another question in the same round, re-ask that default once, in a short second round that holds only the contradicted defaults, before the spec starts.");
    expect(answers).toContain("Never silently keep or replace the contradicted default.");
    expect(answers).toContain("Only one repair round runs; a conflict that remains becomes an unconfirmed assumption listed first in the spec confirmation.");
    expect(answers.indexOf("**Contradiction repair.**")).toBeLessThan(answers.indexOf("Then, in this order:"));
    expect(answers.indexOf("**Contradiction repair.**")).toBeGreaterThan(-1);
    expect(section(skill("intake"), "Write the questions")).toContain("The contradiction repair in Take the answers is the only exception.");
    expect(section(skill("intake"), "Send the round")).toContain("add no second round but the contradiction repair in Take the answers");
  });

  it("states the rules without golden-task vocabulary", () => {
    // The ban-list lives only in stage2-plugin-contamination.test.ts (decision 132) and isn't exported, since
    // importing a test file would run its tests here. Read it from there instead of keeping a second copy.
    const source = read("tests/unit/stage2-plugin-contamination.test.ts").split("const forbidden = [")[1]!.split("\n];")[0]!;
    const forbidden = [...source.matchAll(/\/((?:\\.|[^/\n])+)\/i\b/g)].map((m) => new RegExp(m[1]!, "i"));
    expect(forbidden.length, "the ban-list parsed").toBeGreaterThanOrEqual(28);
    expect(forbidden.some((pattern) => pattern.test("a suppression list"))).toBe(true);
    for (const file of ["skills/intake/SKILL.md", "skills/spec/SKILL.md", "skills/design/SKILL.md", "plugin/commands/jarvis.md"]) {
      expect(forbidden.filter((pattern) => pattern.test(read(file))).map(String), file).toEqual([]);
    }
  });
});
