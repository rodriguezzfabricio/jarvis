/**
 * Whether a request authorizes fixes (decision 126; the Codex security review, rounds 1 and 2). It fails closed:
 *
 * - Fixes start only on a positive imperative to fix, repair or resolve something: the verb at the start of a
 *   clause or after "and", "then", "also", "please" or a comma, followed by what to fix ("the real problems",
 *   "them", "what you find", "anything serious"). The clause must hold no negation at all.
 * - Descriptive uses never authorize: "fix suggestions", "the fix for", "fixes go in", "address", "patch".
 * - Any negation of editing anywhere in the request (edit, change, modify, touch, write, fix, commit; "read-only",
 *   "report only") stops the fixes, unless it is scoped to a named part with "to", "in", "inside", "within" or
 *   "on" ("make no changes to the public API"). A scoped negation becomes a limit the fix tasks carry.
 *
 * When in doubt there are no fixes, and triage says that fix words were seen but no fixes were requested.
 */

export interface FixAuthorization {
  /** A positive imperative to fix something, in a clause with no negation. */
  authorized: boolean;
  /** The imperative's words ("fix the real"), for the signal. */
  imperative?: string;
  /**
   * An unscoped negation of editing, or a restriction to reporting. "edit": no edits at all, not even a report.
   * "fix": no fixes, though a report the request names may be written.
   */
  forbidden?: { kind: "edit" | "fix"; words: string };
  /** Negations scoped to a named part, as written: the limits the fix tasks keep. */
  limits: string[];
  /** Fix words appear but authorize nothing. */
  declined: boolean;
}

const VERB = String.raw`(?:fix|repair|resolve)`;
/** What a fix imperative names: a pronoun, a determiner or quantifier, or a kind of defect. Anything else is descriptive. */
const OBJECT = String.raw`(?:them|it|those|these|that|this|what(?:ever)?|all|any|every|each|anything|everything|the|real|actual|confirmed|serious|critical|important|found|broken|bugs?|problems?|issues?|findings?|vulnerabilit\w*|errors?|mistakes?|flaws?|holes?)\b`;
const LEAD = String.raw`(?:^|\b(?:and|then|also|please|so)\s+|,\s*)(?:(?:then|please|also|now|go\s+ahead\s+and)\s+)*`;
const IMPERATIVE = new RegExp(String.raw`${LEAD}(${VERB}\s+${OBJECT})`, "i");
const NEGATION = /\b(?:not|no|never|nothing|none|without|neither|nor|cannot)\b|n't\b/i;
const EDIT_VERB = String.raw`(?:edit|edits|editing|change|changes|changing|modify|modifies|modifying|modifications?|touch|touching|write|writes|writing|commit|commits|committing)`;
const FIX_VERB = String.raw`(?:fix|fixes|fixing|repair|repairs|repairing|resolve|resolves|resolving)`;
/** A negation word, up to three words, then an edit or fix verb: "do not make any changes", "don't edit", "nothing should change". */
const NEGATED = new RegExp(String.raw`\b(?:not|no|never|nothing|without|nor|cannot)\b|n't\b`, "gi");
const AFTER_VERB = (verbs: string) => new RegExp(String.raw`^(?:\s+\S+){0,3}?\s+(${verbs})\b`, "i");
/** A scope after the verb: optional "anything"/"any X", then a preposition and a named part that isn't the whole repository. */
const SCOPE = /^(?:\s+(?:anything|any\s+\w+))?\s+(?:to|in|inside|within|on)\s+(?!(?:the\s+|this\s+|that\s+|your\s+|our\s+|my\s+)?(?:repo|repository|code|codebase|project|files?|anything|everything|it|them|this|that|source|tree|workspace|checkout|branch)\b)\S/i;
/** The verbs a scope can limit: changes to the code. */
const SCOPABLE = /^(?:edit|edits|editing|change|changes|changing|modify|modifies|modifying|modifications?|touch|touching)$/i;
/** Verb-then-nothing ("fix nothing", "change nothing"). */
const NOTHING = new RegExp(String.raw`\b(${EDIT_VERB}|${FIX_VERB})\s+nothing\b`, "i");
const READ_ONLY = /\bread[- ]only\b/i;
const REPORT_ONLY = /\b(?:report|findings|suggestions?|recommendations?|review)\s+only\b|\bonly\s+(?:report|suggest|list|flag|review|describe|point\s+out)\w*/i;
const FIX_WORDS = /\b(?:fix|fixes|fixing|fixed|repair|repairs|resolve|resolves)\b/i;

/** Clauses: the text between sentence ends, semicolons and line breaks. */
function clauses(text: string): string[] {
  return text.split(/[.!?;\n]+/).map((c) => c.trim()).filter(Boolean);
}

export function fixAuthorization(raw: string): FixAuthorization {
  const text = raw.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2013\u2014]/g, ", ");
  let imperative: string | undefined;
  for (const clause of clauses(text)) {
    const m = IMPERATIVE.exec(clause);
    if (m && !NEGATION.test(clause)) { imperative = m[1]!.replace(/\s+/g, " "); break; }
  }
  const limits: string[] = [];
  let forbidden: FixAuthorization["forbidden"];
  for (const clause of clauses(text)) {
    for (const neg of clause.matchAll(NEGATED)) {
      const rest = clause.slice(neg.index! + neg[0].length);
      const edit = AFTER_VERB(EDIT_VERB).exec(rest);
      const fix = AFTER_VERB(FIX_VERB).exec(rest);
      const hit = edit ?? fix;
      if (!hit) continue;
      const after = rest.slice(hit.index + hit[0].length);
      // Only a change to the code can be scoped ("no changes to the public API"); "don't write to disk" or "never commit" can't.
      if (edit && SCOPABLE.test(edit[1]!) && SCOPE.test(after)) { if (!limits.includes(clause)) limits.push(clause); continue; }
      forbidden ??= { kind: edit ? "edit" : "fix", words: `${neg[0]}${rest.slice(0, hit.index + hit[0].length)}`.trim() };
    }
    const nothing = NOTHING.exec(clause);
    if (nothing) forbidden ??= { kind: new RegExp(`^${FIX_VERB}$`, "i").test(nothing[1]!) ? "fix" : "edit", words: nothing[0] };
    const readOnly = READ_ONLY.exec(clause);
    if (readOnly) forbidden ??= { kind: "edit", words: readOnly[0] };
    const reportOnly = REPORT_ONLY.exec(clause);
    if (reportOnly) forbidden ??= { kind: "fix", words: reportOnly[0] };
  }
  // An edit-kind negation anywhere outranks a fix-kind one found first: "no edits at all" is the stricter reading.
  if (forbidden?.kind === "fix") {
    for (const clause of clauses(text)) {
      for (const neg of clause.matchAll(NEGATED)) {
        const rest = clause.slice(neg.index! + neg[0].length);
        const edit = AFTER_VERB(EDIT_VERB).exec(rest);
        if (edit && !(SCOPABLE.test(edit[1]!) && SCOPE.test(rest.slice(edit.index + edit[0].length)))) { forbidden = { kind: "edit", words: `${neg[0]}${rest.slice(0, edit.index + edit[0].length)}`.trim() }; break; }
      }
      if (forbidden.kind === "edit") break;
      if (READ_ONLY.test(clause)) { forbidden = { kind: "edit", words: READ_ONLY.exec(clause)![0] }; break; }
    }
  }
  const authorized = imperative !== undefined;
  return {
    authorized, ...(imperative ? { imperative } : {}), ...(forbidden ? { forbidden } : {}), limits,
    declined: FIX_WORDS.test(text) && !(authorized && forbidden === undefined),
  };
}
