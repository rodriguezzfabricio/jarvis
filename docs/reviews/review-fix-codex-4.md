# Review-then-fix pipeline (decision 126): Codex review 4

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a23703adfcd6a1401. Oct 26, 2026.

FAIL

1. **NEW — HIGH: review runs execute unrelated unfinished ledger tasks, including with zero findings.**

   `prepareProductionRun` supplies no plan when the review has no findings, then falls through to the ordinary build loop. With findings, its plan adds tasks but does not restrict execution: the scheduler selects eligible tasks from the entire project ledger. See [run-compose.ts:175](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:175) and [loop.ts:272](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/loop.ts:272).

   An in-memory probe of the production composition and scheduler, with storage, Git, and dispatch effects mocked, confirmed:

   - **Zero findings:** no review plan or custom driver; unrelated pending task `T8` was dispatched.
   - **One finding:** review task `T9` was planned, but unrelated `T8` was dispatched first.
   - `T8` retained its original goal to change the public API despite this review’s `--limit "do not change the public API"`.

   The opt-in therefore permits work beyond the review’s findings and limits. Scope scheduling and recovery to this review’s authorized tasks, and skip the build loop when there are none.

2. **Round-3 finding 1 — RESOLVED.**

   All three reported prohibition examples now return plain reviews with `then: null` and no report. Supplying model judgment `then: bug` or `then: refactor` does not change that. Reviews no longer acquire a fix pipeline from wording. See [triage.ts:337](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/triage/triage.ts:337).

3. **Round-3 finding 3 — RESOLVED.**

   The explanatory, quoted, and approval-dependent examples likewise produce no fixes or report. Fix words only signal that the opt-in question should be asked; evaluation reviews without the structured key are refused. See [jarvis.ts:192](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/eval/jarvis.ts:192).

4. **Round-3 finding 4 — RESOLVED for the historical-record overwrite bypass.**

   Historical report records no longer grant replacement permission. The production-function probe refused replacement of an existing changed report both with and without an old record, with zero commit calls. An unchanged existing report committed nothing. The evaluation arm checks existence before starting its review session. See [run-compose.ts:114](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:114) and [jarvis.ts:498](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/eval/jarvis.ts:498).

**Opt-in boundary:** I found no additional public entry route beyond the flag, ledger answer reference, and evaluation task key. Defaults, phone replies, wrong-question references, and malformed keys were rejected. However, these checks **do not authenticate that a human supplied the answer**. An in-memory call through actual intake recording accepted session-supplied `{"review-fix":"yes"}`, assigned user provenance, and satisfied `recordedFixYes`. This is the existing, explicitly documented [session-provenance limitation](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/docs/harness-assumptions.md:21), not a newly discovered boundary failure.

Validation: 65 direct assertions, in-memory production-function probes, source inspection, and successful typechecking. No files changed; working tree clean. Full unit, mutation, live-harness, and real Git mutation tests were not run.
