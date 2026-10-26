/**
 * What triage still reads in a request's fix words (decision 126, round 3). Nothing here authorizes an edit. Three
 * rounds of the Codex security review showed that inferring edit permission from free text keeps failing (negations,
 * scopes, quotes, explanations, conditionals), so a review's fixes start only on an explicit, structured opt-in: the
 * user's recorded answer to the intake question `review-fix`, `jarvis run --plan review --fix`, or an eval task's
 * runner-owned `reviewFix`. The words give a signal and a fail-closed veto, nothing more.
 */

const FIX_WORDS = /\b(?:fix|fixes|fixing|fixed|repair|repairs|repairing|resolve|resolves|resolving)\b/i;
const NEGATION = /\b(?:not|no|never|nothing|without|nor|cannot)\b|n't\b/gi;
const VERB = /\b(?:edit|edits|editing|change|changes|changing|modify|modifies|modifying|modifications?|touch|touching|write|writes|writing|commit|commits|committing|fix|fixes|fixing|repair|repairs|repairing|resolve|resolves|resolving)\b/i;
const NOTHING = /\b(?:edit|change|modify|touch|write|commit|fix|repair|resolve)\s+nothing\b/i;
const READ_ONLY = /\bread[- ]only\b/i;
const REPORT_ONLY = /\b(?:report|findings|suggestions?|recommendations?|review)\s+only\b|\bonly\s+(?:report|suggest|list|flag|review|describe|point\s+out)\w*/i;

const normalize = (text: string) => text.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2013\u2014]/g, ", ");
/** Clauses: the text between sentence ends, semicolons and line breaks. */
const clauses = (text: string) => text.split(/[.!?;\n]+/).map((c) => c.trim()).filter(Boolean);

/** The request mentions fixing at all: triage's `fixes-mentioned` signal, which prompts the opt-in question. */
export function mentionsFixes(text: string): boolean {
  return FIX_WORDS.test(text);
}

/**
 * A prohibition on editing, as written, or undefined. Fail closed, with no exemption for scopes: a negation followed
 * anywhere in its clause by an edit or fix verb ("do not, under any circumstances, make changes", "no changes to the
 * public API"), a verb followed by "nothing" ("fix nothing"), "read-only", or "report only". It only ever removes
 * edits: a question's edits, and a review's report.
 */
export function forbidsEdits(raw: string): string | undefined {
  for (const clause of clauses(normalize(raw))) {
    for (const neg of clause.matchAll(NEGATION)) {
      const verb = VERB.exec(clause.slice(neg.index! + neg[0].length));
      if (verb) return clause;
    }
    const restriction = NOTHING.exec(clause) ?? READ_ONLY.exec(clause) ?? REPORT_ONLY.exec(clause);
    if (restriction) return clause;
  }
  return undefined;
}
