# Review-then-fix pipeline (decision 126): Codex review 2

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a23703adfcd6a1401. Oct 26, 2026.

FAIL

1. **Round 1 finding 1 — RESOLVED for the reported selection bypass.**  
   Production now receives the report path from runner context (`--report`, default `REVIEW.md`); session-owned findings can only match it. `CMakeLists.txt` and `requirements.txt` are rejected. The shared reader rejects report symlinks, hard links and symlinked parents. Name exclusions are case-insensitive. See [run-compose.ts:102](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:102). A separate filename-policy gap remains below.

2. **Round 1 finding 2 — RESOLVED.**  
   `status`, `add` and `commit` all receive `:(literal)` pathspecs. The helper checks the parent and requires exactly one changed file matching the report; a mismatch resets the branch to its previous commit. An in-memory callback probe confirmed both the literal arguments and rollback on an extra file. Both production and eval use this helper. See [review-fix.ts:347](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/review-fix.ts:347).

3. **Round 1 finding 3 — OPEN, HIGH: explicit no-edit requests still enable fixes.**  
   The two original examples now pass, but direct, read-only calls reproduced these failures:
   
   - `Review the parser. Do not make any changes; fix suggestions go in the response.`
   - `Review the parser and do not edit the repository; fix suggestions go in the response.`

   Both return `then: bug`, `report: REVIEW.md`, and eval pipeline `review-fix`. The constraint regex misses these prohibitions, while `; fix` still treats descriptive wording as authorization. Fix the authorization parsing rather than relying only on enumerated negative phrases. See [triage.ts:188](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/triage/triage.ts:188).

4. **NEW finding — HIGH: the report-name guard admits agent instruction files.**  
   `reportPathProblem("CLAUDE.local.md")` and `reportPathProblem("AGENTS.override.md")` both return no problem. Triage also accepts either as the requested report. The exclusion regex permits only one suffix after the reserved stem, missing these documented instruction filenames. See [review-path.ts:27](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/runner/review-path.ts:27).

   When either destination is selected, a session can supply nonempty instruction content and matching findings with `findings: []`. An existing regular file can be overwritten; the exactly-one-file check accepts that replacement. Eval commits it and reports completion without a fix gate or independent review. The repository documents both files as agent instruction sources in [harness research:65](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/docs/research/04-harness-portability-dsh.md:65). Exclude these variants case-insensitively, including existing-file replacements.

Also reproduced a lower-severity scope regression: `Review the parser and fix the bugs; make no changes to the public API.` incorrectly disables fixes.

Validation used source inspection and read-only/in-memory probes. No files changed; unit, mutation and real Git commit/reset tests were not run.
