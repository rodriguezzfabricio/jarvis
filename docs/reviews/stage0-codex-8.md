# Stage 0 review 8: Codex

Oct 23, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `6f56de7f3dc109eaded6f10613443d33d8f92949`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-8.json`.

## Verdict: FAIL

Reviewed revision 6f56de7f3dc109eaded6f10613443d33d8f92949. One high finding blocks approval: supported configuration forms still expose credentials to task snapshots.

Prior critical/high findings, by original numbering:

Review 1: #1 Project hooks are excluded by restricted mode and explicit tools; args/probe tests and the live malicious-hook negative control guard this. #2 Outside reads are restricted, escaping snapshot symlinks are removed, and caches are private; settings/probe/snapshot/baseline tests guard the reported paths. #3 Web tools are excluded and denied, with args/settings regressions. #4 Baselines require preflight before creating a workspace or session, with a rejection regression. #5 The reported multiline dotenv, credential-URL and private-key cases are fixed and tested; broader credential protection remains incomplete below. #6 Network proof requires allowed-host connectivity, blocked-host 000 and a policy-denial record, with fake cases and live negative controls.

Review 2: #1 Inline-comment redaction is fixed, with the exact reproduction, escaping and unterminated-value regressions. #2 The size/NUL skips and plain JSON URL omission are fixed, with size-boundary, UTF-16 and binary tests; broader configuration inspection remains incomplete. #3 Shared caches are replaced by private caches, with distinct-path, cross-run-marker and deletion assertions. #4 Ordinary connectivity failure cannot satisfy the required denial evidence, with unit and live negative controls.

Review 3: #1 Broad password exemptions are narrowed to complete placeholders, with helper and snapshot regressions. #2 DER private keys and credential containers are refused, with generated-key and snapshot tests.

Review 4: #1 Short and encrypted PEM keys are detected by their envelopes, with generated Ed25519, X25519 and encrypted RSA regressions. #2 Password-only URLs are detected and redacted, with helper and snapshot regressions.

Review 5: #1 Apostrophes in URL userinfo are covered by JSON/YAML and dotenv regressions. #2 The sandbox library preserves the payload outcome; gate tests reject the reported SIGTERM/SIGINT cases. #3 Pack-transport cloning verifies candidate objects; the swapped-blob regression requires refusal. #4 Complete-write loops protect ledger entries and heads; tests exercise short writes and zero progress. #5 Instance-specific reclaim markers prevent the reported replacement-unlink race; live-marker and racing-writer tests guard reclamation.

Review 6: #1 Broker claims occur atomically under Ledger.transact; tests cover concurrent calls, sockets, instances and processes. #2 Escaped URLs and the reported literal credential fields are detected and regression-tested, but inspection remains incomplete below. #3 The runner now captures case outcomes separately from protected assertions; early successful exits cannot satisfy the reported regression.

Review 7: #1 Candidate-written observation files are no longer accepted: the runner records process stdout, stderr and status outside candidate write access, and an isolated verifier judges them. The planted-observation regression fails. #2 The reported YAML block/flow, JSONC, plist and quoted-numeric cases are fixed and tested, but the general credential finding remains open.

The original concrete reproductions across all 24 critical/high findings have corresponding fixes and regression assertions that reject those cases. That does not establish completeness of the credential safeguard. The earlier missing-lock, prototype-name, inherited-pipe, unhandled-error and dead-reclaimer findings also have fixes and regressions.

I established no new broker approval bypass, protected-evidence forgery, concurrent ledger corruption or loss of an acknowledged ledger entry. Entries and heads receive complete writes and fsync, recovery repairs the head before extension, and lock ownership is published atomically. Current outside-action adapters remain local outbox stubs.

Supplied revision-linked evidence records 183 passing unit/fault tests, four passing live tests, successful typecheck and doctor --live, and all 70 mutations caught in a disposable clone. I independently passed typecheck under Node 24 and reproduced the credential misses using the real scanning functions and the actual snapshot routine with an in-memory filesystem. I did not rerun filesystem-writing or live suites in this read-only checkout. The logs do not establish tests-first development order.

Stage 0 does not meet decision 71's revised proof, even excluding baselines. Stage 1's targeted safety tests pass for the tested workspace, but its complete no-secret safety claim cannot be approved while the credential boundary remains incomplete. The user-assisted desktop-app plugin check also remains outside this review.

## Remaining for stage 0

- Fix the configuration credential leak below and add snapshot-level regressions plus mutation coverage.
- Capture fresh revision-linked verification evidence and obtain another independent review.
- Save this revision-linked review in docs/reviews/.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits the second repeats during stage 1.

## Findings

### 1. [high] Structured configuration scanning still admits usable credentials

`packages/cli/src/eval/snapshot.ts:318`

**Scenario.** The structured walker checks only recognized leaf keys after conversion to JavaScript values. A normal compose.yml containing services.app.environment: ["API_KEY=Synthetic9qvM2"] produces no credential hits: the assignment is a string beneath environment, so its credential-bearing name is never inspected. Parsing also discards earlier duplicate fields: both {"password":"Synthetic9qvM2","password":""} and equivalent YAML pass while retaining the earlier password in the exported bytes. YAML password: !!binary U3ludGhldGljOXF2TTI= also passes because its decoded Buffer is traversed as numeric properties, losing the password context. I reproduced all four through the actual createSnapshot routine with filesystem and Git operations substituted in memory; each snapshot was accepted without allowSecretsIn and retained the credential. A task can therefore read a usable tracked secret despite the claimed broker-only credential boundary.

**Fix.** Inspect original parsed nodes without discarding duplicate entries, or reject duplicate keys. Recognize credential assignments in supported environment-list forms, and retain sensitive-key context through containers and binary scalar values. Refuse sensitive values that cannot be inspected safely. Add snapshot-level regressions for Compose environment lists, duplicate JSON/YAML password fields and YAML binary credentials, while preserving explicit reviewed-fixture exceptions.

## Builder response

See `stage0-codex-8-response.md`.
