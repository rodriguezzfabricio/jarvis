# Review-then-fix pipeline (decision 126): Codex review 3

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a23703adfcd6a1401. Oct 26, 2026.

FAIL

1. **Finding 3 — OPEN, HIGH: unscoped prohibitions still enable fixes.**

   Both round-2 examples now correctly produce no report and no fixes. However, direct probes reproduced these bypasses:

   - `Review the parser and fix the bugs; make no changes to any files.`
   - `Review the parser and fix the bugs; no changes to the public API or edits anywhere else.`
   - `Review the parser and fix the bugs; do not, under any circumstances, make changes.`

   All return `then: bug`, `report: REVIEW.md`, and pipeline `review-fix`. The first two become scoped limits; the third prohibition disappears entirely. Passing a prohibition into a task prompt does not enforce the required plain-review behavior.

   The scope matcher checks only the beginning of the complement, while negation detection looks forward through at most three words. See [authorize.ts:41](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/triage/authorize.ts:41) and [authorize.ts:75](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/triage/authorize.ts:75). The public-API-only scope regression is fixed.

2. **Finding 4 — RESOLVED for the reported reserved-filename bypass.**

   `CLAUDE.local.md`, `AGENTS.override.md`, mixed-case variants, nested variants, and names containing `instructions`, `rules`, or `prompt` are rejected. Triage refuses these requested destinations. The shared reader checks the filename before consulting overwrite provenance, so a ledger entry cannot exempt these reserved names. See [review-path.ts:45](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/review-path.ts:45).

   Fullwidth/Cyrillic lookalikes and leading-space/zero-width variants are accepted, but I did not establish that a supported tool interprets them as the reserved instruction files. Those results alone are not a demonstrated high-severity bypass.

3. **NEW — HIGH: quoted, explanatory, and conditional fix phrases count as immediate authorization.**

   Each of these returns `then: bug`, `report: REVIEW.md`, and pipeline `review-fix`:

   - `Review the parser. Explain how to review and fix the bugs.`
   - `Review the parser. The guide says "review and fix the bugs".`
   - `Review the parser. If I approve, fix the bugs.`

   The new “imperative” matcher recognizes a substring after `and` or a comma without establishing that it is an unconditional instruction from the user. See [authorize.ts:34](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/triage/authorize.ts:34). This independently violates the positive-authorization requirement. Ambiguous, quoted, and approval-dependent language must not start fixes.

4. **NEW — HIGH: historical report records permanently authorize replacement of later instruction content.**

   `recordReport` stores a revision, but `reportsWritten` discards it and retains only the pathname. No check binds permission to the current blob or branch history. See [review-fix.ts:354](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/review-fix.ts:354).

   Concrete scenario: the pipeline once creates `docs/guidance.md`; a later commit changes it into instructions imported by `CLAUDE.md`. A subsequent review still receives unconditional overwrite permission for that path.

   An **in-memory probe of the actual `reviewRunFor` function**, with virtual filesystem and Git callbacks, confirmed:
   - Without the historical record, replacement is refused.
   - With the old record, session-supplied instruction content is committed, a new record is appended, and `findings: []` yields `fix: null`—no fix gate or independent review.

   See [run-compose.ts:111](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:111). Replacement authorization needs current provenance and instruction-target checks, rather than permanent pathname membership.

Validation: source inspection, direct probes, 18 targeted assertions, and the in-memory production-function probe. No files changed; working tree remains clean. Full unit, mutation, live-harness, and real Git commit/reset tests were not run.
