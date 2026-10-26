# Review-then-fix pipeline (decision 126): Codex review 5

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a23703adfcd6a1401. Oct 26, 2026.

FAIL

1. **NEW — HIGH: scoped runs delete excluded tasks’ recovery checkpoints.**

   `finish()` still calls `deleteCandidateBranches()` without an allowlist. That helper deletes every ref under `refs/heads/jarvis/candidates/`, including tasks reported as “left alone.” See [loop.ts:666](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/loop.ts:666) and [worktrees.ts:313](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/worktrees.ts:313).

   This loses recoverable work when an unrelated task crashed after committing its candidate but before recording `attempt_ended`. The ledger then lacks its candidate revision, so recovery depends on that ref. Startup cleanup also removes the crashed run’s workspace.

   An in-memory probe of the actual recovery and finish methods, with Git and persistence effects mocked, confirmed:

   - Without the intervening scoped run, `T8`’s candidate was recovered.
   - A report-update run allowing only completed `T9` deleted `T8`’s candidate ref while returning `complete`, `done: ["T9"]`, `leftAlone: ["T8"]`.
   - Subsequent unrestricted recovery found nothing for `T8`.

   Restrict candidate cleanup to authorized tasks and preserve excluded tasks’ recovery checkpoints. The current regression test checks ledger events but misses this deletion.

2. **Round-4 finding — RESOLVED for unauthorized task execution.**

   Scheduling, dependency blocking, and candidate recovery now filter by `only`. Retries remain within dispatched tasks. Production and evaluation pass explicit lists for both phases; zero findings skip the fix loop and run only the report update. See [run-compose.ts:215](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:215) and [jarvis.ts:541](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/eval/jarvis.ts:541).

   Probes confirmed scoped scheduling, empty-list behavior, dependency blocking, and ordinary scheduling without an allowlist. I found no additional high or critical defect in the inspected inbox paths or merge integration.

Validation: 37 direct assertions, source inspection, successful typechecking, and clean diff whitespace checks. No files changed; working tree clean. Repository suites, mutation runs, live harnesses, and real Git mutation tests were not run.
