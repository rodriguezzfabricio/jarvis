# Stage 0 review 14: Codex

Oct 24, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `dbfa63ca8eed1ed4b3f82ee89f0262fcfbca3c33`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-14.json`.

## Verdict: FAIL

Reviewed revision dbfa63ca8eed1ed4b3f82ee89f0262fcfbca3c33. Two high credential-exposure findings block approval; one medium mutation-check defect also remains.

Prior critical/high findings, using original numbering: all 33 concrete reproductions have code fixes and regression assertions that would fail if their corresponding protection were removed. This establishes the specific fixes, not complete credential protection.

Review 1: #1 Project hooks are excluded by restricted mode and explicit tools, guarded by args/probe tests and the live malicious-hook negative control. #2 Outside reads are restricted, escaping snapshot links are removed, and caches are private; settings/probe/snapshot/baseline tests guard these paths. #3 Web tools are excluded and denied, guarded by args/settings tests. #4 Preflight rejection prevents workspace creation and session launch, guarded by baseline.test.ts. #5 Original multiline dotenv, credential-URL and private-key cases are fixed and snapshot-tested. #6 Network proof requires allowed-host connectivity, blocked-host 000 and policy-denial evidence, guarded by probe tests and live negative controls.

Review 2: #1 Inline-comment redaction is fixed, with escaping and unterminated-value regressions. #2 Size/NUL skips and JSON URL omissions are fixed, with size-boundary, UTF-16 and binary snapshot tests. #3 Private caches replace shared caches; tests verify distinct paths, absent cross-run markers and deletion. #4 Ordinary connectivity failures cannot satisfy the denial-evidence requirement, guarded by unit/live tests.

Review 3: #1 Whole-value placeholder classification fixes the reported short, encoded and punctuated passwords, with helper and snapshot regressions. #2 DER private keys and credential containers are refused, with generated-key snapshot regressions.

Review 4: #1 Envelope detection covers short and encrypted PEM keys, with generated-key regressions. #2 Password-only URLs are detected/redacted, with helper and tracked-dotenv snapshot tests.

Review 5: #1 Apostrophes in URL userinfo are covered by snapshot/dotenv regressions. #2 The sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Verified pack-transport cloning rejects substituted objects, guarded by the swapped-blob test. #4 Complete-write loops protect entries and heads, with short-write and zero-progress tests. #5 Instance-specific reclaim markers prevent the reported replacement-unlink race, with live-marker and competing-writer fault tests.

Review 6: #1 Broker claims occur atomically under Ledger.transact, with concurrent call/socket/instance/process tests. #2 Escaped configuration URLs and literal credential fields are inspected and snapshot-tested. #3 Runner-captured outputs and isolated assertions reject the reported premature successful exit.

Review 7: #1 Candidate-written observation files cannot replace runner-captured output, guarded by the planted-observation regression. #2 YAML block/flow, JSONC, plist and quoted-numeric cases are inspected and snapshot-tested.

Review 8: #1 Environment lists, duplicate fields and binary scalars have fixes and snapshot regressions.

Review 9: #1 Aliased/duplicate environment-entry values retain sensitive-name context, with snapshot regressions. #2 Scoped/unscoped npm _auth credentials are inspected and snapshot-tested.

Review 10: #1 Docker auths.*.auth is inspected structurally, with snapshot regressions. #2 YAML merge expansion preserves environment context, with merged-name/value/sequence regressions.

Review 11: #1 Short, long and non-ASCII Docker authentication values have structural protection and snapshot regressions.

Review 12: #1 XML name/key context reaches associated attributes and element text, with escaped-value and related snapshot regressions.

Review 13: #1 Original opaque Bearer and short/long/non-ASCII Basic examples are fixed and snapshot-tested, but the new placeholder exemption leaves the broader finding incomplete below. #2 Embedded Kubernetes keys are caught by key-bearing fields and decoded-base64 scanning, with generated PEM/DER snapshot regressions.

I established no new broker approval bypass, gate/evidence forgery, concurrent-writer ledger corruption or loss of an acknowledged entry. Broker claims are serialized; ledger writes complete and fsync before acknowledgment; lagging-head repair precedes extension. Fault tests cover killed writers, competing writers and a killed reclaimer. Current outside-action adapters remain local outbox stubs. The credential leaks below still violate the broker-only credential boundary.

Evidence reports successful typecheck, 187 passing unit/fault tests, four passing live tests and successful doctor --live. The mutation check exits 1 because one source anchor is stale. I independently passed typecheck under Node 24.21.0 and reproduced both credential leaks through the actual createSnapshot routine with filesystem/Git operations substituted in memory. The retained private JWK successfully signed a message. Filesystem-writing and live suites were not rerun in this read-only checkout; the supplied logs do not establish tests-first development order.

Stage 0 does not meet decision 71's revised proof, excluding baselines. Stage 1's no-secret safety proof also remains incomplete, excluding the user-assisted desktop-app plugin check.

## Remaining for stage 0

- Close both high credential leaks with snapshot-level regressions and mutation coverage.
- Repair the stale format-encoding mutation and capture a successful complete mutation run.
- Capture fresh revision-linked evidence, obtain a passing independent review, and save it under docs/reviews/.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Stage 1 separately requires the user-assisted desktop-app plugin check.

## Findings

### 1. [high] Authorization placeholder exemption admits arbitrary lowercase credentials

`packages/cli/src/eval/snapshot.ts:174`

**Scenario.** isPlaceholderAuth treats every lowercase token, including punctuation-separated lowercase strings, as a placeholder. A tracked request.json containing {"headers":{"Authorization":"Bearer qzmtvknpwsrjlfcx"}} passes every scanner. The same header in TypeScript also passes. I reproduced both being accepted and retained unchanged by createSnapshot without allowSecretsIn. Nothing makes such a token synthetic: a task can read it and authenticate directly to an applicable allowlisted service.

**Fix.** Remove character-class-based placeholder exemptions. Recognize only narrowly specified complete placeholders or references; require explicit reviewed-fixture exceptions for ambiguous literals. Add snapshot regressions for lowercase opaque tokens and ensure removing their protection is caught by mutation testing.

### 2. [high] Private JSON Web Keys survive snapshot sanitization

`packages/cli/src/eval/snapshot.ts:451`

**Scenario.** The structured walker does not recognize private JWK material. I generated an Ed25519 private key, exported its standard JWK object containing kty, crv, d and x into private.jwk.json, and reproduced createSnapshot accepting and retaining it unchanged without allowSecretsIn. Neither field-name inspection nor PEM/DER/base64 scanning detected it. Re-importing the retained JSON with createPrivateKey({format:'jwk'}) produced a working signing key, exposing private cryptographic material to the task.

**Fix.** Inspect JWK/JWKS structures for private or symmetric key material, including private d parameters and oct keys, while allowing public-only keys. Apply this inspection wherever supported structured configurations can contain these objects. Add generated-key snapshot regressions and corresponding mutation coverage.

### 3. [medium] Stale mutation anchor leaves format-decoding protection untested

`scripts/mutation-check.mjs:54`

**Scenario.** The format-encoding mutation still targets the old construction of hits, which no longer exists after the encoded-credential changes. The supplied revision-linked log explicitly reports 'anchor not found', '1 mutation(s) not caught' and exit 1. The checker correctly refuses success, but the required complete mutation proof is unavailable and this safeguard was never exercised in the run.

**Fix.** Update the mutation to disable the current decoded-view path while preserving the other scanners, verify that the intended regression assertion fails, and rerun the complete mutation check in its disposable clone.

## Builder response

See `stage0-codex-14-response.md`.
