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
    expect(t.review).toEqual({ report: "REVIEW.md", security: true, limits: [] }); // outreach acts on other people (decision 37)
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
    for (const request of ["Review the parser. Fix anything serious.", "Review the parser, fix what you find", "Review the parser and then repair what's broken", "Audit the parser and resolve the problems"]) {
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
    expect(t.review).toEqual({ report: "docs/auth-review.md", security: true, limits: [] });
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
    expect(run("Review the parser.", { judgment: { then: "bug" } }).then).toBeNull(); // the model can veto fixes, never start them (round 2: fail closed)
    expect(run("Review the parser.", { judgment: { then: "bug" } }).review?.report).toBeNull();
    expect(run(TASK3, { judgment: { then: "none" } }).then).toBeNull();
    expect(run(TASK3, { judgment: { then: "none" } }).review?.report).toBe("REVIEW.md");
    const refactor = run("Review the parser and fix it", { judgment: { then: "refactor" } });
    expect(refactor.then?.type).toBe("bug");
    expect(signal(refactor, "fix-words")).toBeDefined();
    expect(run("Review the parser and fix it", { judgment: { report: "docs/parser.md" } }).review?.report).toBe("docs/parser.md");
    expect(() => run("Review the parser", { judgment: { report: "../parser.md" } })).toThrow();
    expect(run(TASK3, { judgment: { type: "review" } }).then?.type).toBe("bug");
  });

  // Codex security review, round 1 (high 3): a fix verb next to an explicit "don't" is not a fix request.
  it("honors an explicit no-fix or no-edit constraint before adding an editing pipeline", () => {
    for (const request of [
      "Review the parser and fix nothing. Report only.",
      "Review the patch. Do not edit; fix suggestions only.",
      "Review the auth code and don't fix anything.",
      "Review the parser read-only and list what to fix.",
      "Review the importer. No changes. Address findings in a list.",
      "Review the importer; only report what you'd fix.",
      "Review the importer without changing anything, and fix suggestions go in a list.",
      "Review the module and make no changes.",
      // Codex round 2's reproductions.
      "Review the parser. Do not make any changes; fix suggestions go in the response.",
      "Review the parser and do not edit the repository; fix suggestions go in the response.",
      // A clear imperative, cancelled by a restriction in another sentence.
      "Review the parser and fix the bugs. Report only.",
    ]) {
      const t = run(request);
      expect(t.then, request).toBeNull();
      expect(ids(t), request).toEqual(["review"]);
      expect(t.never, request).toEqual(["any edit"]);
      expect(signal(t, "no-edit-words"), request).toBeDefined();
    }
    // The constraint wins over the model's judgment too.
    expect(run("Review the parser and fix nothing.", { judgment: { then: "bug" } }).then).toBeNull();
    expect(run("Review the parser. Do not edit.", { judgment: { then: "bug", report: "docs/parser.md" } }).review?.report).toBeNull();
  });

  it("a no-fix constraint still writes a report the request names; a no-edit constraint writes nothing", () => {
    const fixNothing = run("Review the parser and put the findings in REVIEW.md. Report only, fix nothing.");
    expect([fixNothing.then, fixNothing.review?.report, ids(fixNothing)]).toEqual([null, "REVIEW.md", ["review-report"]]);
    const editNothing = run("Review the parser and put the findings in REVIEW.md. Do not edit anything.");
    expect([editNothing.then, editNothing.review?.report, ids(editNothing)]).toEqual([null, null, ["review"]]);
    // The stricter reading wins, whichever comes first.
    for (const request of ["Review the parser and put the findings in REVIEW.md. Fix nothing, and do not edit anything.", "Review the parser and put the findings in REVIEW.md. Fix nothing. Do not edit anything."]) {
      const both = run(request);
      expect([both.then, both.review?.report, ids(both)], request).toEqual([null, null, ["review"]]);
    }
  });

  // Round 2: fail closed. A negation scoped to a named part ("to X", "in X") keeps fixes, as a limit the fix
  // tasks carry; any other negation of editing, even one that reads like a scope, makes a plain review.
  it("a negation scoped to a named part keeps fixes and passes the limit on; any other negation stops them", () => {
    for (const [request, limit] of [
      ["Review the parser and fix the bugs; make no changes to the public API.", "make no changes to the public API"],
      ["Review the parser and fix the real problems; no changes to the CLI flags.", "no changes to the CLI flags"],
    ] as const) {
      const t = run(request);
      expect(t.then?.type, request).toBe("bug");
      expect(t.review?.limits, request).toEqual([limit]);
    }
    for (const request of [
      "Review the parser and fix the bugs, but don't change the public API.",
      "Review the importer and fix it without changing the file format.",
      "Review the parser and fix what's broken, but don't touch the tests.",
    ]) {
      const t = run(request);
      expect(t.then, request).toBeNull();
      expect(t.review?.limits, request).toEqual([]);
    }
  });

  it("says when fix words were seen but no fixes were requested", () => {
    const t = run("Review the parser; fix suggestions go in the response.");
    expect(t.then).toBeNull();
    expect(signal(t, "fixes-not-requested")).toBeDefined();
    expect(t.headline).toMatch(/Fixes weren't requested/);
    expect(signal(run(TASK3), "fixes-not-requested")).toBeUndefined();
  });

  it("a question's edits honor the same constraint", () => {
    expect(run("Explain the ledger and fix the torn-line repair.").then?.type).toBe("bug");
    expect(run("Explain the ledger and fix nothing.").then).toBeNull();
    expect(run("How does the ledger work? Don't change anything.", { judgment: { then: "refactor" } }).then).toBeNull();
  });

  it("refuses build, config, agent and spec files as a report, even when the request names one", () => {
    for (const bad of ["CMakeLists.txt", "requirements.txt"]) {
      const t = run(`Review the parser, put the findings in ${bad} and fix them.`);
      expect(t.review?.report, bad).toBe("REVIEW.md");
      expect(signal(t, "report-refused")?.detail, bad).toContain(bad);
    }
  });

  it("only a review has a review block; an override never makes one", () => {
    expect(run("How does the ledger work?").review).toBeNull();
    expect(run("Chromium won't start in the container. Fix it.").review).toBeNull();
    expect(run(TASK3, { override: "ask" }).review).toBeNull();
    expect(run(TASK3, { override: "fix" }).type).toBe("bug");
  });
});
