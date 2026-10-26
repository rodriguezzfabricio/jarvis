# Session Go toolchain (decision 123): Codex review 2

Reviewer: Codex gpt-6-astra, effort high, read-only. Branch worktree-agent-a8b98e0d79d88ef09. Oct 26, 2026.

FAIL

1. **Round 1 finding 1 — RESOLVED.** The external `unzip` invocation is removed. The reader rejects traversal, absolute paths, entries outside the module, and link/special-file types before extraction. Files use `O_EXCL | O_NOFOLLOW`; inherited `UNZIP`/`UNZIPOPT` cannot affect execution. See [zip.ts:64](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/zip.ts:64) and [zip.ts:130](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/zip.ts:130). Targeted traversal and environment tests now exist.

2. **Round 1 finding 2 — OPEN; substantially mitigated.** Archive bytes, entry count, declared expansion, actual inflate output, and free disk are checked. However, the deadline is checked only **before each entry**. `inflateRawSync`, CRC calculation, and writes cannot be interrupted by that check; the final entry can finish past the deadline and return success. Listing also runs before the deadline starts. See [zip.ts:108](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/zip.ts:108). The [timeout test](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/tests/unit/toolchain-zip.test.ts:138) advances a mocked clock between entries—it does not establish interruption of synchronous inflation. Use an enforceable timeout covering listing and extraction, with bounded work units or a separately supervised process.

3. **NEW — High: filename validation can exhaust runner memory before any timeout.** [zip.ts:83](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/zip.ts:83) constructs every parent prefix using `slice(...).join(...)`, then retains those strings in `folders`. This is quadratic in path depth, without path-length, depth, or aggregate metadata limits.

   A roughly 1.3 MB archive containing twenty zero-byte entries, each under a distinct directory followed by 16,000 `a/` components, passes the configured archive/count/expansion limits. The parent strings total approximately **5.14 billion characters**, before object overhead. Filesystem path limits cannot protect the runner because listing completes before filesystem creation begins. This can terminate the unsandboxed runner through heap exhaustion. Bound path length/depth and aggregate parent metadata before constructing prefixes; add targeted hostile-name coverage.

The other requested ZIP checks yielded these qualifications:

- **APFS names:** `toLowerCase()` does not handle canonical Unicode equivalence, such as `é` versus `e\u0301`, which [APFS treats as equivalent](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html). Preflight collision detection is incomplete. Exclusive creation prevents file overwrites; directory aliases can merge. I found no critical/high containment escape from this.
- **Descriptors, headers, and overlaps:** descriptors are ignored; local names are checked, but local flags/method/sizes/CRC are not reconciled with central records. Overlapping ranges are accepted. Extraction consistently uses central metadata and checks actual file length/CRC, so I found no additional critical/high bypass through those discrepancies.
- **Cleanup and fail-closed behavior:** ordinary extraction exceptions trigger cleanup. However, raw zlib errors and filesystem collision errors become `unavailable`, allowing host-Go fallback through [go.ts:127](/Users/fabriciorodriguez/Desktop/jarvis/.claude/worktrees/agent-a8b98e0d79d88ef09/packages/cli/src/toolchain/go.ts:127). Thus, “every malformed archive stops the run” is not established.

Compared with `a299593`, the Claude harness, settings, environment/PATH plumbing, both eval arms, and eval toolchain selection are byte-for-byte unchanged. Their read-only protections, fairness, and existing policy refusals remain intact. The main merge changes other components, so this is not a blanket approval of every merged change.

Read-only review: no files changed, test suites run, or mutations executed. All **61 current mutation anchors** across the two affected mutation files match exactly once. The memory finding is based on source analysis and allocation arithmetic, not an exhaustion run.
