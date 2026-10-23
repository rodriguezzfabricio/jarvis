# Stage 0 review 2: Codex

Oct 23, 2026 · codex-cli 0.163.0, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).

- **Reviewed revision:** `9330856b4067b1baa54ac15fd603fa6ebc641e8d` (a fresh clone, with the builder's response doc removed).
- **Evidence:** typecheck, unit tests, the live probe and its negative control, `doctor --live`, and the mutation check.
- **Raw verdict:** `stage0-codex-2.json`.

## Verdict: FAIL

Reviewed revision 9330856b4067b1baa54ac15fd603fa6ebc641e8d. Stage 0 does not yet meet decision 71's revised proof, even excluding baselines and the phone test.

Review 1 findings:
1. Project hooks: fixed and regression-tested. Args require --restricted and an explicit tool list, reject --setting-sources, and the live negative control catches the old hook escape.
2. Outside reads: partly fixed. Unit/live probes cover direct reads outside the worktree, but the shared writable cache remains a channel between runs.
3. Research tools: fixed for current sessions. WebFetch/WebSearch are absent from BUILD_TOOLS and explicitly denied; args/settings tests guard this.
4. Mandatory preflight: fixed in the production CLI path. runBaseline checks preflight before creating a workspace or session; a regression test verifies no child starts after rejection.
5. Snapshot credentials: partly fixed. Tests cover multiline values, dotenv credential URLs, recognized non-dotenv keys and escaping symlinks. Inline comments break redaction, and the scan still fails open on several file classes.
6. Network canary: partly fixed. Reachable error responses and total network failure are tested, but host-specific failures can still produce a false PASS.
7. Settings validation: fixed and regression-tested. Validation compares settings against the exact generated policy for the trusted context, including protected paths and permissions.
8. Usage limits: partly fixed. Per-window resets and assistant rate_limit errors have tests, including a rejected fake session. The CLI retry scheduler has no regression test and still skips unfinished work after three limited attempts.
9. Output flushing: the normal completion race is fixed by awaiting finished(), but no regression test guards that change and early output-stream errors remain unhandled.
10. Scope/completion claims: decision 71 explicitly supersedes the earlier stage requirements. Its four deferrals and allowance for second baseline repeats during stage 1 are legitimate scope changes; no executable regression test applies.

Runner Git now disables hooks, fsmonitor and global/system configuration, with adversarial hook/fsmonitor tests. I did not establish another runner Git escape on this pin. Supplied live tests exercise restricted/tools/settings together, but do not exercise --plugin-dir; they therefore do not substantiate the separate claim that Jarvis plugin hooks work under restricted mode.

Evidence records 61 passing unit tests, two passing live tests, successful doctor --live with a disk warning, and 14 caught mutations. I independently reran typecheck successfully using Node 24 and reproduced the dotenv leak with synthetic input. Filesystem-writing suites were not rerun in this read-only review. Mutation results establish the listed regressions, not tests-first development order.

## Findings

### 1. [high] Inline comments cause dotenv redaction to retain subsequent secrets
`packages/cli/src/eval/snapshot.ts:62`

**Scenario.** The multiline detector treats PUBLIC_NAME="hello" # comment as an unclosed quoted value because the line does not end with a quote. It consumes following assignments as part of PUBLIC_NAME. I reproduced PUBLIC_NAME="hello" # comment followed by API_TOKEN=synthetic-sensitive-value returning unchanged, with no redaction keys and no credential-scan hits. A normal tracked dotenv file can therefore expose an opaque live token. Existing multiline tests do not cover inline comments.

**Fix.** Parse dotenv quoting, escapes and comments correctly, and reject malformed values rather than absorbing unrelated assignments. Add regression cases for inline comments before secret assignments, escaped quotes and unterminated values.

### 2. [high] The snapshot scan silently accepts uninspected credential-bearing files
`packages/cli/src/eval/snapshot.ts:145`

**Scenario.** Files larger than 5 MiB and files containing any NUL byte are retained without scanning or redaction. A tracked large dotenv file or UTF-16 credential file is exposed to the task without requiring allowSecretsIn. Even recognized token patterns bypass checking when placed in these files. Separately, credential URLs outside dotenv files are not checked: findCredentials returned no hits for a synthetic production database URL in JSON. Current tests cover only small supported text inputs.

**Fix.** Reject uninspectable files unless explicitly reviewed, or scan them completely using streaming and supported encoding detection. Apply credential-URL detection across text formats. Add oversized, NUL/UTF-16 and JSON/YAML credential fixtures.

### 3. [high] The shared writable cache defeats isolation between baseline runs
`packages/cli/src/eval/baseline.ts:93`

**Scenario.** Every task, repeat and retry uses the same workRoot/cache, reopened for both reading and writing by settings.ts. A session can copy its solution or instructions into GOCACHE, and a later session can read them without accessing a sibling workspace. Go build artifacts and package-manager logs can also retain task-derived information naturally. Nothing restricts this directory to downloaded packages, clears it between runs or verifies its contents. The probe tests cache writability, not separation between runs.

**Fix.** Give each run a private writable cache. If downloads must be shared, seed private caches from a runner-managed immutable package cache and prevent task writes from reaching it. Test that a marker and modified dependency from one run are unavailable to the next.

### 4. [high] Host-specific connectivity failures still pass the network canary
`packages/cli/src/harness/claude/probe.ts:219`

**Scenario.** network_blocked passes whenever the allowed host responds and the blocked host produces curl code 000. With network enforcement disabled, registry.npmjs.org can remain reachable while example.com has a DNS, TLS, routing or timeout failure; every network check then passes. The positive control against a different host does not distinguish policy enforcement from that failure. Tests cover reachable 404 and both hosts offline, but not this case.

**Fix.** Require explicit policy-denial evidence or use a controlled endpoint whose reachability is verified outside the sandbox and whose request receipts are observed by the runner. Add a negative control with network protection disabled and host-specific connectivity failures; it must never PASS.

### 5. [medium] Usage-limited attempts still exhaust a retry budget and skip the task
`packages/cli/src/cli.ts:45`

**Scenario.** Three consecutive usage-limited attempts exhaust the loop, after which execution advances to the next task despite logging that it will retry. This contradicts the rule that waiting does not consume attempts. A limit encountered by the mandatory preflight also throws before the usage-handling path. Parser and single-session tests cannot detect either scheduler failure.

**Fix.** Keep usage waits separate from task-attempt budgets and retain the unfinished task until completion or an explicitly recorded incomplete stop. Handle quota failures from preflight as waits too. Test the scheduling path with repeated rejections, preflight rejection and successful recovery.

### 6. [medium] Output-stream errors can crash the runner before cleanup
`packages/cli/src/harness/claude/session.ts:32`

**Scenario.** WriteStreams have no error handlers until finished() is called after the child closes. An early open failure or ENOSPC while a session is running emits an unhandled error, terminating the runner without coordinated child cleanup or an explicit evidence-capture failure. Awaiting stream completion fixes the normal flush race but not this error path; no session fault-injection tests cover it.

**Fix.** Attach pipeline/error handling immediately when creating each sink, coordinate failures with child termination and stream completion, and reject the run explicitly. Add delayed-output and early-open/ENOSPC tests, including a test that fails when the flush wait is removed.

### 7. [medium] Mutation checking counts test-runner failures as caught safeguards
`scripts/mutation-check.mjs:40`

**Scenario.** Any nonzero pnpm exit is classified as caught, even when no test assertion ran. For example, a Corepack startup/download failure or test-runner crash produces caught with '?' failing tests for every mutation, and the script exits successfully. This does not invalidate the supplied log's reported assertion counts, but it makes the required check capable of passing without testing the safeguards.

**Fix.** Require a successful unmodified control run and parse structured test results. Treat startup, collection, transform, signal and infrastructure failures as errors rather than caught mutations. Require an actual failed regression assertion for each mutation.

## What it says remains for stage 0

- Fix the high findings below and add regression tests covering each bypass.
- Complete the usage scheduler and output-error fixes; make mutation checking distinguish assertion failures from infrastructure failures.
- Capture revision-linked verification evidence and obtain another independent review after the fixes.
- Then record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits the second repeats during stage 1.
- Complete the ntfy publish-box phone test and save the independent review before advancing.

## Builder response

See `stage0-codex-2-response.md`.
