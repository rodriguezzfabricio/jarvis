import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const intake = () => read("skills/intake/SKILL.md");

describe("general intake principles", () => {
  it("decides engineering without turning implementation policy into user questions", () => {
    expect(intake()).toContain("the mechanism for an outcome that the request, the project's rules, the law or the code already settle");
    expect(intake()).toContain("never ask the user to design the mechanism");
    expect(intake()).toContain("Decide these yourself and record Decision / Rationale / Alternatives");
    expect(intake()).toContain("Ask only what only the user can answer");
  });

  it("asks about the person's current situation before solution preferences for a new product", () => {
    expect(intake()).toContain("For a new product, ask what the person does today and what's broken before solution questions");
    expect(intake()).toContain("If their request already answers this, cite it instead of asking again");
  });

  it("leaves release, production and spending permissions to ship", () => {
    expect(intake()).toContain("Release, production and spending permissions are not intake questions; the ship stage asks them");
    expect(intake()).not.toContain("The production grant** is one of the questions");
    expect(intake()).not.toContain("only an explicit answer the user gives in the session grants production");
    expect(read("skills/research/SKILL.md")).not.toContain("raise the budget as a product question");
    expect(read("skills/ship/SKILL.md")).toContain("Ask for release, production and spending permissions here");
  });

  it("counts every ask including profile offers and their component questions within seven", () => {
    expect(intake()).toContain("The cap counts every question asked in this intake, including any profile offer");
    expect(intake()).toContain("Count each independently answerable part of a bundled prompt");
    expect(intake()).toContain("never add a separate profile questionnaire");
    expect(intake()).toContain("Only for a complete supplied profile");
    expect(intake()).toContain("Keep partial preferences in `PRODUCT.md` without inventing fields or asking extra questions");
    expect(intake()).not.toMatch(/outside the 7 questions|standalone taste-profile offer/);
    expect(intake()).toContain("The spec confirmation is a separate round, labeled as such");
    const spec = read("skills/spec/SKILL.md");
    expect(spec).toContain("This is the separate spec confirmation round");
    const example = spec.split("## Confirm\n")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!;
    expect(JSON.parse(example).summary).toMatch(/^Separate spec confirmation round\n/);
  });

  it("preserves the requested outcome and quotes any project rule that forbids it", () => {
    expect(intake()).toContain("Never drop or replace the core of the user's request");
    expect(intake()).toContain("quote the exact doc line with its path and line number and say the default follows it");
    expect(intake()).toContain("Keep the conflict visible");
  });

  it("caps the reader loop without allowing unresolved blockers to pass", () => {
    const text = read("skills/spec/SKILL.md");
    expect(text).toContain("Stop after 3 passes with no new blocking gap");
    expect(text).toContain("A clean pass ends the loop immediately");
    expect(text).toContain("Do not reset the count for wording or nonblocking suggestions");
    expect(text).toContain("unresolved blocking gaps leave the spec draft and prevent hand-off");
    expect(read("plugin/agents/spec-reader.md")).toContain("Separate blocking gaps from nonblocking suggestions");
  });

  it("explains why each principle applies across product domains", () => {
    const text = read("skills/intake/references/principles.md");
    expect((text.match(/^- \*\*.+\*\* General because /gm) ?? []).length).toBe(6);
    expect(intake()).toContain("references/principles.md");
  });

  it("keeps the intake record in a referenced bundle and skills under their size limits", () => {
    expect(intake()).toContain("references/intake-record.md");
    expect(read("skills/intake/references/intake-record.md")).toContain("## Engineering decisions");
    expect(intake()).toContain("references/decision-examples.md");
    expect(read("skills/intake/references/decision-examples.md")).toContain("--by default-unconfirmed");
    for (const name of ["research", "intake", "spec", "design"]) {
      const text = read(`skills/${name}/SKILL.md`);
      expect(Buffer.byteLength(text), name).toBeLessThan(20480);
      expect(text.split("\n").length, name).toBeLessThan(500);
    }
  });
});
