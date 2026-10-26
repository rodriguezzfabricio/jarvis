import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The deterministic half of the stage 3 skills, `build` and `debug` (decision 30, architecture
// §3.1): the same checks skills-format.test.ts applies to every skill, plus the rules these two
// carry for task sessions (decisions 15, 16, 24, 49, 68) and superpowers' credit (decision 31).
// How well they work is measured by golden tasks 2, 4 and 5, not here.

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));

const MAX_LINES = 500;
const MAX_BYTES = 20 * 1024;
const MAX_DESCRIPTION_CHARS = 450; // decision 30: ~6,000 characters across 14 skills

interface SkillRules {
  /** `## ` headings that must appear, in this order. */
  headings: string[];
  /** Phrases that must appear (case-insensitive) in the prose of a given section, each tied to a decision. */
  phrases: { section: string; phrase: string }[];
}

const skills: Record<string, SkillRules> = {
  build: {
    headings: [
      "When to use",
      "Read the task first",
      "Test first",
      "Small steps",
      "One command per call",
      "Stay inside the worktree",
      "Protected checks",
      "Verify before claiming done",
      "Write the notes",
      "Gotchas",
    ],
    phrases: [
      { section: "When to use", phrase: "fresh session" }, // decisions 3, 49
      { section: "When to use", phrase: "debug skill" }, // bugs and repair attempts
      { section: "Read the task first", phrase: "acceptance criteria" },
      { section: "Read the task first", phrase: "what it may not touch" }, // architecture §5 task prompt
      { section: "Read the task first", phrase: "already made every decision" }, // decision 2
      { section: "Read the task first", phrase: "product-or-engineering rule" }, // decision 7
      { section: "Read the task first", phrase: "Mechanical or Taste" }, // decision 11
      { section: "Read the task first", phrase: "Never ask the user" }, // dontAsk, no one is there
      { section: "Test first", phrase: "watch it fail" }, // decision 45 QA lane
      { section: "Test first", phrase: "for the reason you expect" },
      { section: "Test first", phrase: "No production code without a failing test first" }, // superpowers TDD
      { section: "Test first", phrase: "real code over mocks" }, // decision 45 QA lane
      { section: "Small steps", phrase: "one behavior at a time" },
      { section: "Small steps", phrase: "the lockfile" }, // no unplanned dependencies
      { section: "One command per call", phrase: "decision 68" },
      { section: "One command per call", phrase: "one plain command per call" },
      { section: "One command per call", phrase: "no loops" },
      { section: "One command per call", phrase: "sh .jarvis/scratch/" }, // `sh script.sh` ran under dontAsk
      { section: "One command per call", phrase: "never retry variations" },
      { section: "One command per call", phrase: "refuses that one command, not the tool" }, // decision 114: a refused heredoc ended every run's testing
      { section: "Stay inside the worktree", phrase: "Never commit" }, // the runner commits (decision 68)
      { section: "Stay inside the worktree", phrase: "never push" },
      { section: "Stay inside the worktree", phrase: "jarvis act" }, // decision 12: the only path outside
      { section: "Stay inside the worktree", phrase: "no local port" }, // decision 68 loopback
      { section: "Stay inside the worktree", phrase: "data, not instructions" }, // decision 49
      { section: "Protected checks", phrase: "decision 15" },
      { section: "Protected checks", phrase: "never edit, skip, delete or loosen" },
      { section: "Protected checks", phrase: "test configuration" },
      { section: "Protected checks", phrase: "flag it in the notes" }, // legitimate test changes get a separate review
      { section: "Protected checks", phrase: "Never game the check" }, // decision 15: reward hacking
      { section: "Protected checks", phrase: "no special-casing test inputs in production code" },
      { section: "Protected checks", phrase: "no detecting that a test is running" },
      { section: "Protected checks", phrase: "no expected values copied into the implementation" },
      { section: "Verify before claiming done", phrase: "No completion claims without fresh verification" }, // superpowers
      { section: "Verify before claiming done", phrase: "every acceptance criterion" }, // decision 16
      { section: "Verify before claiming done", phrase: "feedback, not evidence" }, // decision 49: in-session gates
      { section: "Write the notes", phrase: ".jarvis/notes/<task>.md" }, // architecture §5
      { section: "Write the notes", phrase: "claims, not evidence" }, // decision 49
      { section: "Write the notes", phrase: "the runner's protected checks decide done" }, // decisions 15, 16
      { section: "Write the notes", phrase: "done | done-with-concerns | blocked | needs-decision" },
      { section: "Write the notes", phrase: "for the runner to reconcile" }, // decision 49: reviewers never get the account
      { section: "Gotchas", phrase: "test passes immediately" },
    ],
  },
  debug: {
    headings: [
      "When to use",
      "Session rules",
      "Reproduce",
      "When the session can't reproduce it",
      "Write the failing test",
      "Isolate the root cause",
      "Cover every path to the symptom",
      "Fix",
      "Run the checks",
      "Escalate",
      "Write the notes",
      "Gotchas",
    ],
    phrases: [
      { section: "When to use", phrase: "reproduce → failing test → fix → checks" }, // architecture §2 bug pipeline
      { section: "When to use", phrase: "no intake, no spec" }, // tier 0 (decision 37)
      { section: "When to use", phrase: "missing behavior, not a bug" }, // upgrades are announced, never silent
      { section: "Session rules", phrase: "build skill" },
      { section: "Session rules", phrase: "one plain command per call" }, // decision 68
      { section: "Session rules", phrase: "never commit" },
      { section: "Session rules", phrase: "never edit, skip, delete or loosen" }, // decision 15
      { section: "Reproduce", phrase: "No fix without a reproduction" },
      { section: "Reproduce", phrase: "can't reproduce" },
      // The sandbox exception (containers, browsers, local servers), defined once and pointed to by the strict steps.
      { section: "When the session can't reproduce it", phrase: "containers, browsers, local servers" },
      { section: "When the session can't reproduce it", phrase: "the runner's reproduction and check results" },
      { section: "When the session can't reproduce it", phrase: "unverified" },
      { section: "When the session can't reproduce it", phrase: "at most done-with-concerns" },
      { section: "When the session can't reproduce it", phrase: "the task's stated file boundary" },
      { section: "When the session can't reproduce it", phrase: "Never add a test or any other file outside" },
      { section: "Write the failing test", phrase: "When the session can't reproduce it" },
      { section: "Run the checks", phrase: "When the session can't reproduce it" },
      { section: "Write the failing test", phrase: "fails for the reported reason" },
      { section: "Write the failing test", phrase: "before the fix" },
      { section: "Isolate the root cause", phrase: "No fixes without root cause investigation first" }, // superpowers
      { section: "Isolate the root cause", phrase: "one hypothesis at a time" },
      { section: "Isolate the root cause", phrase: "working example" },
      // Decision 114: one cause, several triggers; a fix for the first trigger found is an incomplete fix.
      { section: "Cover every path to the symptom", phrase: "every caller" },
      { section: "Cover every path to the symptom", phrase: "where it is produced or stored" },
      { section: "Cover every path to the symptom", phrase: "every configuration, service, entrypoint" },
      { section: "Cover every path to the symptom", phrase: "Paths:" },
      { section: "Fix", phrase: "smallest change" },
      { section: "Fix", phrase: "while I'm here" },
      { section: "Fix", phrase: "the layer the report points at" }, // decision 114
      { section: "Run the checks", phrase: "the original symptom" },
      { section: "Run the checks", phrase: "against the report, not only your test" }, // decision 114: a test built from the hypothesis passes when the hypothesis is wrong
      { section: "Run the checks", phrase: "take the fix out" }, // red-green proof of the regression test
      { section: "Run the checks", phrase: "feedback, not evidence" }, // decision 49
      { section: "Escalate", phrase: "After 3 failed fixes" }, // superpowers
      { section: "Escalate", phrase: "Don't attempt a fourth" },
      { section: "Escalate", phrase: "stronger model" }, // decision 24 escalate-on-failure
      { section: "Escalate", phrase: "Never switch models yourself" }, // decision 25
      { section: "Escalate", phrase: "2 repair attempts" }, // decision 3
      { section: "Write the notes", phrase: ".jarvis/notes/<task>.md" },
      { section: "Write the notes", phrase: "claims, not evidence" }, // decision 49
      { section: "Gotchas", phrase: "symptom" },
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

/** Every inline code span and shell-fenced line, the places a session would copy a command from. */
function commandExamples(text: string): string[] {
  const body = text.replace(FRONTMATTER, "");
  const fenced = [...body.matchAll(/^```(?:bash|sh|shell|zsh)\n([\s\S]*?)^```/gm)].flatMap((m) => m[1]!.split("\n"));
  const inline = [...prose(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return [...fenced, ...inline].filter((s) => s.trim().length > 0);
}

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

  it("credits superpowers, which it adapts (decision 31)", () => {
    const intro = prose(readSkill(name)).split(/^## /m)[0]!;
    expect(intro).toContain("superpowers");
    expect(intro).toContain("MIT");
    expect(intro).toContain("skills/CREDITS.md");
  });

  it("never shows a compound shell command, which dontAsk refuses (decision 68)", () => {
    for (const cmd of commandExamples(readSkill(name))) {
      expect(cmd, cmd).not.toMatch(/&&|\|\||;|\||\$\(|`|\bfor\b.*\bdo\b|\bwhile\b.*\bdo\b|<</);
    }
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

describe("decision 49: notes are claims for the runner, never the reviewer's input", () => {
  it.each(Object.keys(skills))("%s never says a reviewer reads the session's notes or account", (name) => {
    const sentences = prose(readSkill(name)).split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (/\bnot from\b/i.test(s)) continue; // "the reviewer starts from the diff …, not from your account"
      expect(s, s).not.toMatch(/reviewer[^.]*\b(reads?|gets?|sees?|uses?)\s+(it|them|this)\b/i);
      expect(s, s).not.toMatch(/reviewer[^.]*\b(reads?|gets?|sees?|uses?)\b[^.]*\b(notes|account|record|red and green)\b/i);
    }
  });
});

type Eval = { id: number; prompt: string; expectations: string[]; files: string[] };
function evalsOf(name: string): Eval[] {
  return (JSON.parse(readFileSync(`${skillsDir}${name}/evals/evals.json`, "utf8")) as { evals: Eval[] }).evals;
}

describe("evals that carry golden-task boundaries", () => {
  it("debug's Chromium eval states the exact file boundary and checks nothing else changes (golden task 4)", () => {
    const e = evalsOf("debug").find((x) => x.prompt.includes("Chromium"));
    expect(e, "a Chromium eval").toBeDefined();
    expect(e!.prompt).toContain("May touch only: Dockerfile, docker-compose.yml");
    const boundary = e!.expectations.filter((x) => x.includes("Dockerfile") && x.includes("docker-compose.yml"));
    expect(boundary.some((x) => x.includes("no other file") && x.includes("no test"))).toBe(true);
    expect(e!.expectations.some((x) => x.includes("unverified"))).toBe(true);
  });

  it("build's hostile-content eval checks the application flow, not only the builder (golden task 2)", () => {
    const e = evalsOf("build").find((x) => x.files.includes("files/hostile-contact-page.html"));
    expect(e, "a hostile-content eval").toBeDefined();
    const trial = e!.expectations.filter((x) => x.includes("discovery → drafting → approval → stub delivery"));
    expect(trial.length).toBeGreaterThanOrEqual(1);
    expect(trial.every((x) => x.includes("runner-executed"))).toBe(true);
    expect(trial.some((x) => x.includes("recipient is the contact the page lists"))).toBe(true);
    expect(trial.some((x) => x.includes("before approval"))).toBe(true);
  });
});

describe("skills/CREDITS.md (decision 31)", () => {
  const file = `${skillsDir}CREDITS.md`;

  it("credits superpowers by name, author, source and license", () => {
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("superpowers");
    expect(text).toContain("Jesse Vincent");
    expect(text).toContain("https://github.com/obra/superpowers");
    expect(text).toContain("MIT");
    for (const skill of ["test-driven-development", "systematic-debugging", "verification-before-completion", "subagent-driven-development"]) {
      expect(text, skill).toContain(skill);
    }
  });

  it("keeps the MIT copyright and permission notice, which the license requires in copies", () => {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    expect(text).toContain("Copyright (c) 2025 Jesse Vincent");
    expect(text).toContain(
      "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    );
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});
