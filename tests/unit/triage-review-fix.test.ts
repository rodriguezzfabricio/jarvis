// Triage of a review (decision 126, round 3; backlog 109): a review is always a review, and triage never starts
// edits from its wording. Fixes start only on an explicit, structured opt-in outside triage (the intake answer,
// `jarvis run --plan review --fix`, the eval task's reviewFix). The request mentioning fixes is a signal only.
import { describe, expect, it } from "vitest";
import { triage, type FolderState, type Triage, type TriageInput } from "../../packages/cli/src/triage/triage.ts";
import { CODEX_PHRASINGS } from "./helpers/review-fix-phrasings.ts";

const repo: FolderState = { empty: false, designMd: false };
const run = (request: string, extra: Partial<TriageInput> = {}): Triage => triage({ request, folder: repo, ...extra });
const ids = (t: { steps: { id: string }[] }) => t.steps.map((s) => s.id);
const signal = (t: Triage, name: string) => t.signals.find((s) => s.name === name);
/** Golden task 3 as the Jarvis arm types it (tasks/03-security-review/prompt.md). */
const TASK3 = "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems.";

describe("triage: a review never gets fixes from its wording (decision 126)", () => {
  it("golden task 3: a review whose one step writes REVIEW.md; the fixes wait for an explicit opt-in", () => {
    const t = run(TASK3);
    expect(t.type).toBe("review");
    expect(t.decidedBy).toBe("text");
    expect(ids(t)).toEqual(["review-report"]);
    expect(t.steps[0]).toMatchObject({ skill: "review", by: "session", dispatch: true });
    expect(t.never).toEqual(["edits besides the report"]);
    expect(t.handoff).toBe("none");
    expect(t.then).toBeNull();
    expect(t.review).toEqual({ report: "REVIEW.md", security: true, fixesMentioned: true }); // outreach acts on other people (decision 37)
    expect(signal(t, "fixes-mentioned")?.detail ?? "no signal").toMatch(/explicit opt-in/);
    expect(signal(t, "report-file")?.detail).toContain("REVIEW.md");
    expect(t.headline).toMatch(/Report: REVIEW\.md\./);
    expect(t.headline).toMatch(/The request mentions fixes: they start only on an explicit opt-in\./);
  });

  it("gives every phrasing that once started fixes a plain review, whatever the model reads", () => {
    for (const request of [...CODEX_PHRASINGS, TASK3, "Review the parser. Fix anything serious.", "Review the parser, fix what you find", "Review the importer and resolve the issues."]) {
      for (const extra of [{ judgment: { type: "review" as const } }, { judgment: { type: "review" as const, then: "bug" as const } }, { judgment: { type: "review" as const, then: "refactor" as const } }]) {
        const t = run(request, extra);
        expect(t.type, request).toBe("review");
        expect(t.then, `${request} ${JSON.stringify(extra)}`).toBeNull();
        expect(t.steps.some((s) => s.by === "runner"), request).toBe(false);
      }
    }
  });

  it("a plain review stays read-only: no report, no fixes", () => {
    for (const request of ["Review the outreach code before I ship it.", "Review the fix for the login bug.", "Can you review the deploy script before we release?", "Review the changes in CHANGELOG.md", "Review the parser. Fix anything serious."]) {
      const t = run(request);
      expect(t.type, request).toBe("review");
      expect(ids(t), request).toEqual(["review"]);
      expect(t.never, request).toEqual(["any edit"]);
      expect(t.then, request).toBeNull();
      expect(t.review?.report, request).toBeNull();
    }
    expect(run("Review the outreach code before I ship it.").review?.fixesMentioned).toBe(false);
    expect(signal(run("Review the outreach code before I ship it."), "fixes-mentioned")).toBeUndefined();
  });

  it("writes the report a request names; the security lens comes from words or a tier-2 area", () => {
    const t = run("Review the auth code and write your findings to docs/auth-review.md");
    expect(ids(t)).toEqual(["review-report"]);
    expect(t.review).toEqual({ report: "docs/auth-review.md", security: true, fixesMentioned: false });
    expect(run("Review the parser, fix the bugs and put the list in `NOTES.md`.").review?.report).toBe("NOTES.md");
    expect(run("Review the parser and put the findings in REVIEW.md.").review?.security).toBe(false);
    expect(run("Do a security review of the API client and put the findings in REVIEW.md").review?.security).toBe(true);
    expect(run("Review the parser and fix it", { judgment: { report: "docs/parser.md" } }).review?.report).toBe("docs/parser.md");
    expect(() => run("Review the parser", { judgment: { report: "../parser.md" } })).toThrow();
  });

  it("never takes a report path outside the checkout, in metadata, or a file builds and agents read", () => {
    for (const bad of ["../outside.md", "/tmp/review.md", ".jarvis/review.md", ".git/review.md", "CMakeLists.txt", "requirements.txt", "CLAUDE.local.md", "AGENTS.override.md"]) {
      const t = run(`Review the parser and put the findings in ${bad}.`);
      expect(t.review?.report, bad).toBeNull();
      expect(signal(t, "report-refused")?.detail, bad).toContain(bad);
    }
  });

  it("a prohibition on editing anywhere writes no report either", () => {
    for (const request of ["Review the parser and put the findings in REVIEW.md. Do not edit anything.", "Review the parser and put the findings in REVIEW.md. Read-only.", "Review the parser and put the findings in REVIEW.md; make no changes to any files."]) {
      const t = run(request);
      expect([t.then, t.review?.report, ids(t)], request).toEqual([null, null, ["review"]]);
      expect(signal(t, "no-edit-words"), request).toBeDefined();
    }
    expect(run("Review the parser. Do not edit.", { judgment: { report: "docs/parser.md" } }).review?.report).toBeNull();
  });

  it("a question's edits keep decision 89's wording rule, and a prohibition still vetoes them", () => {
    expect(run("Explain the ledger and fix the torn-line repair.").then?.type).toBe("bug");
    expect(run("Explain the ledger and fix nothing.").then).toBeNull();
    expect(run("How does the ledger work? Don't change anything.", { judgment: { then: "refactor" } }).then).toBeNull();
  });

  it("only a review has a review block; an override never makes one", () => {
    expect(run("How does the ledger work?").review).toBeNull();
    expect(run("Chromium won't start in the container. Fix it.").review).toBeNull();
    expect(run(TASK3, { override: "ask" }).review).toBeNull();
    expect(run(TASK3, { override: "fix" }).type).toBe("bug");
  });
});
