// Every phrasing the Codex security review used to get a review's fixes from prose (decision 126, rounds 1 to 3).
// None may start fixes without an explicit opt-in.
export const CODEX_PHRASINGS = [
  "Review the parser and fix nothing. Report only.",
  "Review the patch. Do not edit; fix suggestions only.",
  "Review the parser. Do not make any changes; fix suggestions go in the response.",
  "Review the parser and do not edit the repository; fix suggestions go in the response.",
  "Review the parser and fix the bugs; make no changes to any files.",
  "Review the parser and fix the bugs; make no changes to the public API or edits anywhere else.",
  "Review the parser and fix the bugs; do not, under any circumstances, make changes.",
  "Explain how to review and fix the bugs.",
  "The guide says \"review and fix the bugs\".",
  "If I approve, fix the bugs.",
];
