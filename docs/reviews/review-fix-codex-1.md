# Review-then-fix pipeline (decision 126): Codex review 1

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a23703adfcd6a1401. Oct 26, 2026.

FAIL

1. **HIGH — Untrusted report selection bypasses gates and review.** [packages/cli/src/commands/run-compose.ts:102](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:102)  
   Production takes the report path from session-owned `findings.json` and commits it directly. `CMakeLists.txt` and `requirements.txt` are accepted report paths. A session can replace either with malicious build instructions, name it as its report, and supply `findings: []`. The nonempty file passes validation and reaches the run branch without any fix task, protected check, or independent review. Bind the destination to runner-owned request data and prevent report commits from overwriting executable configuration.

2. **HIGH — Git expands report paths beyond the validated file.** [packages/cli/src/commands/run-compose.ts:105](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/commands/run-compose.ts:105)  
   Path validation permits `[` and `]`, but `git add` and `git commit` interpret the report argument as a pathspec; `--` does not make it literal. A report named `[C]MakeLists.txt` can therefore commit both that literal report and session edits to `CMakeLists.txt`, bypassing the promised report-only commit and subsequent review. Read-only probing confirmed bracket expansion for an accepted path. Use literal pathspecs throughout and verify the commit changes exactly the validated report.

3. **HIGH — Explicit report-only requests become editing pipelines.** [packages/cli/src/triage/triage.ts:338](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a23703adfcd6a1401/packages/cli/src/triage/triage.ts:338)  
   Reproduced: `Review the parser and fix nothing. Report only.` produces `then: bug`, and eval selects `review-fix`. Likewise, `Review the patch. Do not edit; fix suggestions only.` enables fixes. The verb regex ignores negation and treats descriptive wording as authorization. Honor explicit no-edit constraints before adding an editing pipeline, with regression coverage for these inputs.

Validation remained read-only; unit and mutation suites were not run because they write files.
