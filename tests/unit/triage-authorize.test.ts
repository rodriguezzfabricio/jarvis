// Whether a review's request authorizes fixes (decision 126; Codex security review, rounds 1 and 2). It fails
// closed: only a positive, unambiguous imperative to fix something, in a clause with no negation, starts fixes;
// any unscoped negation of editing anywhere in the request stops them; descriptive uses never authorize.
import { describe, expect, it } from "vitest";
import { fixAuthorization } from "../../packages/cli/src/triage/authorize.ts";

const fixes = (text: string) => { const a = fixAuthorization(text); return a.authorized && a.forbidden === undefined; };

describe("fix authorization fails closed", () => {
  it("authorizes a positive imperative to fix, repair or resolve something", () => {
    for (const text of [
      "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems.",
      "Review the parser. Fix anything serious.",
      "Review the parser, fix what you find",
      "Review the parser and then repair what's broken",
      "Review the importer and resolve the issues you find.",
      "Review the parser and fix them.",
      "Please review the parser and please fix the bugs.",
    ]) {
      const a = fixAuthorization(text);
      expect(a.authorized, text).toBe(true);
      expect(a.forbidden, text).toBeUndefined();
      expect(a.imperative, text).toMatch(/^(?:fix|repair|resolve) /i);
    }
  });

  it("never treats a descriptive use of the word as a request", () => {
    for (const text of [
      "Review the parser; fix suggestions go in the response.",
      "Review the fix for the login bug.",
      "Review the parser. Fixes go in the report.",
      "Review the patch and list fix ideas.",
      "Review the parser: is the fix right?",
      "Review my fixes to the parser.",
      "Review the parser and address the problems.",
      "Review the parser and patch notes.",
      "Review the parser and fixed bugs list.",
      "Review the parser and tell me whether the fix the team made is right.",
    ]) expect(fixes(text), text).toBe(false);
  });

  it("stops fixes on any negation of editing that isn't scoped to a named part", () => {
    for (const text of [
      // Codex round 2's reproductions.
      "Review the parser. Do not make any changes; fix suggestions go in the response.",
      "Review the parser and do not edit the repository; fix suggestions go in the response.",
      // Round 1's.
      "Review the parser and fix nothing. Report only.",
      "Review the patch. Do not edit; fix suggestions only.",
      // A fix imperative is cancelled by a negation elsewhere, unless it is scoped.
      "Review the parser and fix the bugs, but don't touch the tests.",
      "Review the parser and fix the bugs. Don't write to disk.",
      "Review the parser and fix it without changing anything.",
      "Review the parser and fix the bugs; no commits.",
      "Review the parser and fix the real problems, not the style nits.",
      "Review the parser and don't fix anything.",
      "Review the parser and never commit; fix the bugs.",
      "Review the parser and fix the bugs; make no changes to the repository.",
      "Review the parser and fix the bugs; nothing should change in the code.",
      "Review the parser and fix the bugs. Read-only, please.",
      "Review the parser and fix the bugs. Report only.",
      "Review the parser and fix the bugs \u2014 don\u2019t modify anything.",
      "Review the parser and fix the bugs; change nothing else.",
    ]) {
      const a = fixAuthorization(text);
      expect(a.authorized && a.forbidden === undefined, text).toBe(false);
    }
    expect(fixAuthorization("Review the parser. Do not make any changes; fix suggestions go in the response.").forbidden).toMatchObject({ kind: "edit" });
    expect(fixAuthorization("Review the parser and fix nothing.").forbidden).toMatchObject({ kind: "fix" });
  });

  it("keeps fixes for a negation scoped to a named part, and returns that limit", () => {
    for (const [text, limit] of [
      ["Review the parser and fix the bugs; make no changes to the public API.", "make no changes to the public API"],
      ["Review the parser and fix the real problems; no changes to the CLI flags.", "no changes to the CLI flags"],
      ["Review the parser and fix the bugs. Don't change anything in the public API.", "Don't change anything in the public API"],
    ] as const) {
      const a = fixAuthorization(text);
      expect(a.authorized, text).toBe(true);
      expect(a.forbidden, text).toBeUndefined();
      expect(a.limits, text).toEqual([limit]);
    }
    expect(fixAuthorization("Review the parser and fix the real problems.").limits).toEqual([]);
  });

  it("says when fix words were seen but didn't authorize anything", () => {
    expect(fixAuthorization("Review the parser; fix suggestions go in the response.").declined).toBe(true);
    expect(fixAuthorization("Review the parser.").declined).toBe(false);
    expect(fixAuthorization("Review the parser and fix the bugs.").declined).toBe(false);
  });
});
