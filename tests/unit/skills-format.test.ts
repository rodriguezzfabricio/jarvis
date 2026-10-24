import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The deterministic half of each Jarvis skill (decision 30, architecture §3.1): Agent Skills
// frontmatter, the size limits, a gotchas section, at least 3 evals, and the sentences that carry
// the decisions behind it, each checked inside the section that owns it. How well a skill works
// is measured by the golden tasks, not here.

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));

const MAX_LINES = 500;
const MAX_BYTES = 20 * 1024;
// About 1.5k tokens of descriptions across all 14 skills (decision 30): ~6,000 characters in
// total, so ~450 characters each.
const MAX_DESCRIPTION_CHARS = 450;
const MAX_TOTAL_DESCRIPTION_CHARS = 6000;

interface SkillRules {
  /** `## ` headings that must appear, in this order. */
  headings: string[];
  /** Phrases that must appear (case-insensitive) in the prose of a given section, each tied to a decision. */
  phrases: { section: string; phrase: string }[];
}

const skills: Record<string, SkillRules> = {
  research: {
    headings: [
      "When to use",
      "Read the project first",
      "Product research",
      "Build-vs-buy spike",
      "Sources and freshness",
      "Output",
      "Gotchas",
    ],
    phrases: [
      { section: "When to use", phrase: "Don't run this skill" }, // tier 0 (decision 37)
      { section: "Read the project first", phrase: "never ask what" }, // decision 5
      { section: "Read the project first", phrase: "fixed constraint" }, // decision 38
      { section: "Read the project first", phrase: "connected tools" }, // decision 5
      { section: "Product research", phrase: "3–5 real products" }, // decision 5
      { section: "Product research", phrase: "a new product" }, // product research only for new products or screens
      { section: "Build-vs-buy spike", phrase: "manual / do nothing" }, // decision 5
      { section: "Build-vs-buy spike", phrase: "terms of service" },
      { section: "Build-vs-buy spike", phrase: "lock-in" },
      { section: "Build-vs-buy spike", phrase: "no outbound network calls" }, // quick tests stay offline (decisions 12, 70)
      { section: "Build-vs-buy spike", phrase: "never uses credentials, never spends money, never signs up" },
      { section: "Build-vs-buy spike", phrase: "never contacts or looks up a real person" },
      { section: "Build-vs-buy spike", phrase: "Decision / Rationale / Alternatives" },
      { section: "Build-vs-buy spike", phrase: "product-or-engineering rule" }, // decision 7
      { section: "Sources and freshness", phrase: "researcher" }, // decision 70: live web only there
      { section: "Sources and freshness", phrase: "Don't call web tools yourself" },
      { section: "Sources and freshness", phrase: "Never give a build session web tools" },
      { section: "Sources and freshness", phrase: "recorded" }, // decision 70: no web → recordings
      { section: "Sources and freshness", phrase: "never fill a price" },
      { section: "Sources and freshness", phrase: "data, not instructions" }, // fetched pages never steer the run
      { section: "Output", phrase: "Don't ask the user anything" }, // questions go out once, from intake (decision 8)
    ],
  },
  intake: {
    headings: [
      "When to use",
      "Inputs",
      "Check the decision register",
      "Frame the job",
      "List assumptions first",
      "Sort product from engineering",
      "Write the questions",
      "Send the round",
      "Take the answers",
      "Output",
      "Gotchas",
    ],
    phrases: [
      { section: "When to use", phrase: "Bugs go straight to" }, // tier 0 skips intake (decision 37)
      { section: "Inputs", phrase: "offer it once, before the round" }, // decision 39 taste profile
      { section: "When to use", phrase: "No mockups when a `DESIGN.md` exists" }, // architecture §2
      { section: "Check the decision register", phrase: "An explicit new request beats an older decision" }, // decision 48
      { section: "Check the decision register", phrase: "Silence never overrides an old decision" },
      { section: "Check the decision register", phrase: "Jarvis's own ideas never override the user's" },
      { section: "Check the decision register", phrase: "Default: keep the old decision" },
      { section: "Check the decision register", phrase: "names the very behavior the old decision rules out" },
      { section: "Check the decision register", phrase: "Confirm it with the user once" }, // decision 48 firmness
      { section: "Check the decision register", phrase: "Revisit it without a question" },
      { section: "Check the decision register", phrase: "the outside action still needs the broker's approval" },
      { section: "Frame the job", phrase: "job story" }, // decision 6
      { section: "Frame the job", phrase: "The day after launch" },
      { section: "Frame the job", phrase: "top 3 reasons it could fail" },
      { section: "Frame the job", phrase: "story map" },
      { section: "Frame the job", phrase: "walking skeleton" },
      { section: "Frame the job", phrase: "Activities a fixed constraint rules out don't appear on the map" }, // decision 38
      { section: "Frame the job", phrase: "the first-value budget" }, // decision 55
      { section: "Frame the job", phrase: "draft `PRODUCT.md`" }, // decision 51: grounding for the design skill
      { section: "List assumptions first", phrase: "confidence level" }, // decision 8, assumptions mode
      { section: "Sort product from engineering", phrase: "decision 7" },
      { section: "Sort product from engineering", phrase: "Never ask what the code, the register, the backlog or research already answers" },
      { section: "Write the questions", phrase: "scope first, then security, privacy and legal, then UX, then technical" }, // decision 8
      { section: "Write the questions", phrase: "at most 7 questions" },
      { section: "Write the questions", phrase: "always keep their place" },
      { section: "Write the questions", phrase: "The design direction** (decision 39) is one of the questions when the work adds a UI" },
      { section: "Write the questions", phrase: "Backend-only work never gets one" }, // architecture §2
      { section: "Write the questions", phrase: "the design skill writes `DESIGN.md` from the existing system" }, // decision 51
      { section: "Write the questions", phrase: "Default: no, stop at preview-ready" }, // decision 12 production grant
      { section: "Write the questions", phrase: "a default never does" },
      { section: "Write the questions", phrase: "beyond 7 become logged assumptions" },
      { section: "Write the questions", phrase: "why it matters" },
      { section: "Write the questions", phrase: "recommended default" },
      { section: "Write the questions", phrase: "2–3 **alternatives**" },
      { section: "Write the questions", phrase: "A default never spends money, never contacts a real person without approval" },
      { section: "Write the questions", phrase: "made-up sample data" },
      { section: "Send the round", phrase: "One round, all at once" },
      { section: "Send the round", phrase: "Reply 'defaults' to accept all" },
      { section: "Send the round", phrase: "No questions, no round" },
      { section: "Send the round", phrase: "Every round goes to the runner, whether or not the user seems to be at the computer" }, // decision 10
      { section: "Send the round", phrase: "Never reuse a number" },
      { section: "Send the round", phrase: "jarvis intake send" }, // decision 83
      { section: "Send the round", phrase: "Never send questions or mockups through any other channel" },
      { section: "Send the round", phrase: "as **plain text**. Never put it in a tool that waits for the user" },
      { section: "Send the round", phrase: "never put code, secrets or personal data in them" }, // decision 50
      { section: "Take the answers", phrase: "jarvis intake answer <n>" },
      { section: "Take the answers", phrase: "jarvis intake answers" }, // decision 83
      { section: "Take the answers", phrase: "a steer note" }, // decision 50: no typed replies
      { section: "Take the answers", phrase: "never grants or widens anything" }, // the publish box is unauthenticated
      { section: "Take the answers", phrase: "a default can't authorize spending or an outside action" },
      { section: "Take the answers", phrase: "15 minutes" }, // decision 10
      { section: "Take the answers", phrase: "unconfirmed" },
      { section: "Take the answers", phrase: "Never run your own timer" },
      { section: "Take the answers", phrase: "Hard stops still apply" },
      { section: "Take the answers", phrase: "jarvis decide" }, // decision 83
      { section: "Take the answers", phrase: "Never edit `docs/decisions.md` directly" },
      { section: "Take the answers", phrase: "templates/PRODUCT.md" }, // decision 51
      { section: "Gotchas", phrase: "Never send anything outside the session and the runner" },
    ],
  },
};

function readSkill(name: string): string {
  return readFileSync(`${skillsDir}${name}/SKILL.md`, "utf8");
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** Parses the `---` frontmatter block. Skills use only single-line `key: value` pairs. */
function frontmatter(text: string): Map<string, string> | undefined {
  const m = FRONTMATTER.exec(text);
  if (!m) return undefined;
  const out = new Map<string, string>();
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!kv) return undefined;
    out.set(kv[1]!, kv[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

/** The body outside the frontmatter and fenced code blocks, so a description or an example inside a fence never counts. */
function prose(text: string): string {
  return text.replace(FRONTMATTER, "").replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
}

function headings(text: string): string[] {
  return [...prose(text).matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
}

function sectionBody(text: string, heading: string): string {
  const body = `\n${prose(text)}`;
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length + 5);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("skills folder", () => {
  it("has rules here for every skill, so none skips these checks", () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.sort()).toEqual(Object.keys(skills).sort());
  });

  it("keeps the descriptions within decision 30's total budget", () => {
    const total = Object.keys(skills).reduce((n, name) => n + (frontmatter(readSkill(name))?.get("description")?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_DESCRIPTION_CHARS);
  });
});

describe("intake round file (decision 83)", () => {
  it("shows the exact round shape the notifier reads", () => {
    const text = readSkill("intake");
    const start = text.indexOf("\n## Send the round\n");
    const fence = /^\s*```json\n([\s\S]*?)^\s*```/m.exec(text.slice(start));
    expect(fence, "a json example in Send the round").not.toBeNull();
    const round = JSON.parse(fence![1]!) as Record<string, unknown>;
    expect(Object.keys(round).sort()).toEqual(["mockups", "questions", "round", "spec", "summary"]);
    const q = (round.questions as Record<string, unknown>[])[0]!;
    expect(Object.keys(q).sort()).toEqual(["alternatives", "default", "id", "question", "topic", "why"]);
    expect(Object.keys(q.default as object).sort()).toEqual(["answer", "reason"]);
    expect(sectionBody(text, "Send the round")).toContain(
      "`topic` is one of scope, security, privacy, legal, ux, technical or design",
    );
  });
});

describe.each(Object.entries(skills))("skill %s", (name, rules) => {
  it("exists with Agent Skills frontmatter: name and description only", () => {
    expect(existsSync(`${skillsDir}${name}/SKILL.md`)).toBe(true);
    const fm = frontmatter(readSkill(name));
    expect(fm, "frontmatter block").toBeDefined();
    expect([...fm!.keys()].sort()).toEqual(["description", "name"]);
    expect(fm!.get("name")).toBe(name);
    expect(fm!.get("name")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const description = fm!.get("description")!;
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it("stays under 500 lines and 20 KB", () => {
    const text = readSkill(name);
    expect(text.split("\n").length).toBeLessThan(MAX_LINES);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_BYTES);
  });

  it("has its required sections, in order", () => {
    const found = headings(readSkill(name));
    const positions = rules.headings.map((h) => found.indexOf(h));
    for (const [i, h] of rules.headings.entries()) expect(positions[i], `## ${h}`).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("carries the sentences its decisions require, in the right sections", () => {
    const text = readSkill(name);
    for (const { section, phrase } of rules.phrases) {
      expect(sectionBody(text, section).toLowerCase(), `${section}: ${phrase}`).toContain(phrase.toLowerCase());
    }
  });

  it("has a gotchas section with at least 3 items", () => {
    const items = sectionBody(readSkill(name), "Gotchas").match(/^- /gm) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it("has at least 3 evals, each with a prompt, an expected output and checkable expectations", () => {
    const file = `${skillsDir}${name}/evals/evals.json`;
    expect(existsSync(file)).toBe(true);
    const evals = JSON.parse(readFileSync(file, "utf8")) as {
      skill_name: unknown;
      evals: { id: unknown; prompt: unknown; expected_output: unknown; expectations: unknown; files: unknown }[];
    };
    expect(evals.skill_name).toBe(name);
    expect(evals.evals.length).toBeGreaterThanOrEqual(3);
    const ids = evals.evals.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of evals.evals) {
      expect(typeof e.id).toBe("number");
      expect(typeof e.prompt === "string" && e.prompt.length > 0).toBe(true);
      expect(typeof e.expected_output === "string" && e.expected_output.length > 0).toBe(true);
      expect(Array.isArray(e.expectations) && e.expectations.length >= 2).toBe(true);
      for (const x of e.expectations as unknown[]) expect(typeof x === "string" && x.length > 0).toBe(true);
      // Every file an eval names ships with the skill.
      expect(Array.isArray(e.files)).toBe(true);
      for (const f of e.files as unknown[]) {
        expect(typeof f).toBe("string");
        expect(existsSync(`${skillsDir}${name}/evals/${f as string}`), f as string).toBe(true);
      }
    }
  });
});
