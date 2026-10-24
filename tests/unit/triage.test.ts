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

  it("reads the override from the first word, as typed after /jarvis", () => {
    expect(leadingOverride("fix the login")).toBe("fix");
    expect(leadingOverride("  Feature: dark mode toggle")).toBe("feature");
    expect(leadingOverride("ASK why the gate failed")).toBe("ask");
    expect(leadingOverride("build me a habit tracker")).toBe("build");
    for (const s of ["fixture loading is slow", "fix", "fix:", "builders page", "please fix the login", "rebuild the index"]) {
      expect(leadingOverride(s), s).toBeUndefined();
    }
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

  it("several sentences, a risky area or several modules make it tier 1, never 2", () => {
    expect(run("Login is broken. Users see a blank page after the password step.").tier).toBe(1);
    expect(run("The date label is wrong. It shows yesterday instead of today.").tier).toBe(1);
    expect(signal(run("The date label is wrong. It shows yesterday instead of today."), "one-sentence")).toBeUndefined();
    expect(run("The password reset email is broken").tier).toBe(1);
    expect(run("The date label is wrong", { touches: ["web/a.ts", "api/b.go", "worker/c.ts"] }).tier).toBe(1);
    expect(signal(run("The date label is wrong", { touches: ["web/a.ts", "api/b.go", "worker/c.ts"] }), "several-modules")).toBeDefined();
    expect(run("The date label is wrong", { touches: ["web/a.ts", "web/b.ts"] }).tier).toBe(0);
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

  it("the model's tier only raises, within the type's range; code signals are a floor", () => {
    expect(run("Add a CSV export", { judgment: { tier: 2 } }).tier).toBe(2);
    expect(signal(run("Add a CSV export", { judgment: { tier: 2 } }), "tier-raised")).toBeDefined();
    expect(run("Add Google login", { judgment: { tier: 1 } }).tier).toBe(2);
    expect(run(TASK5, { judgment: { tier: 2 } }).tier).toBe(1);
    expect(signal(run(TASK5, { judgment: { tier: 2 } }), "tier-clamped")).toBeDefined();
    expect(run("Add a CSV export", { judgment: { tier: 0 } }).tier).toBe(1);
    expect(run("Rename the ledger module", { judgment: { tier: 2 } }).tier).toBe(1);
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

  it("golden task 7 is onboarding: decision archaeology runs too", () => {
    const t = run(TASK7);
    expect(t.type).toBe("question");
    expect(t.onboarding).toBe(true);
    expect(t.label).toBe("Onboarding");
    expect(ids(t)).toEqual(["read-only-research", "answer", "decision-archaeology"]);
    expect(signal(t, "onboarding-words")).toBeDefined();
    expect(run("Explain the ledger", { judgment: { type: "question", onboarding: true } }).onboarding).toBe(true);
  });

  it("a release runs the manifest, rehearsals, the broker-gated deploy and a smoke test, and never builds", () => {
    const t = run("Deploy the preview to production");
    expect(t.type).toBe("release");
    expect(t.tier).toBeNull();
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

  it("no step that runs is also listed as never running; steps name a known skill at its stage", () => {
    for (const i of inputs) {
      const t = triage(i);
      for (const s of t.steps) {
        expect(t.never, `${t.type} ${s.id}`).not.toContain(s.id);
        if (s.skill !== null) expect(SKILL_STAGES[s.skill], s.skill).toBe(s.stage);
      }
      if (t.never.includes("mockups")) expect(t.mockups).toBe(false);
      if (t.type === "question") expect(t.steps.some((s) => s.by === "runner")).toBe(false);
      if (t.handoff === "after-spec") expect(ids(t)).toContain("spec");
      expect(t.signals.length, t.type).toBeGreaterThan(0);
      expect(t.headline).toContain(t.label);
    }
  });

  it("every session step comes before every runner step: the hand-off is one line", () => {
    for (const i of inputs) {
      const by = triage(i).steps.map((s) => s.by);
      expect(by.join(" ")).toMatch(/^(session ?)*(runner ?)*$/);
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
    const program = new Command().exitOverride();
    register(program);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    const err = vi.spyOn(console, "error").mockImplementation((m: unknown) => void lines.push(String(m)));
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["triage", ...args], { from: "user" });
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

  it("reads a leading override word unless --literal says it's part of the sentence", async () => {
    const d = dir("src/");
    expect(JSON.parse((await cli(["--json", "--repo", d, "fix", "the export"])).out).type).toBe("bug");
    const word = JSON.parse((await cli(["--json", "--repo", d, "feature flags are broken"])).out);
    expect([word.type, word.decidedBy]).toEqual(["feature", "override"]);
    expect(JSON.parse((await cli(["--json", "--repo", d, "build", "a CSV export"])).out).type).toBe("new-product");
    expect(JSON.parse((await cli(["--json", "--repo", d, "--literal", "feature flags are broken"])).out).type).toBe("bug");
    const lit = JSON.parse((await cli(["--json", "--repo", d, "--literal", "ask users for their email at signup"])).out);
    expect(lit.type).toBe("feature");
    expect(lit.request).toBe("ask users for their email at signup");
    expect(JSON.parse((await cli(["--json", "--repo", d, "--override", "ask", "the ledger"])).out).type).toBe("question");
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
  });

  it("prints the headline and the signals without --json", async () => {
    const r = await cli(["--repo", dir("src/"), TASK5]);
    expect(r.out).toContain("Bug, tier 0.");
    expect(r.out).toContain("bug-words");
  });

  it("refuses an unknown judgment, tier or override with a non-zero exit", async () => {
    const d = dir("src/");
    for (const bad of [["--judgment", "sweep"], ["--judgment-tier", "3"], ["--judgment-tier", "one"], ["--override", "ship"], ["--questions", "9"], ["--questions", "two"]]) {
      const r = await cli(["--json", "--repo", d, ...bad, "x"]);
      expect(r.code, bad.join(" ")).toBe(2);
    }
    expect((await cli(["--json", "--repo", join(root, "missing"), "x"])).code).toBe(2);
  });
});
