# Stage 0 review 6: Codex

Oct 23, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `8e710ef3643e4fb9e7bd9730e61f5e382d2db4ac`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-6.json`.

## Verdict: FAIL

Reviewed revision 8e710ef3643e4fb9e7bd9730e61f5e382d2db4ac. Three new high findings block approval. Stage 0 does not meet decision 71's revised proof, even excluding baselines. The stage 1 modules do not meet their safety proof, even excluding the desktop plugin check.

Prior critical/high findings, using each review's original numbering:

Review 1: #1 Project hooks: fixed by restricted mode and explicit tools; guarded by args.test.ts, probe.test.ts and the live malicious-hook negative control. Runner Git hook/fsmonitor protections also have adversarial baseline tests. #2 Outside reads: fixed for the reported boundary, with settings/probe tests, snapshot symlink removal and private-cache regressions. #3 Research tools: fixed by tool exclusion and explicit denial, guarded by args/settings tests. #4 Missing preflight: fixed in baseline.ts and the production CLI; baseline.test.ts verifies rejection starts neither workspace nor session. #5 Snapshot secrets: the reported multiline dotenv, URL and private-key cases are fixed and guarded by snapshot tests; overall credential protection remains incomplete as described below. #6 False network PASS: fixed by requiring connectivity, blocked-host 000 and a denial record; probe tests and the live network negative control guard this.

Review 2: #1 Inline-comment redaction: fixed, with the exact reproduction plus escaping and unterminated-value regressions. #2 Uninspected files: the reported size/NUL skips and plain JSON URL omission are fixed; snapshot tests cover size boundaries, UTF-16 and binary content. #3 Shared cache: fixed by private per-run caches, with distinct-path, cross-run marker and deletion assertions in baseline.test.ts. #4 Host-specific network failure: fixed by requiring denial evidence; guarded by probe tests and the live negative control.

Review 3: #1 Broad placeholder exemptions: fixed by narrow whole-value classification, with helper and snapshot-level regressions for short, percent-encoded and punctuated passwords. #2 Binary private keys: fixed by DER parsing and container refusal; generated-key and snapshot regressions guard the reported cases.

Review 4: #1 Short/encrypted PEM keys: fixed by envelope detection, with generated Ed25519, X25519 and encrypted RSA snapshot regressions. #2 Password-only URLs: fixed in detection/redaction, with helper and tracked-dotenv snapshot regressions.

Review 5: #1 Apostrophes in URL userinfo: fixed, with JSON/YAML snapshot and dotenv regressions. #2 Signal converted to success: fixed by using the sandbox library and observing the child outcome; checks.test.ts requires SIGTERM/SIGINT checks to fail. #3 Corrupt candidate objects: fixed by the verified pack-transport clone; checks.test.ts substitutes a loose blob and requires refusal. #4 Short writes: fixed by writeAll for entries/head publication; ledger tests exercise successful short writes and zero-progress refusal. #5 Concurrent stale-lock reclamation: the reported replacement-unlink race is fixed by per-instance nonce markers; unit and racing-writer fault tests guard reclamation. Recovery from a crash while holding that marker remains defective below.

For all 19 original critical/high reproductions, the corresponding regression assertions would fail if the reported fix were undone. This establishes those specific fixes, not completeness of the surrounding safeguards.

Supplied revision-linked evidence records 161 passing unit/fault tests, four passing live tests, successful typecheck and doctor --live, and all 53 listed mutations caught in a disposable clone. I independently passed typecheck under Node 24 and reproduced the broker race, credential-scanner bypass and premature-success process outcome without filesystem writes. I did not rerun filesystem-writing suites or a complete sandboxed gate exploit in this read-only review. The logs do not establish tests-first development order.

I found no new acknowledged-entry-loss or concurrent ledger-corruption path. The new lock finding affects recovery availability. Review 5's inherited-pipe cleanup and standalone-unhandled-error classification findings remain present and are already recorded in backlog entries 10 and 11.

## Remaining for stage 0

- Fix the three high findings below, add regressions and mutation coverage, capture fresh revision-linked evidence, and obtain another independent review.
- Record the new medium lock-recovery finding in docs/backlog.md under decision 74; it does not independently block approval.
- After a passing review, record valid baselines for tasks 1, 2 and 11. Decision 71 permits the second repeats during stage 1.
- Save this revision-linked review in docs/reviews/. Stage 1 completion additionally requires the user-assisted desktop plugin check; ntfy typed replies remain deferred to stage 2.

## Findings

### 1. [high] Concurrent broker requests execute one approved payload more than once

`packages/cli/src/broker/broker.ts:141`

**Scenario.** Duplicate prevention considers completed receipts but ignores unresolved executing intents. While the first handle() awaits adapter.execute(), a second identical request sees the approval and no final receipt, appends another intent and executes again. I reproduced two adapter calls and two succeeded responses under one approval using a blocking asynchronous adapter and an in-memory ledger. The socket server permits concurrent handle calls; existing duplicate tests send requests sequentially. This breaks the broker's once-only approval contract and would duplicate messages or spending through asynchronous external adapters.

**Fix.** Atomically check and claim each payload under shared ledger coordination before executing. An unresolved executing intent must prevent another execution until reconciliation; only a definite failed receipt may permit retry. Add concurrent socket-request and multiple-broker-instance regressions with a barrier-controlled adapter.

### 2. [high] Encoded configuration credentials pass the snapshot scan

`packages/cli/src/eval/snapshot.ts:277`

**Scenario.** Non-dotenv files are scanned as raw text without decoding their containing format. A valid tracked config.json can encode the slashes of postgres://svc:Synthetic9qvM2@db.prod.acme.net/app using JSON slash escapes. scanViews(...).flatMap(findCredentials) returns no hits, while JSON.parse followed by URL parsing recovers the password. createSnapshot therefore retains and commits the credential without allowSecretsIn. I reproduced this in memory. Plain structured password fields also receive no secret-key inspection outside dotenv files.

**Fix.** Inspect decoded scalar values and sensitive keys in supported configuration formats, in addition to raw-byte patterns. Refuse potentially sensitive configuration that cannot be safely inspected unless explicitly reviewed. Add snapshot-level regressions for escaped JSON URLs, Unicode escapes and structured password/token fields.

### 3. [high] Candidate code can exit successfully before protected assertions run

`packages/cli/src/checks/gate.ts:101`

**Scenario.** Any non-timed-out exit 0 becomes a passing gate without evidence that the protected check completed. For a protected Node check that imports candidate code before asserting its result, the candidate can call process.exit(0) during import. The assertions never run, but the check process exits successfully. I reproduced this through runSession: importing such a candidate before a deliberately failing assertion returned code 0, timedOut false and no assertion output. The revised signal handling does not address this normal-exit route.

**Fix.** Require verified completion of the protected acceptance checks, rather than exit status alone. Keep assertions and completion accounting in a trusted supervisor and execute candidate code across a process or equivalent isolation boundary. Add a regression where candidate initialization exits 0 before a failing acceptance assertion; the gate must refuse a pass.

### 4. [medium] A crash during stale-lock reclamation permanently blocks future appends

`packages/cli/src/ledger/ledger.ts:294`

**Scenario.** If a reclaimer dies after creating ledger.lock.reclaim.<nonce> but before unlinking the dead writer's main lock, both files remain. Every later writer encounters EEXIST on the marker and eventually times out. The marker contains no recoverable owner information, and age-based cleanup runs only after successfully acquiring the main lock, which is now impossible. The current unit test constructs this state and expects timeout; it does not establish recovery. Existing acknowledged entries remain intact, but restarting cannot resume ledger writes without manual intervention.

**Fix.** Prefer a kernel locking primitive that releases ownership on process death, or implement reclamation whose own owner death can be safely recovered without replacement-unlink races. Add a deterministic kill at reclaim-claimed and require a subsequent writer to append successfully while preserving all acknowledged entries.

## Builder response

See `stage0-codex-6-response.md`.
