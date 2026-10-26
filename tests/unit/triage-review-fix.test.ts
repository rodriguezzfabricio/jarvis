// Triage of a review that asks for fixes (decision 126; backlog 109): it stays a review, its one step
// writes the report, and a bug pipeline follows for the confirmed findings. A plain review stays read-only.
import { describe, expect, it } from "vitest";
import { triage, type FolderState, type Triage, type TriageInput } from "../../packages/cli/src/triage/triage.ts";

const repo: FolderState = { empty: false, designMd: false };
const run = (request: string, extra: Partial<TriageInput> = {}): Triage => triage({ request, folder: repo, ...extra });
const ids = (t: { steps: { id: string }[] }) => t.steps.map((s) => s.id);
const signal = (t: Triage, name: string) => t.signals.find((s) => s.name === name);
/** Golden task 3 as the Jarvis arm types it (tasks/03-security-review/prompt.md). */
const TASK3 = "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems.";

describe("triage: a review that asks for fixes (decision 126)", () => {
  it("golden task 3: a review whose one step writes REVIEW.md, then a bug pipeline for the confirmed findings", () => {
    const t = run(TASK3);
    expect(t.type).toBe("review");
    expect(t.decidedBy).toBe("text");
    expect(ids(t)).toEqual(["review-report"]);
    expect(t.steps[0]).toMatchObject({ skill: "review", by: "session", dispatch: true });
    expect(t.never).toEqual(["edits besides the report"]);
    expect(t.handoff).toBe("none");
    expect(t.review).toEqual({ report: "REVIEW.md", security: true }); // outreach acts on other people (decision 37)
    expect(signal(t, "fix-words")?.detail).toContain("fix");
    expect(signal(t, "report-file")?.detail).toContain("REVIEW.md");
    expect(t.then?.type).toBe("bug");
    expect(ids(t.then!)).toEqual(["reproduce", "failing-test", "fix", "checks", "lanes", "report"]);
    expect(t.then?.never).toEqual(["intake", "mockups", "design", "architecture"]);
    expect(t.then?.handoff).toBe("now");
    expect(t.then?.tier).toBe(2);
    expect(t.headline).toMatch(/Report: REVIEW\.md\./);
    expect(t.headline).toMatch(/Then: Bug fixes for the confirmed findings, tier 2\./);
  });

  it("a plain review stays read-only: no report, no fixes", () => {
    for (const request of ["Review the outreach code before I ship it.", "Review the fix for the login bug.", "Can you review the deploy script before we release?", "Review the changes in CHANGELOG.md"]) {
      const t = run(request);
      expect(t.type, request).toBe("review");
      expect(ids(t), request).toEqual(["review"]);
      expect(t.never, request).toEqual(["any edit"]);
      expect(t.then, request).toBeNull();
      expect(t.review?.report, request).toBeNull();
    }
  });

  it("reads a fix request after the review, in its own words", () => {
    for (const request of ["Review the parser. Fix anything serious.", "Review the parser, fix what you find", "Review the parser and then repair what's broken", "Audit the parser and address the problems"]) {
      const t = run(request);
      expect(t.then?.type, request).toBe("bug");
      expect(t.review?.report, request).toBe("REVIEW.md");
    }
    expect(run("Review the parser. Fix anything serious.").review?.security).toBe(false);
    expect(run("Do a security review of the API client and fix what you find").review?.security).toBe(true);
  });

  it("writes the report a request names, even without fixes; a report alone starts no edits", () => {
    const t = run("Review the auth code and write your findings to docs/auth-review.md");
    expect(ids(t)).toEqual(["review-report"]);
    expect(t.review).toEqual({ report: "docs/auth-review.md", security: true });
    expect(t.then).toBeNull();
    expect(run("Review the parser, fix the bugs and put the list in `NOTES.md`.").review?.report).toBe("NOTES.md");
  });

  it("never takes a report path outside the checkout or in runner metadata from the request", () => {
    for (const bad of ["../outside.md", "/tmp/review.md", ".jarvis/review.md", ".git/review.md"]) {
      const t = run(`Review the parser, put the findings in ${bad} and fix them.`);
      expect(t.review?.report, bad).toBe("REVIEW.md");
      expect(signal(t, "report-refused")?.detail, bad).toContain(bad);
    }
    expect(run("Review the parser and put the findings in ../outside.md").review?.report).toBeNull();
  });

  it("the model's judgment can name the report, add or drop the fixes; a review's fixes are always bug work", () => {
    expect(run("Review the parser.", { judgment: { then: "bug" } }).then?.type).toBe("bug");
    expect(run("Review the parser.", { judgment: { then: "bug" } }).review?.report).toBe("REVIEW.md");
    expect(run(TASK3, { judgment: { then: "none" } }).then).toBeNull();
    expect(run(TASK3, { judgment: { then: "none" } }).review?.report).toBe("REVIEW.md");
    const refactor = run("Review the parser and fix it", { judgment: { then: "refactor" } });
    expect(refactor.then?.type).toBe("bug");
    expect(signal(refactor, "fix-words")).toBeDefined();
    expect(run("Review the parser and fix it", { judgment: { report: "docs/parser.md" } }).review?.report).toBe("docs/parser.md");
    expect(() => run("Review the parser", { judgment: { report: "../parser.md" } })).toThrow();
    expect(run(TASK3, { judgment: { type: "review" } }).then?.type).toBe("bug");
  });

  it("only a review has a review block; an override never makes one", () => {
    expect(run("How does the ledger work?").review).toBeNull();
    expect(run("Chromium won't start in the container. Fix it.").review).toBeNull();
    expect(run(TASK3, { override: "ask" }).review).toBeNull();
    expect(run(TASK3, { override: "fix" }).type).toBe("bug");
  });
});
