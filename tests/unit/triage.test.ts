import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/triage/command.ts";
import { readFolder } from "../../packages/cli/src/triage/folder.ts";
import {
  OVERRIDES, SKILL_STAGES, TASK_TYPES, leadingOverride, triage,
  type FolderState, type Judgment, type Triage, type TriageInput,
} from "../../packages/cli/src/triage/triage.ts";
import { shortTmp } from "../helpers.ts";

// commander is a dependency of packages/cli only, so load it from there.
const { Command } = createRequire(new URL("../../packages/cli/src/cli.ts", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const root = shortTmp("jttr-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = (...files: string[]) => {
  const d = join(root, `f${++n}`);
  mkdirSync(d);
  for (const f of files) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    if (f.endsWith("/")) mkdirSync(join(d, f), { recursive: true });
    else writeFileSync(join(d, f), "x");
  }
  return d;
};

const repo: FolderState = { empty: false, designMd: false };
const empty: FolderState = { empty: true, designMd: false };
const run = (request: string, extra: Partial<TriageInput> = {}): Triage => triage({ request, folder: repo, ...extra });
const ids = (t: Triage) => t.steps.map((s) => s.id);
const signal = (t: Triage, name: string) => t.signals.find((s) => s.name === name);

// The golden tasks' prompts (docs/02-golden-tasks.md), typed the way Fabricio types them.
const TASK1 = "I want a feature that finds the recruiter for each job I apply to, or the hiring manager if it can't find one, and reaches out to them.";
const TASK4 = "Chromium won't start in the container. Fix it.";
const TASK5 = "The citizenship filter is missing some jobs that require US citizenship.";
const TASK6 = "Show me why a job doesn't fit me, right on the job card.";
const TASK7 = "Get familiar with this repo and make it easier for agents to work in.";
const TASK11 = "Build me a habit tracker.";

describe("triage: your override always wins (architecture §2)", () => {
  const contrary: Judgment = { type: "release", tier: 2, missingBehavior: true, newScreen: true };
  for (const [word, type] of Object.entries(OVERRIDES)) {
    it(`${word} → ${type}, whatever the folder, the text, an attached error or the model's judgment`, () => {
      for (const folder of [repo, empty, { empty: false, designMd: true }]) {
        for (const request of [TASK5, TASK11, "How does the broker work?", "Deploy the preview"]) {
          const t = triage({ request, folder, override: word as keyof typeof OVERRIDES, attachedError: true, judgment: contrary });
          expect(t.type, `${word} ${request}`).toBe(type);
          expect(t.decidedBy).toBe("override");
          expect(t.upgrade).toBeNull();
          expect(signal(t, "override")?.detail).toContain(word);
          expect(t.headline).toContain(`your override: ${word}`);
          expect(t.then).toBeNull();
        }
      }
    });
  }

  it("a fix override keeps a bug a bug even when the model thinks the behavior was never specified", () => {
    const t = run(TASK5, { override: "fix", judgment: { missingBehavior: true, questions: 2 } });
    expect(t.type).toBe("bug");
    expect(t.upgrade).toBeNull();
    expect(signal(t, "missing-behavior")?.detail).toMatch(/override/);
  });

  it("an override is the first word followed by a colon (decision 89); a bare first word is prose", () => {
    expect(leadingOverride("fix: the login button")).toBe("fix");
    expect(leadingOverride("  Feature: dark mode toggle")).toBe("feature");
    expect(leadingOverride("ASK: why the gate failed")).toBe("ask");
    expect(leadingOverride("build:me a habit tracker")).toBe("build");
    for (const s of [
      "Build fails on CI", "Feature flags are broken", "Ask the API for retries", "fix the login", "build me a habit tracker",
      "fixture: loading is slow", "fix:", "fix:   ", "builders page", "please fix: the login", "rebuild: the index",
    ]) {
      expect(leadingOverride(s), s).toBeUndefined();
    }
  });

  it("override-looking prose isn't an override: 'Build fails on CI' is a bug, with no mockups or design", () => {
    for (const judgment of [undefined, { type: "bug" as const }]) {
      const t = run("Build fails on CI", judgment ? { judgment } : {});
      expect(t.type).toBe("bug");
      expect(t.decidedBy).not.toBe("override");
      expect(t.mockups).toBe(false);
      expect(ids(t)).not.toContain("design");
    }
    expect(run("Feature flags are broken").type).toBe("bug");
    expect(run("Ask the API for retries").type).not.toBe("question");
  });
});

describe("triage: an empty folder is a new product", () => {
  it("golden task 11: new product, tier 2, the full pipeline", () => {
    const t = triage({ request: TASK11, folder: empty });
    expect(t.type).toBe("new-product");
    expect(t.tier).toBe(2);
    expect(t.decidedBy).toBe("empty-folder");
    expect(ids(t)).toEqual(["research", "intake", "spec", "design", "architecture", "build-loop", "lanes", "preview-deploy", "report"]);
    expect(t.never).toEqual([]);
    expect(t.mockups).toBe(true);
    expect(t.handoff).toBe("after-spec");
    expect(signal(t, "empty-folder")).toBeDefined();
  });

  it("beats bug words, an attached error and a feature or bug judgment: there is nothing to fix or extend", () => {
    for (const judgment of [undefined, { type: "feature" as const }, { type: "bug" as const, missingBehavior: true }]) {
      const t = triage({ request: "Fix the broken login, it crashes", folder: empty, attachedError: true, ...(judgment ? { judgment } : {}) });
      expect(t.type).toBe("new-product");
      expect(t.decidedBy).toBe("empty-folder");
      expect(t.upgrade).toBeNull();
      if (judgment) expect(signal(t, "judgment-overruled")?.detail).toContain(judgment.type);
    }
  });

  it("yields to the model's judgment that it's a question (read-only, never an edit), not to question words alone", () => {
    expect(triage({ request: "What stack should a habit tracker use?", folder: empty, judgment: { type: "question" } }).type).toBe("question");
    expect(triage({ request: "What stack should a habit tracker use?", folder: empty }).type).toBe("new-product");
  });

  it("the model may call a non-empty folder a new product (a folder of notes)", () => {
    const t = run("Make this into a recipe app", { judgment: { type: "new-product" } });
    expect(t.type).toBe("new-product");
    expect(t.decidedBy).toBe("judgment");
  });
});

describe("triage: bugs never run intake, mockups, design or architecture", () => {
  it("golden task 5 is a tier-0 bug: reproduce → failing test → fix → checks → lanes → report", () => {
    const t = run(TASK5);
    expect(t.type).toBe("bug");
    expect(t.tier).toBe(0);
    expect(t.decidedBy).toBe("text");
    expect(ids(t)).toEqual(["reproduce", "failing-test", "fix", "checks", "lanes", "report"]);
    expect(t.never).toEqual(["intake", "mockups", "design", "architecture"]);
    expect(t.mockups).toBe(false);
    expect(t.handoff).toBe("now");
    expect(signal(t, "bug-words")?.detail).toContain("missing");
    expect(signal(t, "one-sentence")).toBeDefined();
  });

  it("golden task 4: a short tail like 'Fix it.' is not a second sentence", () => {
    const t = run(TASK4);
    expect(t.type).toBe("bug");
    expect(t.tier).toBe(0);
  });

  it("holds for every bug, whatever the tier, the folder or the judgment", () => {
    const cases: TriageInput[] = [
      { request: TASK5, folder: repo },
      { request: TASK4, folder: { empty: false, designMd: true } },
      { request: "Login is broken. Users see a blank page after the password step. It started yesterday.", folder: repo },
      { request: "anything", folder: repo, override: "fix", judgment: { newScreen: true, tier: 2 } },
      { request: "The settings page is wrong", folder: repo, judgment: { type: "bug", newScreen: true, tier: 1 } },
    ];
    for (const c of cases) {
      const t = triage(c);
      expect(t.type, c.request).toBe("bug");
      for (const s of ["intake", "mockups", "design", "architecture", "spec", "research"]) expect(ids(t), c.request).not.toContain(s);
      for (const s of ["intake", "mockups", "design", "architecture"]) expect(t.never, c.request).toContain(s);
      expect(t.steps.every((s) => s.by === "runner"), c.request).toBe(true);
    }
  });

  it("several sentences make it tier 1; risk makes it tier 2 (decision 89: the tier comes from risk, not the type)", () => {
    expect(run("The date label is wrong. It shows yesterday instead of today.").tier).toBe(1);
    expect(signal(run("The date label is wrong. It shows yesterday instead of today."), "one-sentence")).toBeUndefined();
    expect(run("Login is broken. Users see a blank page after the password step.").tier).toBe(2);
    expect(run("The password reset email is broken").tier).toBe(2);
    expect(run("The date label is wrong", { touches: ["web/a.ts", "api/b.go", "worker/c.ts"] }).tier).toBe(2);
    expect(signal(run("The date label is wrong", { touches: ["web/a.ts", "api/b.go", "worker/c.ts"] }), "several-modules")).toBeDefined();
    expect(run("The date label is wrong", { touches: ["web/a.ts", "web/b.ts"] }).tier).toBe(0);
    const risky = run("The password reset email is broken");
    expect(risky.type).toBe("bug");
    for (const s of ["intake", "mockups", "design", "architecture"]) expect(risky.never).toContain(s);
  });

  it("'App crashes on launch' is a bug on the crash word alone", () => {
    const t = run("App crashes on launch");
    expect(t.type).toBe("bug");
    expect(t.decidedBy).toBe("text");
    expect(signal(t, "bug-words")?.detail).toBe('"crashes"');
  });

  it("an attached error or a pasted stack trace reads as a bug, and the trace doesn't count as sentences", () => {
    const attached = run("The import page", { attachedError: true });
    expect(attached.type).toBe("bug");
    expect(signal(attached, "attached-error")).toBeDefined();
    const pasted = run("Importing a CSV does this:\nTypeError: Cannot read properties of undefined (reading 'map')\n    at parseRows (src/import/csv.ts:42:17)\n    at main (src/cli.ts:10:3)");
    expect(pasted.type).toBe("bug");
    expect(signal(pasted, "error-text")).toBeDefined();
    expect(pasted.tier).toBe(0);
    const py = run("Sync fails\nTraceback (most recent call last):\n  File \"sync.py\", line 3, in <module>\nKeyError: 'id'");
    expect(py.type).toBe("bug");
    expect(signal(py, "error-text")).toBeDefined();
    expect(signal(run("Add an error page for 404s"), "error-text")).toBeUndefined();
  });
});

describe("triage: an upgrade is announced, never silent", () => {
  it("a bug whose right behavior was never specified becomes a small feature, with §2's sentence", () => {
    const t = run(TASK5, { judgment: { missingBehavior: true, questions: 2 } });
    expect(t.type).toBe("feature");
    expect(t.tier).toBe(1);
    expect(t.upgrade).toEqual({ from: "bug", to: "feature", announcement: "This looks like missing behavior, not a bug. Treating it as a small feature: 2 questions." });
    expect(ids(t)).toContain("intake");
    expect(t.headline.startsWith(t.upgrade!.announcement)).toBe(true);
  });

  it("counts questions in the sentence, and leaves the count out when the model gave none", () => {
    expect(run(TASK5, { judgment: { missingBehavior: true, questions: 1 } }).upgrade?.announcement).toBe("This looks like missing behavior, not a bug. Treating it as a small feature: 1 question.");
    expect(run(TASK5, { judgment: { missingBehavior: true, questions: 0 } }).upgrade?.announcement).toBe("This looks like missing behavior, not a bug. Treating it as a small feature: no questions.");
    expect(run(TASK5, { judgment: { missingBehavior: true } }).upgrade?.announcement).toBe("This looks like missing behavior, not a bug. Treating it as a small feature.");
  });

  it("a tier-2 area makes it a feature, not a small one", () => {
    const t = run("The password reset email is broken", { judgment: { missingBehavior: true, questions: 3 } });
    expect(t.tier).toBe(2);
    expect(t.upgrade?.announcement).toBe("This looks like missing behavior, not a bug. Treating it as a feature: 3 questions.");
  });

  it("upgrades a bug the model reads as a bug, and a bug-worded request the model calls a feature", () => {
    expect(run("The export is off", { judgment: { type: "bug", missingBehavior: true } }).upgrade?.to).toBe("feature");
    expect(run(TASK5, { judgment: { type: "feature", missingBehavior: true } }).upgrade?.to).toBe("feature");
  });

  it("no upgrade and no announcement when nothing read as a bug", () => {
    const t = run("Add dark mode to the settings page", { judgment: { missingBehavior: true } });
    expect(t.type).toBe("feature");
    expect(t.upgrade).toBeNull();
    expect(run(TASK5).upgrade).toBeNull();
  });
});

describe("triage: features", () => {
  it("golden task 1 is a tier-2 feature: register check → spike → intake → spec → build loop → lanes → report", () => {
    const t = run(TASK1);
    expect(t.type).toBe("feature");
    expect(t.tier).toBe(2);
    expect(ids(t)).toEqual(["register-check", "spike", "intake", "spec", "build-loop", "lanes", "report"]);
    expect(t.never).toEqual(["mockups", "design direction"]);
    expect(t.mockups).toBe(false);
    expect(t.handoff).toBe("after-spec");
    expect(signal(t, "tier2-area")?.detail).toMatch(/acts on other people/);
  });

  it("golden task 6: the model's judgment beats bug words in the text", () => {
    expect(run(TASK6).type).toBe("bug");
    const t = run(TASK6, { judgment: { type: "feature" } });
    expect(t.type).toBe("feature");
    expect(t.tier).toBe(1);
    expect(t.decidedBy).toBe("judgment");
    expect(t.upgrade).toBeNull();
    expect(signal(t, "judgment")?.detail).toContain("feature");
  });

  it("a new kind of screen with no DESIGN.md runs design and mockups; with a DESIGN.md it never does", () => {
    const fresh = run("Add a weekly report screen", { judgment: { type: "feature", newScreen: true } });
    expect(ids(fresh)).toEqual(["register-check", "spike", "intake", "spec", "design", "build-loop", "lanes", "report"]);
    expect(fresh.never).toEqual([]);
    expect(fresh.mockups).toBe(true);
    const designed = triage({ request: "Add a weekly report screen", folder: { empty: false, designMd: true }, judgment: { type: "feature", newScreen: true } });
    expect(ids(designed)).not.toContain("design");
    expect(designed.never).toEqual(["mockups", "design direction"]);
    expect(designed.mockups).toBe(false);
    expect(signal(designed, "design-md")).toBeDefined();
    expect(run("Add a weekly report screen").mockups).toBe(false);
  });

  it("the model's tier only raises; code's risk signals are a floor; the type never caps it (decision 89)", () => {
    expect(run("Add a CSV export", { judgment: { tier: 2 } }).tier).toBe(2);
    expect(signal(run("Add a CSV export", { judgment: { tier: 2 } }), "tier-raised")).toBeDefined();
    expect(run("Add Google login", { judgment: { tier: 1 } }).tier).toBe(2);
    expect(run(TASK5, { judgment: { tier: 2 } }).tier).toBe(2);
    expect(run(TASK5, { judgment: { tier: 1 } }).tier).toBe(1);
    expect(run("Add a CSV export", { judgment: { tier: 0 } }).tier).toBe(1);
    expect(run("Rename the ledger module", { judgment: { tier: 2 } }).tier).toBe(2);
    expect(run("The date label is wrong. It shows yesterday instead of today.", { judgment: { tier: 0 } }).tier).toBe(1);
  });

  it("'Refactor auth across the app' is a tier-2 refactor: risk sets the tier, the type sets what never runs", () => {
    for (const judgment of [undefined, { tier: 2 as const }, { type: "refactor" as const, tier: 2 as const }]) {
      const t = run("Refactor auth across the app", judgment ? { judgment } : {});
      expect(t.type).toBe("refactor");
      expect(t.tier).toBe(2);
      expect(t.never).toEqual(["intake", "design"]);
    }
    expect(run("Rename the ledger module").tier).toBe(1);
  });

  it("golden task 9: a new platform gets the design stage even when DESIGN.md covers another one", () => {
    const task9 = "I want to approve my outreach drafts from my phone.";
    const designed: FolderState = { empty: false, designMd: true };
    const phone = triage({ request: task9, folder: designed, judgment: { type: "feature", newScreen: true, newPlatform: true, platform: "ios" } });
    expect(phone.mockups).toBe(true);
    expect(ids(phone)).toContain("design");
    expect(phone.never).toEqual([]);
    expect(signal(phone, "new-platform")?.detail).toContain("ios");
    const same = triage({ request: task9, folder: designed, judgment: { type: "feature", newScreen: true, platform: "web" } });
    expect(same.mockups).toBe(false);
    expect(ids(same)).not.toContain("design");
  });

  it("with no keyword and no judgment, a request in an existing repo is a feature by default", () => {
    const t = run("Usage budgets per project");
    expect(t.type).toBe("feature");
    expect(t.decidedBy).toBe("default");
  });
});

describe("triage: refactors, questions and releases", () => {
  it("a refactor pins behavior first and never runs intake or design", () => {
    const t = run("Refactor the ledger into smaller modules");
    expect(t.type).toBe("refactor");
    expect(t.tier).toBe(1);
    expect(ids(t)).toEqual(["pin-behavior", "small-steps", "same-tests-pass", "architecture-lane"]);
    expect(t.never).toEqual(["intake", "design"]);
    expect(t.handoff).toBe("now");
  });

  it("a question is read-only: research, an answer with citations, no hand-off", () => {
    const t = run("How does the broker check approvals?");
    expect(t.type).toBe("question");
    expect(t.tier).toBeNull();
    expect(ids(t)).toEqual(["read-only-research", "answer"]);
    expect(t.never).toEqual(["any edit"]);
    expect(t.handoff).toBe("none");
    expect(t.steps.every((s) => s.by === "session")).toBe(true);
    expect(run("Can you add a logout button?").type).toBe("feature");
  });

  it("golden task 7 is onboarding with edits: read-only archaeology first, then a pipeline for the edits (decision 89)", () => {
    const t = run(TASK7);
    expect(t.type).toBe("question");
    expect(t.onboarding).toBe(true);
    expect(t.label).toBe("Onboarding");
    expect(ids(t)).toEqual(["read-only-research", "answer", "decision-archaeology"]);
    expect(t.never).toEqual(["any edit"]);
    expect(signal(t, "onboarding-words")).toBeDefined();
    expect(signal(t, "edit-words")?.detail).toContain("make");
    expect(t.then?.type).toBe("refactor");
    expect(t.then?.steps.map((s) => s.id)).toEqual(["pin-behavior", "small-steps", "same-tests-pass", "architecture-lane"]);
    expect(t.then?.never).toEqual(["intake", "design"]);
    expect(t.then?.handoff).toBe("now");
    expect(t.headline).toMatch(/Then: Refactor, tier 1/);
    expect(run("Explain the ledger", { judgment: { type: "question", onboarding: true } }).onboarding).toBe(true);
  });

  it("the model's judgment picks the edits' pipeline, or says there are none", () => {
    expect(run(TASK7, { judgment: { then: "feature" } }).then?.type).toBe("feature");
    expect(run(TASK7, { judgment: { then: "none" } }).then).toBeNull();
    expect(run(TASK7, { override: "ask" }).then).toBeNull();
    expect(run("How does the ledger work?", { judgment: { then: "refactor" } }).then?.type).toBe("refactor");
    expect(run("How does the broker check approvals?").then).toBeNull();
    expect(run("How does the ledger work, and then fix the torn-line repair?").then?.type).toBe("bug");
  });

  it("golden task 3 is a review, not a release: read-only findings, no edits", () => {
    const t = run("Review the outreach code before I ship it.");
    expect(t.type).toBe("review");
    expect(t.decidedBy).toBe("text");
    expect(ids(t)).toEqual(["review"]);
    expect(t.never).toEqual(["any edit"]);
    expect(t.handoff).toBe("none");
    expect(t.tier).toBe(2);
    expect(signal(t, "review-words")).toBeDefined();
    expect(run("Can you review the deploy script before we release?").type).toBe("review");
    expect(run("Ship it once the review passes").type).not.toBe("review");
  });

  it("a release runs the manifest, rehearsals, the broker-gated deploy and a smoke test, and never builds", () => {
    const t = run("Deploy the preview to production");
    expect(t.type).toBe("release");
    expect(t.tier).toBe(2);
    expect(ids(t)).toEqual(["release-manifest", "rehearsals", "broker-deploy", "smoke-test"]);
    expect(t.never).toEqual(["building"]);
    expect(t.handoff).toBe("now");
    expect(run("The deploy script is broken").type).toBe("bug");
  });
});

describe("triage: the result is consistent", () => {
  const inputs: TriageInput[] = [];
  for (const type of TASK_TYPES) for (const folder of [repo, empty, { empty: false, designMd: true }]) {
    for (const newScreen of [true, false]) inputs.push({ request: TASK1, folder, judgment: { type, newScreen, onboarding: newScreen } });
  }
  for (const o of Object.keys(OVERRIDES)) inputs.push({ request: TASK6, folder: repo, override: o as keyof typeof OVERRIDES });
  for (const then of ["feature", "refactor", "bug", "none"] as const) inputs.push({ request: TASK7, folder: repo, judgment: { then, newScreen: true, newPlatform: true } });
  inputs.push({ request: "Review the outreach code before I ship it.", folder: repo });
  // Golden task 3 as the Jarvis arm types it: a review that asks for fixes (decision 126).
  inputs.push({ request: "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems.", folder: repo });
  inputs.push({ request: "Review the parser and write the findings to docs/parser-review.md", folder: repo });
  const pipelines = (t: Triage) => (t.then ? [t, t.then] : [t]);

  it("no step that runs is also listed as never running; steps name a known skill at its stage", () => {
    for (const i of inputs) {
      const t = triage(i);
      for (const p of pipelines(t)) {
        for (const s of p.steps) {
          expect(p.never, `${p.type} ${s.id}`).not.toContain(s.id);
          if (s.skill !== null) expect(SKILL_STAGES[s.skill], s.skill).toBe(s.stage);
        }
        if (p.never.includes("mockups")) expect(p.mockups).toBe(false);
        if (p.type === "question" || p.type === "review") expect(p.steps.some((s) => s.by === "runner")).toBe(false);
        if (p.handoff === "after-spec") expect(p.steps.map((s) => s.id)).toContain("spec");
        if (p.type === "bug") for (const s of ["intake", "mockups", "design"]) expect(p.never).toContain(s);
        expect(t.headline).toContain(p.label);
      }
      if (t.then) expect(["question", "review"]).toContain(t.type);
      if (t.type === "review" && t.then) expect(t.then.type).toBe("bug"); // a review's fixes are bug work (decision 126)
      expect(t.review === null).toBe(t.type !== "review");
      expect(t.signals.length, t.type).toBeGreaterThan(0);
    }
  });

  it("every session step comes before every runner step: the hand-off is one line", () => {
    for (const i of inputs) {
      for (const p of pipelines(triage(i))) expect(p.steps.map((s) => s.by).join(" ")).toMatch(/^(session ?)*(runner ?)*$/);
    }
  });

  it("refuses input it can't classify honestly", () => {
    expect(() => triage({ request: "  ", folder: repo })).toThrow();
    expect(() => triage({ request: "x", folder: repo, override: "ship" as never })).toThrow();
    expect(() => triage({ request: "x", folder: repo, judgment: { type: "sweep" as never } })).toThrow();
    expect(() => triage({ request: "x", folder: repo, judgment: { tier: 3 as never } })).toThrow();
    expect(() => triage({ request: "x", folder: repo, judgment: { questions: 8 } })).toThrow();
  });
});

describe("folder state", () => {
  it("a folder with only .git, .jarvis, .claude and .DS_Store is empty", () => {
    expect(readFolder(dir(".git/", ".jarvis/", ".claude/", ".DS_Store"))).toEqual({ empty: true, designMd: false });
    expect(readFolder(dir())).toEqual({ empty: true, designMd: false });
  });

  it("anything else is not empty", () => {
    expect(readFolder(dir(".git/", "README.md")).empty).toBe(false);
    expect(readFolder(dir("src/")).empty).toBe(false);
    expect(readFolder(dir(".env")).empty).toBe(false);
  });

  it("finds DESIGN.md at the root only, as a regular file", () => {
    expect(readFolder(dir("DESIGN.md")).designMd).toBe(true);
    expect(readFolder(dir("docs/DESIGN.md")).designMd).toBe(false);
    expect(readFolder(dir("DESIGN.md/")).designMd).toBe(false);
    const d = dir("x.md");
    symlinkSync(join(d, "x.md"), join(d, "DESIGN.md"));
    expect(readFolder(d).designMd).toBe(false);
  });

  it("refuses a missing folder or a file", () => {
    expect(() => readFolder(join(root, "nope"))).toThrow();
    expect(() => readFolder(join(dir("a.txt"), "a.txt"))).toThrow();
  });
});

describe("jarvis triage", () => {
  async function cli(args: string[]): Promise<{ out: string; code: number | undefined }> {
    const lines: string[] = [];
    const program = new Command().exitOverride().configureOutput({ writeErr: (s: string) => void lines.push(s), writeOut: (s: string) => void lines.push(s) });
    register(program);
    const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    const err = vi.spyOn(console, "error").mockImplementation((m: unknown) => void lines.push(String(m)));
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      try {
        await program.parseAsync(["triage", ...args], { from: "user" });
      } catch (error) {
        return { out: lines.join("\n"), code: (error as { exitCode?: number }).exitCode ?? 1 };
      }
      return { out: lines.join("\n"), code: process.exitCode as number | undefined };
    } finally {
      process.exitCode = before;
      log.mockRestore();
      err.mockRestore();
    }
  }

  it("--json classifies against the folder it's given", async () => {
    const r = await cli(["--json", "--repo", dir(".git/"), TASK11]);
    const t = JSON.parse(r.out) as Triage & { request: string; folder: FolderState };
    expect(t.type).toBe("new-product");
    expect(t.folder).toEqual({ empty: true, designMd: false });
    expect(t.request).toBe(TASK11);
    expect(r.code ?? 0).toBe(0);
  });

  it("reads an override only from a colon after the first word, or from --override", async () => {
    const d = dir("src/");
    const colon = JSON.parse((await cli(["--json", "--repo", d, "fix: the login button"])).out);
    expect([colon.type, colon.decidedBy, colon.request]).toEqual(["bug", "override", "fix: the login button"]);
    expect(JSON.parse((await cli(["--json", "--repo", d, "build:", "a CSV export"])).out).type).toBe("new-product");
    for (const prose of ["Build fails on CI", "Feature flags are broken", "Ask the API for retries"]) {
      const t = JSON.parse((await cli(["--json", "--repo", d, prose])).out);
      expect(t.decidedBy, prose).not.toBe("override");
      expect(t.mockups, prose).toBe(false);
    }
    const ci = JSON.parse((await cli(["--json", "--repo", d, "--judgment", "bug", "Build fails on CI"])).out);
    expect([ci.type, ci.mockups]).toEqual(["bug", false]);
    expect(JSON.parse((await cli(["--json", "--repo", d, "--override", "ask", "the ledger"])).out).type).toBe("question");
    expect((await cli(["--json", "--repo", d, "--literal", "x"])).code).not.toBe(0);
  });

  it("passes the model's judgment and the attachments through", async () => {
    const d = dir("src/");
    const t = JSON.parse((await cli(["--json", "--repo", d, "--judgment", "bug", "--missing-behavior", "--questions", "2", "--touches", "a/x.ts", "--touches", "b/y.ts", "--reason", "never specified", TASK5])).out) as Triage;
    expect(t.upgrade?.announcement).toBe("This looks like missing behavior, not a bug. Treating it as a small feature: 2 questions.");
    expect(signal(t, "judgment")?.detail).toContain("never specified");
    const f = JSON.parse((await cli(["--json", "--repo", d, "--judgment", "feature", "--new-screen", "--judgment-tier", "2", "Add a weekly report"])).out) as Triage;
    expect(f.tier).toBe(2);
    expect(f.mockups).toBe(true);
    expect(JSON.parse((await cli(["--json", "--repo", d, "--attached-error", "The import page"])).out).type).toBe("bug");
    const designed = dir("src/", "DESIGN.md");
    const phone = JSON.parse((await cli(["--json", "--repo", designed, "--judgment", "feature", "--new-screen", "--new-platform", "--platform", "ios", "Approve drafts from my phone"])).out) as Triage;
    expect(phone.mockups).toBe(true);
    expect(JSON.parse((await cli(["--json", "--repo", d, "--then", "feature", TASK7])).out).then.type).toBe("feature");
    // Decision 126: the model can name a review's report, never start its fixes.
    const review = JSON.parse((await cli(["--json", "--repo", d, "--report", "docs/review.md", "--then", "refactor", "Review the parser and fix it"])).out) as Triage;
    expect([review.type, review.review?.report, review.then]).toEqual(["review", "docs/review.md", null]); // the model can never start a review's fixes (round 3)
  });

  it("prints the headline and the signals without --json", async () => {
    const r = await cli(["--repo", dir("src/"), TASK5]);
    expect(r.out).toContain("Bug, tier 0.");
    expect(r.out).toContain("bug-words");
  });

  it("refuses an unknown judgment, tier or override with a non-zero exit", async () => {
    const d = dir("src/");
    for (const bad of [["--judgment", "sweep"], ["--judgment-tier", "3"], ["--judgment-tier", "one"], ["--override", "ship"], ["--questions", "9"], ["--questions", "two"], ["--then", "sweep"], ["--report", "../outside.md"], ["--report", ".jarvis/r.md"]]) {
      const r = await cli(["--json", "--repo", d, ...bad, "x"]);
      expect(r.code, bad.join(" ")).toBe(2);
    }
    expect((await cli(["--json", "--repo", join(root, "missing"), "x"])).code).toBe(2);
  });
});
