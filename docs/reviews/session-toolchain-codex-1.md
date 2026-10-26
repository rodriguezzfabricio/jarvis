# Session Go toolchain (decision 123): Codex review 1

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a8b98e0d79d88ef09. Oct 26, 2026.

FAIL

1. **High — inherited unzip options enable writes outside the toolchain directory.** [packages/cli/src/toolchain/go.ts:102](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/go.ts:102) calls unsandboxed `unzip` without an explicit environment. If the runner inherits `UNZIP='-: -o'` or equivalent `UNZIPOPT`, archive entries containing `../` can overwrite runner files, installed gate fixtures, or other runs’ files. The local unzip manual confirms this behavior. The subsequent `refuseLinks(dest)` cannot detect or undo writes outside `dest`. Supply a minimal environment and validate archive paths and entry types before extraction.

2. **High — archive extraction can exhaust the host disk and block the runner.** [packages/cli/src/toolchain/go.ts:102](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/go.ts:102) extracts the entire archive synchronously, without limits on expanded bytes, entry count, or execution time. A compressed bomb in a malformed fixture can consume the shared volume, disrupting concurrent runs and ledger/evidence writes. Cleanup starts only after extraction returns. Enforce archive limits before extraction, an actual output budget during extraction, and a timeout.

Read-only review: no tests or mutations executed. All 50 anchors in the two affected mutation files match exactly once; neither extraction defect has targeted coverage.
