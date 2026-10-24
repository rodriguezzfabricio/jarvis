import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OVERRIDES, SKILL_STAGES, STEPS } from "../../packages/cli/src/triage/triage.ts";

/** The /jarvis slash command (architecture §1, §2, §3.1): triage first, then the pipeline's skills, then the hand-off. */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const path = `${repoRoot}plugin/commands/jarvis.md`;
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
const lines = text.split("\n");
const end = lines.indexOf("---", 1);
const front = lines.slice(1, end);
const body = lines.slice(end + 1).join("\n");
/** The stage being built: a skill from a later stage must be marked "(stage N)" where the command names it. */
const CURRENT_STAGE = 2;
const skillRefs = [...body.matchAll(/`([a-z][a-z-]*)` skill(?: \(stage (\d+)\))?/g)].map((m) => ({ name: m[1]!, stage: m[2] === undefined ? undefined : Number(m[2]), at: m.index }));

describe("/jarvis command", () => {
  it("exists, with only description and argument-hint frontmatter", () => {
    expect(text, path).not.toBe("");
    expect(lines[0]).toBe("---");
    expect(end).toBeGreaterThan(1);
    const keys = front.map((l) => l.split(":")[0]);
    expect(new Set(keys)).toEqual(new Set(["description", "argument-hint"]));
    const description = front.find((l) => l.startsWith("description:"))!.slice("description:".length).trim();
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(250);
    const hint = front.find((l) => l.startsWith("argument-hint:"))!;
    for (const word of Object.keys(OVERRIDES)) expect(hint).toContain(word);
  });

  it("is short: the skills hold the details", () => {
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4500);
  });

  it("starts with triage on the user's words, and adds the model's judgment as input", () => {
    expect(body).toContain("$ARGUMENTS");
    expect(body).toContain('`jarvis triage --json "$ARGUMENTS"`');
    for (const flag of ["--literal", "--judgment", "--missing-behavior", "--questions", "--new-screen", "--attached-error", "--touches"]) expect(body, flag).toContain(flag);
    expect(body.indexOf("jarvis triage")).toBeLessThan(skillRefs[0]?.at ?? Infinity);
  });

  it("announces the classification and any upgrade word for word", () => {
    expect(body).toContain("`upgrade.announcement`");
    expect(body).toContain("`headline`");
    expect(body).toMatch(/never upgrade silently/i);
  });

  it("names every step the session runs, and none of the runner's as its own work", () => {
    for (const [id, step] of Object.entries(STEPS)) {
      if (step.by === "session") expect(body, id).toContain(`\`${id}\``);
    }
    expect(body).toContain("`never`");
    expect(body).toMatch(/`by` is `runner`/);
  });

  it("every skill it names exists, or is marked with the later stage that brings it", () => {
    expect(skillRefs.length).toBeGreaterThan(0);
    for (const ref of skillRefs) {
      expect(Object.keys(SKILL_STAGES), ref.name).toContain(ref.name);
      const stage = SKILL_STAGES[ref.name]!;
      if (stage <= CURRENT_STAGE) {
        expect(ref.stage, `${ref.name} is built now; don't mark it`).toBeUndefined();
        expect(existsSync(`${repoRoot}skills/${ref.name}/SKILL.md`), `skills/${ref.name}/SKILL.md`).toBe(true);
      } else {
        expect(ref.stage, `${ref.name} comes in stage ${stage}`).toBe(stage);
      }
    }
  });

  it("names the skill behind every session step, and every skill built by now exists", () => {
    const named = new Set(skillRefs.map((r) => r.name));
    for (const step of Object.values(STEPS)) if (step.by === "session" && step.skill !== null) expect([...named], step.skill).toContain(step.skill);
    for (const [skill, stage] of Object.entries(SKILL_STAGES)) {
      if (stage <= CURRENT_STAGE) expect(existsSync(`${repoRoot}skills/${skill}/SKILL.md`), `skills/${skill}/SKILL.md`).toBe(true);
    }
  });

  it("ends with the hand-off once the spec is confirmed or defaulted", () => {
    const handoff = body.indexOf("`jarvis run --detach`");
    expect(handoff).toBeGreaterThan(-1);
    expect(handoff).toBeGreaterThan(Math.max(...skillRefs.map((r) => r.at)));
    const tail = body.slice(body.indexOf("## 3."));
    for (const word of ["after-spec", "now", "none", "confirmed", "unconfirmed"]) expect(tail, word).toContain(word);
  });

  it("calls only the jarvis CLI, and only triage and run itself (the skills own the rest)", () => {
    const subs = new Set([...body.matchAll(/`jarvis ([a-z-]+)/g)].map((m) => m[1]));
    expect(subs).toEqual(new Set(["triage", "run"]));
    expect(body).not.toMatch(/`(?:claude|codex)\b/);
  });
});
