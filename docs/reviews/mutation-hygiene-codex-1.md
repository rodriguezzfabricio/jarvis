# Mutation hygiene, stages 0-1 (decision 115): Codex review 1

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a074ac5c18aa1c42a; round 1 range 927131c..9dc1d73, round 2 9dc1d73..732834f. Oct 25, 2026.

FAIL

1. **High — Recorded runtime errors can still count as catches.** [scripts/mutation-classify.mjs:29](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a074ac5c18aa1c42a/scripts/mutation-classify.mjs:29) returns `true` for messages ending in `instead of rejecting/resolving` before checking the recorded error name. A `.rejects.toSatisfy()` callback throwing `TypeError("failed instead of resolving")` therefore counts as an assertion even when its SHA-256 record explicitly says `TypeError`. Reproduced using the installed Vitest matcher in memory: `classify()` returned `caught` with no assertion failure. Remove this shortcut and require the recorded `AssertionError` for every promise-chain failure; add a regression covering this suffix.

No file-writing tests were run.
