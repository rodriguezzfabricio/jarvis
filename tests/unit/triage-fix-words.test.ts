// What triage still reads in a request's fix words (decision 126, round 3). Nothing here authorizes an edit: a
// review's fixes start only on an explicit opt-in (the intake answer, `jarvis run --plan review --fix`, or the eval
// task's runner-owned reviewFix). The words only give a signal, and a fail-closed veto of edits.
import { describe, expect, it } from "vitest";
import { forbidsEdits, mentionsFixes } from "../../packages/cli/src/triage/fix-words.ts";
import { CODEX_PHRASINGS } from "./helpers/review-fix-phrasings.ts";

describe("fix words: a signal, never an authorization", () => {
  it("notices a request that mentions fixes, however it is phrased", () => {
    for (const text of [...CODEX_PHRASINGS, "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems.", "Review the importer and repair what's broken.", "Review the parser and resolve the issues."]) {
      expect(mentionsFixes(text), text).toBe(true);
    }
    for (const text of ["Review the parser.", "Review the outreach code before I ship it.", "Audit the importer and list the problems."]) expect(mentionsFixes(text), text).toBe(false);
  });

  it("finds a prohibition on editing anywhere, with no exemption for scopes", () => {
    for (const text of [
      "Review the parser and fix nothing.",
      "Review the patch. Do not edit; fix suggestions only.",
      "Review the parser. Do not make any changes.",
      "Review the parser and do not edit the repository.",
      "Review the parser; make no changes to any files.",
      "Review the parser; make no changes to the public API.",
      "Review the parser; do not, under any circumstances, make changes.",
      "Review the parser. Read-only, please.",
      "Review the parser. Report only.",
      "Review the parser and never commit.",
      "Review the parser \u2014 don\u2019t modify anything.",
      "Review the parser; change nothing else.",
    ]) expect(forbidsEdits(text), text).toBeDefined();
    for (const text of ["Review the parser.", "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems."]) expect(forbidsEdits(text), text).toBeUndefined();
  });
});
