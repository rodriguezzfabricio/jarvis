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
  /** Phrases that must not appear anywhere in the prose (case-insensitive): contracts that were replaced. */
  forbidden?: string[];
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
      // The search step itself (decision 5 step 1): every place an existing option can come from.
      { section: "Build-vs-buy spike", phrase: "**Search, in parallel:**" },
      { section: "Build-vs-buy spike", phrase: "the existing repo and its dependencies" },
      { section: "Build-vs-buy spike", phrase: "package registries" },
      { section: "Build-vs-buy spike", phrase: "GitHub topics and curated lists" },
      { section: "Build-vs-buy spike", phrase: "vendor APIs, with pricing pages read live" },
      { section: "Build-vs-buy spike", phrase: "MCP servers and existing skills" },
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
      { section: "Inputs", phrase: "jarvis taste save" }, // decision 39: sessions can't write the global memory
      { section: "Write the questions", phrase: "topic `scope`" }, // decision 83 topics: a register conflict is scope
      { section: "Send the round", phrase: "`.jarvis/mockups/`" }, // architecture §3.5: mockups are throwaway views
      { section: "Take the answers", phrase: "the spec skill" },
      // Decision 86: bounded waiting and one submission contract.
      { section: "Send the round", phrase: "decision 86" },
      { section: "Take the answers", phrase: "`jarvis intake answers <n> --wait 540`" },
      { section: "Take the answers", phrase: "at most twice" },
      { section: "Take the answers", phrase: "continue with whatever it returns" },
      { section: "Take the answers", phrase: "listed ids are overrides" },
      { section: "Take the answers", phrase: "every unlisted question takes its default as accepted" },
      { section: "Take the answers", phrase: "\"Not counted\"" },
      { section: "Take the answers", phrase: "\"Use defaults\" for the whole round" },
      { section: "Take the answers", phrase: "never a partial answer" },
      { section: "Take the answers", phrase: "all unanswered questions become \"unconfirmed\" defaults" },
    ],
    forbidden: [
      "call it again", // repeated polling (decision 86)
      "answers to the ordinary product questions it names", // phone free text is a steer, never an answer
      "answer any subset", // a submission is complete: there is no partial reply
    ],
  },
  spec: {
    headings: ["When to use", "Inputs", "Write the spec", "Versions", "Check with a fresh reader", "Confirm", "Hand off", "Gotchas"],
    phrases: [
      { section: "When to use", phrase: "Tier 0 never gets a spec" }, // decision 37
      { section: "When to use", phrase: "short spec" }, // tier 1 (decision 37)
      { section: "Inputs", phrase: "the intake record" },
      { section: "Write the spec", phrase: "`docs/spec/vN.md`" }, // decision 9
      { section: "Write the spec", phrase: "`templates/spec.md`" },
      // Decision 83's grammar, line by line.
      { section: "Write the spec", phrase: "`---`, `spec: N`, `date: YYYY-MM-DD`, `status: draft`, `supersedes: none` or `supersedes: N-1`, `---`" },
      { section: "Write the spec", phrase: "`# Spec vN`" },
      { section: "Write the spec", phrase: "Goals, Non-goals, User stories, Acceptance criteria, Assumptions, Open questions" },
      { section: "Write the spec", phrase: "no other `##` headings" },
      { section: "Write the spec", phrase: "`- **S1 (P1):** As …`" },
      { section: "Write the spec", phrase: "in priority order" },
      { section: "Write the spec", phrase: "`- **AC1 (S1):** WHEN … THE SYSTEM SHALL …`" }, // EARS (decision 9)
      { section: "Write the spec", phrase: "at least one per story" },
      { section: "Write the spec", phrase: "`- **A1 [fixed]:** …`" },
      { section: "Write the spec", phrase: "`[delegated]`" },
      { section: "Write the spec", phrase: "say `None.`" },
      { section: "Write the spec", phrase: "never empty" }, // stories and criteria
      { section: "Write the spec", phrase: "the first-value budget" }, // decision 55
      { section: "Write the spec", phrase: "empty, loading, error and offline" }, // decision 53
      { section: "Write the spec", phrase: "Non-goals" },
      { section: "Write the spec", phrase: "jarvis spec check" }, // lane 3's checker
      { section: "Write the spec", phrase: "Never edit `docs/decisions.md` directly" }, // decision 83
      { section: "Write the spec", phrase: "jarvis decide" },
      { section: "Versions", phrase: "supersedes its immediate predecessor" }, // decision 83
      { section: "Versions", phrase: "Never edit a version once it's confirmed or unconfirmed" }, // tasks depend on it (decision 9)
      { section: "Versions", phrase: "keeps its ID" }, // the runner diffs versions by ID (decision 40)
      { section: "Versions", phrase: "never reused" },
      { section: "Versions", phrase: "decision 40" },
      { section: "Check with a fresh reader", phrase: "fresh context" }, // decision 9
      { section: "Check with a fresh reader", phrase: "spec-reader" }, // architecture §3.1
      { section: "Check with a fresh reader", phrase: "never the intake conversation" },
      { section: "Check with a fresh reader", phrase: "No second round of questions" }, // decision 8
      { section: "Confirm", phrase: "here's what I'm building, and what I'm not" }, // decision 9
      { section: "Confirm", phrase: "jarvis intake send" }, // decision 83
      { section: "Confirm", phrase: "jarvis intake answers" },
      { section: "Confirm", phrase: "`status: confirmed`" },
      { section: "Confirm", phrase: "`status: unconfirmed`" }, // decision 10
      { section: "Confirm", phrase: "top of the morning report" },
      { section: "Confirm", phrase: "Never run your own timer" },
      { section: "Confirm", phrase: "as **plain text**" },
      { section: "Hand off", phrase: "the design skill" },
      { section: "Gotchas", phrase: "`docs/spec/`" },
      // Decision 86: one confirmation, at the initial hand-off; bounded waiting.
      { section: "When to use", phrase: "never another confirmation round" },
      { section: "When to use", phrase: "blocked state" }, // decision 40
      { section: "Confirm", phrase: "Confirmation happens once, at the initial hand-off" },
      { section: "Confirm", phrase: "`jarvis intake answers <n> --wait 540`" },
      { section: "Confirm", phrase: "at most twice" },
    ],
    forbidden: ["call it again", "calling it again"],
  },
  design: {
    headings: [
      "When to use",
      "Inputs",
      "An existing design system",
      "Draft three directions",
      "Make the mockups",
      "The AI-tells list",
      "After the pick",
      "Checks that code runs",
      "The UX checklist",
      "Who judges design",
      "Gotchas",
    ],
    phrases: [
      { section: "When to use", phrase: "Backend-only work never" }, // architecture §2
      { section: "When to use", phrase: "a new kind of screen" },
      { section: "When to use", phrase: "never asks about direction or makes mockups" }, // a UI bug runs checks only
      { section: "Inputs", phrase: "`PRODUCT.md`" }, // decision 51
      { section: "Inputs", phrase: "taste profile" }, // decision 39
      { section: "Inputs", phrase: "product research" }, // decision 52 step 2
      { section: "An existing design system", phrase: "write `DESIGN.md` from the code" }, // decision 51
      { section: "An existing design system", phrase: "Taste decision" },
      { section: "An existing design system", phrase: "no directions and no mockups" },
      { section: "Draft three directions", phrase: "Ground it in the subject" }, // decision 52
      { section: "Draft three directions", phrase: "3–5 real products" },
      { section: "Draft three directions", phrase: "4–6 named colors" },
      { section: "Draft three directions", phrase: "layout variance, motion and density" },
      { section: "Draft three directions", phrase: "layout, flow and information hierarchy, not just color" },
      { section: "Draft three directions", phrase: "Self-check against defaults" },
      { section: "Draft three directions", phrase: "what changed" },
      { section: "Make the mockups", phrase: "`.jarvis/mockups/`" },
      { section: "Make the mockups", phrase: "real wording" },
      { section: "Make the mockups", phrase: "made-up sample data" },
      { section: "Make the mockups", phrase: "side by side" },
      { section: "Make the mockups", phrase: "The default is chosen by fit, not by looks" }, // decision 56
      { section: "Make the mockups", phrase: "In away mode, the default direction is built first" }, // decisions 39, 52
      { section: "The AI-tells list", phrase: "unless the brief asks for it" }, // decision 53
      { section: "The AI-tells list", phrase: "Inter, Roboto, Arial" },
      { section: "The AI-tells list", phrase: "purple" },
      { section: "The AI-tells list", phrase: "SaaS card kit" },
      { section: "The AI-tells list", phrase: "Emoji as icons" },
      { section: "The AI-tells list", phrase: "Welcome to your dashboard" },
      { section: "The AI-tells list", phrase: "Only the happy path" },
      { section: "The AI-tells list", phrase: "cream background with a serif and a terracotta accent" },
      { section: "After the pick", phrase: "Google's DESIGN.md format" }, // decision 51
      { section: "After the pick", phrase: "`templates/DESIGN.md`" },
      { section: "After the pick", phrase: "`--*: initial`" }, // Tailwind v4 theme reset
      { section: "After the pick", phrase: "never edited by hand" },
      { section: "After the pick", phrase: "already recorded by intake" }, // the pick is recorded once
      { section: "After the pick", phrase: "jarvis decide" }, // decision 83
      { section: "Checks that code runs", phrase: "jarvis gate design" }, // decisions 49, 54
      { section: "Checks that code runs", phrase: "AI-tells scan" },
      { section: "Checks that code runs", phrase: "off-palette" },
      { section: "Checks that code runs", phrase: "zero serious" },
      { section: "Checks that code runs", phrase: "screenshot baselines" },
      { section: "Checks that code runs", phrase: "\"Submit\"" },
      { section: "Checks that code runs", phrase: "never counts as evidence" }, // decision 49
      { section: "The UX checklist", phrase: "One primary action per screen" }, // decision 55
      { section: "The UX checklist", phrase: "first-value budget" },
      { section: "The UX checklist", phrase: "No tours on launch" },
      { section: "The UX checklist", phrase: "two levels deep" },
      { section: "The UX checklist", phrase: "\"(optional)\"" },
      { section: "The UX checklist", phrase: "400 ms" },
      { section: "The UX checklist", phrase: "WCAG 2.2 AA" },
      { section: "Who judges design", phrase: "Code first" }, // decision 56
      { section: "Who judges design", phrase: "fresh context" },
      { section: "Who judges design", phrase: "does this follow our principles?" },
      { section: "Who judges design", phrase: "never picks the better of two designs" },
      { section: "Who judges design", phrase: "At most 3 design revision rounds per screen" },
      { section: "Who judges design", phrase: "best-rated round" },
      { section: "Who judges design", phrase: "negative control" },
      // An existing design system keeps what it has; the bans and checks cover what's new.
      { section: "An existing design system", phrase: "Inherited choices are preserved" },
      { section: "An existing design system", phrase: "the changed UI" },
      { section: "The AI-tells list", phrase: "apply to new design only" },
      { section: "Checks that code runs", phrase: "the changed UI" },
    ],
  },
};

function readSkill(name: string): string {
  return readFileSync(`${skillsDir}${name}/SKILL.md`, "utf8");
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
/** A fenced code block, also when indented under a list item. Group 2 is its content. */
const FENCE = /^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

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
  return text.replace(FRONTMATTER, "").replace(FENCE, "");
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

// Skills whose rules live in their own tests: skills-build.test.ts (build, debug), skills-architect.test.ts.
const checkedElsewhere = ["build", "debug", "architect"];

describe("skills folder", () => {
  it("has rules here for every skill, so none skips these checks", () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.sort()).toEqual([...Object.keys(skills), ...checkedElsewhere].sort());
  });

  it("keeps the descriptions within decision 30's total budget", () => {
    const total = [...Object.keys(skills), ...checkedElsewhere].reduce(
      (n, name) => n + (frontmatter(readSkill(name))?.get("description")?.length ?? 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_DESCRIPTION_CHARS);
  });
});

// Decision 85: the flags `jarvis decide` accepts, and the values each one takes.
const DECIDE_FLAGS = ["by", "class", "source", "why", "alternatives", "depends-on", "reversibility", "supersedes", "reason"];
const DECIDE_BY = ["user", "default-accepted", "default-unconfirmed", "jarvis"];
const DECIDE_CLASS = ["mechanical", "taste", "challenge"];

/** Every `jarvis decide …` with arguments: inline code in the prose, and lines in fenced blocks. A bare `jarvis decide` is a reference. */
function decideCalls(text: string): string[] {
  const inline = [...prose(text).matchAll(/`(jarvis decide\b[^`]*)`/g)].map((m) => m[1]!.trim());
  const fenced = [...text.matchAll(FENCE)].flatMap((m) =>
    m[2]!.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("jarvis decide")),
  );
  return [...inline, ...fenced].filter((c) => c !== "jarvis decide");
}

/** Parses `jarvis decide --flag value … "<decision>"`; every flag takes one value. */
function parseDecide(call: string): { flags: Map<string, string>; positional: string[]; problems: string[] } {
  const tokens = call.replace(/^jarvis decide/, "").match(/"[^"]*"|\S+/g) ?? [];
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const problems: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("--")) { positional.push(t); continue; }
    const name = t.slice(2);
    const value = tokens[i + 1];
    if (!DECIDE_FLAGS.includes(name)) problems.push(`unknown flag --${name}`);
    if (value === undefined || value.startsWith("--")) problems.push(`--${name} has no value`);
    else { flags.set(name, value.replace(/^"(.*)"$/, "$1")); i++; }
  }
  return { flags, positional, problems };
}

describe("jarvis decide calls in every skill (decision 85)", () => {
  const names = Object.keys(skills);

  it.each(names)("%s: every call has valid --by and --class values, --why, a repo-relative --source and a decision", (name) => {
    for (const call of decideCalls(readSkill(name))) {
      const { flags, positional, problems } = parseDecide(call);
      expect(problems, call).toEqual([]);
      for (const by of (flags.get("by") ?? "").split("|")) expect(DECIDE_BY, `${call}: --by ${by}`).toContain(by);
      for (const c of (flags.get("class") ?? "").split("|")) expect(DECIDE_CLASS, `${call}: --class ${c}`).toContain(c);
      expect(flags.get("why")?.trim(), `${call}: --why`).toBeTruthy();
      const source = flags.get("source") ?? "";
      expect(source, `${call}: --source`).toMatch(/^[^/\s]/);
      expect(source, `${call}: --source`).not.toContain("..");
      expect(positional.length, `${call}: the decision text`).toBeGreaterThan(0);
      if (flags.get("class")!.split("|").includes("taste")) expect(flags.has("depends-on"), `${call}: --depends-on for Taste`).toBe(true);
      if (flags.get("by")!.split("|").includes("jarvis")) expect(flags.has("alternatives"), `${call}: --alternatives`).toBe(true);
      if (flags.has("supersedes")) expect(flags.has("reason"), `${call}: --reason`).toBe(true);
    }
  });

  it.each(["intake", "spec", "design"])("%s shows at least one complete call", (name) => {
    expect(decideCalls(readSkill(name)).length).toBeGreaterThan(0);
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
    for (const m of round.mockups as unknown[]) expect(String(m)).toMatch(/^\.jarvis\/mockups\//);
    expect(sectionBody(text, "Send the round")).toContain(
      "`topic` is one of scope, security, privacy, legal, ux, technical or design",
    );
  });
});

describe("spec confirmation round (decisions 9, 10, 83)", () => {
  it("reuses the intake round shape with exactly one question, defaulting to build as written", () => {
    const text = readSkill("spec");
    const start = text.indexOf("\n## Confirm\n");
    expect(start).toBeGreaterThan(0);
    const fence = /^\s*```json\n([\s\S]*?)^\s*```/m.exec(text.slice(start));
    expect(fence, "a json example in Confirm").not.toBeNull();
    const round = JSON.parse(fence![1]!) as Record<string, unknown>;
    expect(Object.keys(round).sort()).toEqual(["mockups", "questions", "round", "spec", "summary"]);
    expect(round.spec).toMatch(/^docs\/spec\/v\d+\.md$/);
    const questions = round.questions as Record<string, unknown>[];
    expect(questions).toHaveLength(1);
    const q = questions[0]!;
    expect(Object.keys(q).sort()).toEqual(["alternatives", "default", "id", "question", "topic", "why"]);
    expect(q.topic).toBe("scope");
    expect((q.default as { answer: string }).answer.toLowerCase()).toContain("build");
    expect(round.mockups).toEqual([]);
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

  it("drops the contracts that were replaced", () => {
    const text = prose(readSkill(name)).toLowerCase();
    for (const phrase of rules.forbidden ?? []) expect(text, phrase).not.toContain(phrase.toLowerCase());
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
