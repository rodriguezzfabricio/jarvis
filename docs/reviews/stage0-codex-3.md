# Stage 0 review 3: Codex

Oct 23, 2026 · codex-cli 0.163.0, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).

- **Reviewed revision:** `c5a7997c0d3275b5086a13fea5d9e2cd9f7c8046` (a fresh clone, with the builder's response docs removed).
- **Evidence:** typecheck, 78 unit tests, the live probe and two live negative controls, `doctor --live`, and the mutation check (22 of 22).
- **Raw verdict:** `stage0-codex-3.json`.

## Verdict: FAIL

Reviewed c5a7997c0d3275b5086a13fea5d9e2cd9f7c8046. Stage 0 does not meet decision 71's revised proof, even excluding baselines and the phone test: two high-severity credential leaks remain.

Review 1 findings:
1. Project hooks: fixed. args.test.ts guards restricted mode, tool restrictions and rejection of --setting-sources; the live malicious-hook negative control detects the old escape.
2. Outside reads: fixed for the implemented envelope. Settings and probe tests guard the read boundary; baseline.test.ts now verifies distinct per-run caches, absent cross-run notes and cleanup.
3. Research tools: fixed for current sessions. Args exclude web tools and settings explicitly deny them; both have regression assertions.
4. Mandatory preflight: fixed in the production path. baseline.test.ts verifies rejection creates neither a workspace nor a child session.
5. Snapshot credentials: partly fixed. Multiline dotenv values, URL redaction, PEM patterns and escaping symlinks have regression tests, but the two high findings below still expose credentials.
6. Network canary: fixed for the reported failures. It requires an allowed-host response, blocked-host 000 and a sandbox denial record. Tests cover reachable errors, host-specific failure without denial, total outage and the live allowlisted-host negative control.
7. Settings validation: fixed. Exact-policy comparison and tests reject swapped paths, widened permissions, domains and sockets.
8. Usage limits: the original failures are fixed. Tests guard per-window resets, assistant rate_limit errors, repeated task rejection, preflight rejection and explicit capped stops. A separate final-task wait defect remains below.
9. Output flushing: fixed and regression-tested with a delayed sink; the supplied mutation log records failure when the flush wait is removed. Early-open and ENOSPC tests now exist. Session termination and spawn-error gaps remain below.
10. Completion claims: reconciled by decision 71's explicit deferrals. This is a documentation scope change; no executable regression test applies.

Review 2 findings:
1. Inline-comment dotenv leak: fixed. The exact quoted-value/comment/next-secret reproduction now redacts correctly; regression tests also cover escapes and unterminated quotes.
2. Uninspected credential files: partly fixed. The size skip is replaced by refusal, NUL/UTF-16 content is scanned, and JSON credential URLs are tested. There is no size-boundary regression test, and actual binary private keys still pass.
3. Shared cache: fixed and regression-tested through private paths, cross-run marker checks and deletion. The supplied shared-cache mutation is caught.
4. Host-specific network failure: fixed and regression-tested, including the denial-record mutation and live negative control.
5. Usage scheduler: the reported skip and preflight-limit failures are fixed, with scheduling-path tests. Excessive waits now produce an explicit stop instead of silently skipping unfinished work.
6. Unhandled output errors: fixed for the reported crash, with early-open and mid-write fault injection. Cleanup remains insufficient when the child ignores SIGTERM.
7. Mutation classification: partly fixed. Missing reports and collection-count changes are rejected, but failed test status is still mistaken for a failed assertion, and process termination status is ignored. No classifier regression tests exist.

Evidence: supplied logs record 78 passing unit tests, three passing live tests, successful doctor --live with the disk warning, and 22 caught mutations. I independently passed typecheck under Node 24 and ran read-only synthetic reproductions for the findings below. I did not rerun filesystem-writing suites in this read-only checkout. The mutation logs support the listed guards, but do not establish tests-first development order. The live probe now also exercises runner-owned plugin hooks.

## Findings

### 1. [high] Placeholder detection exempts realistic production passwords
`packages/cli/src/eval/snapshot.ts:123`

**Scenario.** Any password containing %, $, *, braces or angle brackets, and every password of four characters or fewer, is exempt from credential-URL detection. I reproduced findCredentials returning [] for JSON containing postgres://svc:N7q4%40QmV8n2Lp9@prod.acme.net/app, a similarly strong password containing $, and password 8k2Z. The same URL with an ordinary longer password is detected. A tracked JSON/YAML configuration therefore exposes a real credential without allowSecretsIn. Existing tests assert broad placeholder acceptance but do not guard these cases.

**Fix.** Remove length and punctuation exemptions. Recognize only narrowly specified complete template forms, and require explicit file review for ambiguous examples. Decode URL userinfo before classification. Add snapshot-level tests proving percent-encoded, punctuation-containing and short production passwords are refused.

### 2. [high] Binary private keys pass the supposedly fail-closed scan
`packages/cli/src/eval/snapshot.ts:232`

**Scenario.** Non-dotenv binary files are accepted whenever text-pattern scanning finds nothing. I generated an in-memory unencrypted PKCS#8 DER RSA private key: Node accepted it as a private key, while scanViews(...).flatMap(findCredentials) returned []. A tracked signing.der or signing.key would consequently be copied and committed into the task snapshot. The binary regression fixture only embeds an ASCII AWS token; it does not test a genuine binary credential format.

**Fix.** Detect and refuse binary private-key and credential-container formats unless explicitly reviewed. Treat unsupported potentially sensitive binary formats as uninspectable rather than clean. Add a snapshot regression using a generated DER private key and verify refusal without allowSecretsIn.

### 3. [medium] Mutation classification still accepts infrastructure failures
`scripts/mutation-check.mjs:53`

**Scenario.** Vitest assertionResults entries represent test cases; status failed does not establish that an assertion ran. Feeding runSuite a same-count report in which every test timed out produced failedAssertions:78 and crashedFiles:[], which the script classifies as caught. It also accepts a clean-looking control report when spawnSync reports SIGKILL because status, signal and error are ignored. Thus the required check can still pass without demonstrating the safeguards.

**Fix.** Validate process exit and signal status, completed test identities and infrastructure errors. Require failures attributable to the intended regression checks, excluding timeouts and runner failures. Add classifier tests for timeout reports, signals, unhandled errors, collection failures and genuine regression failures.

### 4. [medium] Evidence failures lack bounded child termination
`packages/cli/src/harness/claude/session.ts:48`

**Scenario.** A sink error sends SIGTERM, but escalation to SIGKILL is scheduled only when the original session timeout expires. If Claude is hung or ignores SIGTERM, an ENOSPC/open failure leaves the session running without usable evidence until that potentially long timeout plus ten seconds. A synthetic child that ignored SIGTERM remained pending after the sink failed and rejected only after I explicitly killed it. Current fault-injection tests use children that terminate readily.

**Fix.** Use one idempotent shutdown path that starts a bounded termination grace period on every fatal error, escalates if necessary, and awaits child and stream cleanup. Add a SIGTERM-resistant child regression test.

### 5. [medium] Spawn failures are returned and counted as completed baseline runs
`packages/cli/src/harness/claude/session.ts:66`

**Scenario.** The child error handler resolves with code null instead of rejecting. I reproduced a missing executable returning normally with empty stdout and an ENOENT string in the returned stderr. With file capture, that diagnostic is not written to stderrPath, and runBaseline discards the returned stderr, creates a summary without init/result events, and runSchedule adds it to completed. EAGAIN, permission failures or a missing binary after preflight can therefore consume a required baseline without any model session having started. No test guards this path.

**Fix.** Reject spawn failures after coordinated cleanup, preserve their diagnostics in runner evidence, and classify them as explicit incomplete stops. Validate that a baseline actually started before counting it as recorded. Add spawn-failure tests through the session and scheduler paths.

### 6. [medium] The scheduler waits or reports a stop after all work is complete
`packages/cli/src/eval/schedule.ts:81`

**Scenario.** The high-usage wait runs after every completed task, including the final task of the final repeat. A successful last run can therefore delay command completion for hours. If its reset exceeds the cap, the outcome contains every run in completed but also reports stopped at the already-completed task, causing CLI exit 1. I reproduced this with a one-task successful schedule and a reset 28 hours away. Existing tests cover waiting between tasks only.

**Fix.** Apply proactive high-usage waits only when another run remains, preferably immediately before dispatching that run. Add final-task tests with reset times both inside and beyond the cap; both should return completed without sleeping or reporting an incomplete stop.

## What it says remains for stage 0

- Close both high-severity credential bypasses and add snapshot-level regression tests, including the missing size-boundary test.
- Resolve the session, scheduler and mutation-classification findings; capture fresh revision-linked evidence and obtain another independent review.
- Record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Complete the ntfy publish-box phone test and save the independent review before advancing.

## Builder response

See `stage0-codex-3-response.md`.
