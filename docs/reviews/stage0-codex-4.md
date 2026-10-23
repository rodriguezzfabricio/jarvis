# Stage 0 review 4: Codex

Oct 23, 2026 · codex-cli 0.163.0, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).

- **Reviewed revision:** `050768c25b43186d4ed8026c7c20edbd536f1a7c` (a fresh clone, with the builder's response docs removed).
- **Raw verdict:** `stage0-codex-4.json`.

## Verdict: FAIL

Reviewed revision 050768c25b43186d4ed8026c7c20edbd536f1a7c. Two high and two medium findings remain. Stage 0 does not meet decision 71's revised proof, even excluding baselines and the phone test.

Review 1 findings:
1. Project hooks: fixed and regression-tested in args.test.ts and probe.test.ts; the live malicious-hook negative control detects the old escape. Runner Git hook/fsmonitor protections have adversarial tests.
2. Outside reads: fixed for the implemented envelope. Settings/probe tests guard outside reads; snapshot tests guard escaping symlinks; baseline tests guard private caches and cross-run separation.
3. Research tools: fixed for current sessions. Args exclude web tools, settings deny them, and regression assertions guard both.
4. Mandatory preflight: fixed in the production CLI path. baseline.test.ts verifies rejection creates neither a workspace nor a session.
5. Snapshot credentials: partly fixed. Multiline dotenv values, credential URLs, recognized token patterns and symlinks have tests, but the PEM and password-only URL leaks below remain unguarded.
6. Network canary: fixed and regression-tested. It requires allowed-host connectivity, blocked-host 000 and a sandbox denial record. Fake cases cover reachable errors, ordinary connectivity failures and outages; the live allowlisted-host negative control fails as expected.
7. Settings validation: fixed. Exact-policy comparison and regression tests reject changed paths, permissions, domains and sockets.
8. Usage limits: fixed for the reported failures. Stream tests preserve window reset times; baseline/scheduler tests cover rejected streams, repeated rejection, preflight limits and explicit incomplete stops.
9. Output flushing: fixed and regression-tested with a delayed sink; its removal is caught by mutation testing. Output errors have fault-injection tests, but descendant cleanup remains incomplete.
10. Completion claims: reconciled by decision 71's explicit scope changes. No executable regression test applies.

Review 2 findings:
1. Inline-comment dotenv leak: fixed, with the reported reproduction, escapes and unterminated-value regressions.
2. Uninspected credential files: the reported size/NUL skips and JSON URL omission are fixed and tested, including a size-boundary test. Broader credential coverage remains incomplete as detailed below.
3. Shared cache: fixed and regression-tested through distinct paths, cross-run marker checks and deletion.
4. Host-specific network failure: fixed and regression-tested through required denial evidence and the live negative control.
5. Usage scheduler: fixed for the reported skip and preflight-limit failures, with scheduling-path tests.
6. Unhandled output errors: immediate error handling and explicit rejection are fixed and tested. Cleanup still fails when the leader exits before a resistant descendant.
7. Mutation classification: partly fixed. Control runs, identities, missing reports, collection errors and timeouts have guards, but runtime errors can still be counted as assertions.

Review 3 findings:
1. Broad placeholder exemptions: fixed in code, with helper regressions for short, percent-encoded and punctuated passwords. The requested snapshot-level cases were not added; current coverage calls findCredentials directly.
2. Binary private keys: the reported DER leak is fixed, with a generated RSA PKCS#8 snapshot regression and container/size tests. PEM handling still permits valid private keys.
3. Mutation classification: the original all-timeout and SIGKILL cases are fixed and tested. Assertion attribution remains insufficient.
4. Bounded termination: partly fixed. A resistant leader is tested, but early leader exit cancels escalation while descendants remain alive.
5. Spawn failures: fixed. Sessions reject with SessionStartError and preserve a diagnostic; scheduler tests stop on thrown or unstarted runs. Supplied mutations guard both paths.
6. Final-task wait: fixed. Pending waits occur before another dispatch, and final-task regressions cover resets inside and beyond the cap.

The detached process group confines normal signaling to the session's group; I established no kill of an unrelated group. I did reproduce incomplete descendant cleanup. Supplied evidence records 94 passing unit tests, three passing live tests, successful doctor --live with a disk warning, and 28 caught mutations. I independently passed typecheck under Node 24 and ran in-memory credential/classifier and process-cleanup reproductions. Filesystem-writing suites were not rerun in this read-only checkout. Mutation results do not establish tests-first development order.

## Findings

### 1. [high] Valid short PEM private keys pass the credential scan
`packages/cli/src/eval/snapshot.ts:115`

**Scenario.** The PEM pattern requires at least 100 body characters. I generated valid unencrypted Ed25519 and X25519 PKCS#8 PEM keys: Node accepted both as private keys, but scanViews(...).flatMap(findCredentials) returned no hits because each has a 64-character base64 body. isDerPrivateKey rejects PEM immediately because its first byte is not 0x30. A signing.pem therefore passes createSnapshot; signing.key also passes because the container check exempts PEM-prefixed text. Traditional encrypted RSA PEM also escapes the pattern because its Proc-Type/DEK-Info headers interrupt the expected base64 body. Existing tests cover a long synthetic PEM body and DER RSA, not these formats.

**Fix.** Detect valid PEM private keys independently of body length and refuse recognized private-key envelopes, including encrypted forms, unless explicitly reviewed. Put ambiguous dummy fixtures through allowSecretsIn. Add snapshot regressions using generated Ed25519/X25519 PEM keys and traditional encrypted RSA PEM.

### 2. [high] Password-only credential URLs escape redaction and detection
`packages/cli/src/eval/snapshot.ts:39`

**Scenario.** CRED_URL requires a nonempty username. A Redis-style URL such as redis://:Synthetic9qvM2@cache.prod.acme.net:6379/0 therefore matches neither redaction nor credential detection. I reproduced findCredentials returning [] for this URL in JSON, and redactEnvText leaving REDIS_URL containing it unchanged with no redaction keys. REDIS_URL does not match SECRET_KEY, so a tracked dotenv file carrying a production Redis password is exported unchanged. The narrowed placeholder rule never runs for this URL.

**Fix.** Recognize password-bearing userinfo with an empty username in both redaction and detection. Add snapshot regressions for Redis/rediss password-only URLs in dotenv and JSON/YAML, verifying redaction or refusal without allowSecretsIn.

### 3. [medium] Leader exit cancels escalation while session descendants survive
`packages/cli/src/harness/claude/session.ts:97`

**Scenario.** The child close event clears every timer, including the shutdown SIGKILL timer, without checking whether its process group is empty. Normal completion then sends only SIGTERM. I reproduced a leader starting a SIGTERM-resistant descendant with redirected output: runSession returned successfully while the descendant remained alive beyond killGraceMs. With an injected capture failure, the leader terminated and runSession rejected, but clearing the escalation timer again left the descendant alive. Current tests separately cover a resistant leader and a cooperative background child, missing this combination.

**Fix.** Keep group cleanup active after the leader exits. Apply bounded TERM/KILL cleanup on normal completion and fatal errors, and await cleanup before returning or committing results. Add regressions with a cooperative leader and resistant descendant whose output is redirected, covering both normal completion and capture failure.

### 4. [medium] Mutation classifier still mistakes runtime errors for assertions
`scripts/mutation-classify.mjs:8`

**Scenario.** ASSERTION accepts any failure text containing matcher names such as toBe or toThrow. I supplied a same-identity report whose sole failure was 'TypeError: expect(...).toBe is not a function'; classify returned caught although no assertion completed. The classifier also calculates non-assertion failures in other but accepts the run whenever any assertion-like failure exists, allowing mixed infrastructure failures or unfinished test cases to pass. Existing tests cover a generic TypeError and isolated infrastructure failures, not matcher-named errors or mixed outcomes.

**Fix.** Use structured error metadata or a custom reporter to distinguish assertion failures from runtime and unhandled errors; avoid matcher-name substring classification. Reject infrastructure failures and incomplete test statuses even when another assertion fails, and validate expected process exits. Add regressions for matcher-named TypeErrors, mixed assertion/runtime failures, unfinished cases and unhandled errors.

## What it says remains for stage 0

- Close the PEM private-key and password-only credential-URL leaks, with snapshot-level regression tests.
- Complete descendant shutdown and mutation-classification fixes, including regressions for the failures below.
- Capture fresh revision-linked evidence and obtain another independent review.
- Record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Complete the ntfy publish-box phone test and save the revision-linked review before advancing.

## Builder response

See `stage0-codex-4-response.md`.
