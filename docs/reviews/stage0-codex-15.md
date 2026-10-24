# Stage 0 review 15: Codex

Oct 24, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `63f83947bfcacd0179fd448218a9995762ae4b73`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-15.json`.

## Verdict: FAIL

Reviewed revision 63f83947bfcacd0179fd448218a9995762ae4b73. Two new high credential-exposure findings block approval.

Prior critical/high findings, by original numbering: all 35 concrete findings have corresponding code fixes and regression assertions that would reject the original cases if their protection were undone. This establishes the specific fixes, not complete credential protection.

Review 1: #1 Project hooks are excluded by restricted mode and explicit tools, guarded by args/probe tests and the live malicious-hook negative control. #2 Outside reads are restricted, escaping links are removed, and caches are private; settings/probe/snapshot/baseline tests guard these boundaries. #3 Web tools are excluded and denied, guarded by args/settings tests. #4 Failed preflight prevents workspace creation and session launch, guarded by baseline.test.ts. #5 Original multiline dotenv, credential-URL and private-key cases are fixed and snapshot-tested. #6 Network proof requires allowed-host connectivity, blocked-host 000 and policy-denial evidence, guarded by unit tests and live negative controls.

Review 2: #1 Inline-comment redaction is fixed, with escaping and unterminated-value regressions. #2 Size/NUL skips and JSON-URL omissions are fixed, with size-boundary, UTF-16 and binary regressions. #3 Per-run caches replace shared caches; tests verify distinct paths, absent cross-run markers and deletion. #4 Ordinary connectivity failures cannot satisfy the denial-evidence requirement, guarded by probe tests and the live negative control.

Review 3: #1 Whole-value placeholder classification fixes the reported short, encoded and punctuated passwords, with helper and snapshot regressions. #2 DER private keys and credential containers are refused, with generated-key snapshot regressions.

Review 4: #1 Envelope detection covers short and encrypted PEM keys, with generated-key regressions. #2 Password-only URLs are detected/redacted, with helper and tracked-dotenv snapshot regressions.

Review 5: #1 Apostrophes in URL userinfo are covered by snapshot/dotenv regressions. #2 The sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Verified pack-transport cloning rejects substituted objects, guarded by the swapped-blob regression. #4 Complete-write loops protect ledger entries and heads, with short-write and zero-progress tests. #5 Instance-specific ownership markers prevent the reported reclamation race, with live-marker and competing-writer tests.

Review 6: #1 Atomic claims under Ledger.transact prevent concurrent broker executions, with call/socket/instance/process regressions. #2 Encoded configuration URLs and literal credential fields are inspected and snapshot-tested. #3 Runner-captured observations and isolated assertions reject the reported premature successful exit, guarded by checks.test.ts.

Review 7: #1 Candidate-written files cannot replace recorded observations, guarded by the planted-observation regression. #2 Original YAML block/flow, JSONC, plist and quoted-numeric cases are inspected and snapshot-tested.

Review 8: #1 Environment lists, duplicate fields and binary scalars have fixes and snapshot regressions.

Review 9: #1 Aliased/duplicate environment values retain credential context, with snapshot regressions. #2 Scoped/unscoped npm _auth credentials are inspected and snapshot-tested.

Review 10: #1 Docker authentication is inspected structurally, with snapshot regressions. #2 Bounded YAML merge expansion preserves environment-entry context, with merged-name/value/sequence regressions.

Review 11: #1 Short, long and non-ASCII Docker authentication values have structural protection and snapshot regressions.

Review 12: #1 XML name/key context reaches associated values and element text, with escaped-value and related snapshot regressions.

Review 13: #1 Literal Authorization credentials have structural/pattern protection, with opaque Bearer and short/long/non-ASCII Basic regressions. #2 Embedded Kubernetes keys are caught by key-bearing fields and decoded-base64 inspection, with generated PEM/DER regressions.

Review 14: #1 Arbitrary lowercase authorization credentials are no longer exempt, with JSON/TypeScript snapshot regressions. #2 Private/symmetric JWK material is inspected structurally and by patterns, with generated-key, JWKS, YAML, distant-field and public-key controls. The medium stale mutation anchor is also repaired.

I established no new broker approval bypass, protected-evidence forgery, concurrent-writer ledger corruption or loss of an acknowledged ledger entry. Claims are serialized; ledger entries and heads receive complete writes and fsync before acknowledgment; lagging-head repair precedes extension. Fault tests cover killed writers, concurrent writers and a killed reclaimer. Current action adapters remain local outbox stubs.

Supplied revision-linked logs report successful typecheck, 187 passing unit/fault tests, four passing live tests, successful doctor --live and all 102 mutations caught in a disposable clone. I independently passed typecheck under Node 24.21.0 and reproduced both findings through the actual createSnapshot routine with filesystem/Git operations substituted in memory. Filesystem-writing and live suites were not rerun in this read-only checkout. The logs do not establish tests-first development order.

Stage 0 does not meet decision 71's revised proof, excluding baselines. Stage 1's no-secret safety proof also remains incomplete, excluding the user-assisted desktop-app plugin check.

## Remaining for stage 0

- Close both credential leaks with snapshot-level regressions and mutation coverage.
- Capture fresh revision-linked verification evidence, obtain a passing independent review, and save it under docs/reviews/.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Stage 1 separately requires the user-assisted desktop-app plugin check.

## Findings

### 1. [high] INI continuation values expose literal passwords

`packages/cli/src/eval/snapshot.ts:542`

**Scenario.** The INI scanner processes each physical line independently. A tracked settings.ini containing '[database]\npassword =\n    Synthetic9qvM2\n' produces no hits: the password assignment appears empty, and its continuation line has no assignment. Python ConfigParser recovers the multiline password, while createSnapshot accepted and retained the complete file unchanged without allowSecretsIn in my in-memory reproduction. A task can therefore read a literal credential from a supposedly sanitized snapshot.

**Fix.** Parse supported INI continuation semantics while preserving credential-name context, or refuse ambiguous continuation values beneath sensitive keys. Add snapshot regressions for indented continuation values, including empty initial assignments, and mutation coverage.

### 2. [high] Extensionless AWS credential files bypass field inspection

`packages/cli/src/eval/snapshot.ts:267`

**Scenario.** CONFIG_FILE excludes the conventional extensionless basename credentials. A tracked .aws/credentials containing a [default] profile with an ASIA-prefixed temporary access key, opaque aws_secret_access_key and aws_session_token passes every scanner. The raw AWS pattern recognizes only AKIA, and the opaque secret/session values have no required recognizable prefix. I reproduced createSnapshot accepting and retaining this file unchanged without allowSecretsIn. A task can recover the credential set despite the broker-only credential boundary.

**Fix.** Recognize conventional credential-store paths independently of filename extensions and inspect their fields, or require explicit review as already done for netrc and pgpass. Add snapshot regressions for AWS shared credential profiles, including temporary credentials, plus mutation coverage.

## Builder response

See `stage0-codex-15-response.md`.
