# Stage 0 review 10: Codex

Oct 24, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `02f7809fd3010d27d0b7b65beb1c00e72288da8f`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-10.json`.

## Verdict: FAIL

Reviewed revision 02f7809fd3010d27d0b7b65beb1c00e72288da8f. Two high credential-exposure findings block approval. Stage 0 does not meet decision 71's revised proof, even excluding baselines. Stage 1's no-secret safety proof also remains incomplete, even excluding the desktop-app check.

Prior critical/high findings, by original numbering:

Review 1: #1 Project hooks are excluded by restricted mode and explicit tools, guarded by args/probe tests and the live malicious-hook negative control. #2 Outside reads are restricted, escaping snapshot symlinks are removed, and caches are private; settings/probe/snapshot/baseline regressions guard these paths. #3 Web tools are excluded and denied, with args/settings regressions. #4 Baselines require preflight before creating a workspace or session, with a rejection regression. #5 The reported multiline dotenv, credential-URL and private-key cases are fixed and tested; broader credential protection remains incomplete below. #6 Network proof requires allowed-host connectivity, blocked-host 000 and a policy-denial record, guarded by unit cases and live negative controls.

Review 2: #1 Inline-comment redaction is fixed, with the exact reproduction plus escaping and unterminated-value tests. #2 Size/NUL skips and plain JSON URL omissions are fixed, with size-boundary, UTF-16 and binary regressions. #3 Private caches replace the shared cache; tests assert distinct paths, absent cross-run markers and deletion. #4 Ordinary connectivity failures cannot satisfy the required denial evidence, with probe tests and the live negative control.

Review 3: #1 Whole-value placeholder rules replace broad password exemptions, with helper and snapshot regressions. #2 DER private keys and credential containers are refused, with generated-key and snapshot tests.

Review 4: #1 Private-key envelope detection covers short and encrypted PEM keys, with generated Ed25519, X25519 and encrypted RSA regressions. #2 Password-only URLs are detected and redacted, with helper and tracked-dotenv snapshot regressions.

Review 5: #1 Apostrophes in URL userinfo are covered by snapshot and dotenv regressions. #2 The sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Pack-transport cloning verifies candidate objects; the swapped-blob regression requires refusal. #4 Complete-write loops protect ledger entries and heads; tests exercise short writes and zero progress. #5 Instance-specific reclaim markers prevent replacement-unlink races; live-marker and racing-writer tests guard reclamation.

Review 6: #1 Broker claims occur atomically under Ledger.transact, with concurrent-call, socket, instance and process tests. #2 Escaped URLs and the reported credential fields are detected and regression-tested. #3 Isolated assertions and runner-owned output capture reject the original early-successful-exit reproduction.

Review 7: #1 Candidate-written files cannot replace runner-captured observations; the planted-observation regression fails. #2 YAML block/flow values, JSONC, plist and quoted-numeric passwords are inspected and tested.

Review 8: #1 The original Compose-list, duplicate-field and binary-scalar reproductions are fixed and snapshot-tested.

Review 9: #1 Aliased names/values and duplicate environment-entry values retain sensitive-name context, with snapshot regressions. #2 Scoped and unscoped npm _auth credentials are detected, with snapshot regressions. The medium outbox collision also has a fix and deterministic same-timestamp regression.

All 27 original critical/high reproductions have corresponding code fixes and regression assertions that reject those cases when the relevant protection is removed. This establishes those specific fixes, not completeness of the credential boundary.

I established no new broker approval bypass, protected-gate forgery, concurrent ledger corruption or loss of an acknowledged ledger entry. Entries and heads receive complete writes and fsync; recovery repairs a lagging head before extension; lock ownership is published atomically. Fault tests cover killed writers, concurrent writers and a killed reclaimer. Current outside-action adapters remain local outbox stubs.

Supplied revision-linked evidence records successful typecheck, 184 passing unit/fault tests, four passing live tests, successful doctor --live and all 82 mutations caught in a disposable clone. I independently passed typecheck under Node 24.21.0 and reproduced both findings through the actual createSnapshot routine with filesystem/Git operations substituted in memory. Both snapshots were accepted and retained their credentials unchanged. I did not rerun filesystem-writing or live suites in this read-only checkout. The logs do not establish tests-first development order.

## Remaining for stage 0

- Fix both high credential leaks, adding snapshot-level regressions and mutation coverage.
- Capture fresh revision-linked verification evidence and obtain another independent review.
- Save this revision-linked review under docs/reviews/; this checkout is read-only.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11. Decision 71 permits second repeats during stage 1.
- Stage 1 completion additionally requires the user-assisted desktop-app plugin check.

## Findings

### 1. [high] Docker registry authentication credentials pass the snapshot scan

`packages/cli/src/eval/snapshot.ts:334`

**Scenario.** A tracked .docker/config.json containing {"auths":{"https://index.docker.io/v1/":{"auth":"c3ZjOlN5bnRoZXRpYzlxdk0y"}}} passes every scanner. The auth value decodes to svc:Synthetic9qvM2, but isSecretName recognizes npm's _auth while excluding Docker's auth field, and the base64 text matches no credential pattern. I reproduced createSnapshot accepting and retaining this content unchanged without allowSecretsIn. A task can therefore read a usable registry credential inside its supposedly sanitized workspace.

**Fix.** Inspect Docker authentication configuration by structure, including literal auth values beneath auths. Refuse or redact credentials unless explicitly reviewed, while preserving credential-helper references. Add snapshot-level regressions and a mutation that removes this protection.

### 2. [high] YAML merges still discard environment-entry credential context

`packages/cli/src/eval/snapshot.ts:406`

**Scenario.** For YAML containing 'base: &base\n  name: DB_PASSWORD\nenv:\n  - <<: *base\n    value: Synthetic9qvM2\n', envName examines only direct name/key pairs. Traversing the merge separately never associates the inherited DB_PASSWORD name with the entry's value. A merge-aware consumer resolves the entry to {name: DB_PASSWORD, value: Synthetic9qvM2}, but every scanner returns no hits. I reproduced createSnapshot accepting and retaining the complete configuration unchanged without allowSecretsIn.

**Fix.** Resolve effective environment-entry names through bounded YAML merge expansion while preserving duplicate-key inspection, or refuse merge-bearing entries that cannot be inspected safely. Add snapshot regressions for merged names, merged values and merge sequences, plus mutation coverage.

## Builder response

See `stage0-codex-10-response.md`.
