# Stage 0 review 9: Codex

Oct 24, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `c771436fecc7480042954f0e166cca4239225fcb`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-9.json`.

## Verdict: FAIL

Reviewed c771436fecc7480042954f0e166cca4239225fcb. Two high credential-exposure findings block approval. Stage 0 does not meet decision 71's revised proof, even excluding baselines. Stage 1's no-secret safety proof also remains incomplete, even excluding the desktop-app check.

Prior critical/high findings, by original numbering:

Review 1: #1 Project hooks are excluded by restricted mode and explicit tools, guarded by args/probe tests and the live malicious-hook negative control. #2 Outside reads are restricted, escaping snapshot symlinks are removed, and caches are private; settings/probe/snapshot/baseline tests guard these paths. #3 Web tools are excluded and denied, with args/settings regressions. #4 Baselines require preflight before creating a workspace or session, with a rejection regression. #5 The reported multiline dotenv, credential-URL and private-key cases are fixed and tested; the broader credential boundary remains incomplete below. #6 Network proof requires connectivity, blocked-host 000 and a policy-denial record, with unit regressions and live negative controls.

Review 2: #1 Inline-comment redaction is fixed, with the exact reproduction plus escaping and unterminated-value tests. #2 The size/NUL skips and plain JSON URL omission are fixed, with size-boundary, UTF-16 and binary regressions. #3 Private caches replace the shared cache; tests assert distinct paths, no cross-run marker and deletion. #4 Ordinary connectivity failures cannot satisfy the denial-evidence requirement, guarded by probe tests and the live negative control.

Review 3: #1 Whole-value placeholder rules replace broad password exemptions, with helper and snapshot regressions. #2 DER private keys and credential containers are refused, with generated-key and snapshot tests.

Review 4: #1 Private-key envelope detection covers short and encrypted PEM keys, with generated Ed25519, X25519 and encrypted RSA regressions. #2 Password-only URLs are detected and redacted, with helper and tracked-dotenv snapshot tests.

Review 5: #1 Apostrophes in URL userinfo are covered by JSON/YAML snapshot and dotenv regressions. #2 The sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Pack-transport cloning verifies candidate objects; the swapped-blob test requires refusal. #4 Complete-write loops protect ledger entries and heads; tests exercise short writes and zero progress. #5 Instance-specific reclaim markers prevent the reported replacement-unlink race; live-marker and racing-writer tests guard reclamation.

Review 6: #1 Broker claims occur atomically under Ledger.transact, with concurrent socket, instance and process tests. #2 Escaped URLs and the reported literal credential fields are detected and regression-tested; broader inspection remains incomplete. #3 Runner-owned output capture and isolated assertions reject the original early-successful-exit reproduction.

Review 7: #1 Candidate-written observation files cannot replace runner-captured output; the planted-observation regression fails. #2 The reported YAML block/flow, JSONC, plist and quoted-numeric cases are fixed and tested; broader credential inspection remains incomplete.

Review 8: #1 The four reported Compose-list, duplicate-field and binary-scalar reproductions now have fixes and snapshot regressions. However, related environment-entry forms still lose credential context, as finding 1 demonstrates. The general finding is not fully closed.

For all 25 original critical/high reproductions, I found corresponding fixes and regression assertions that would reject those cases if the relevant fix were undone. This establishes the specific fixes, not completeness of credential protection.

I established no new broker approval bypass, gate-evidence forgery, concurrent ledger corruption or loss of an acknowledged ledger entry. Entries and heads receive complete writes and fsync; recovery repairs a lagging head before extending the chain; lock ownership is published atomically. Fault tests cover killed writers, concurrent writers and a killed reclaimer. Current outside-action adapters remain local outbox stubs.

Supplied evidence records 183 passing unit/fault tests, four passing live tests, successful typecheck and doctor --live, and all 77 mutations caught in a disposable clone. I independently passed typecheck under Node 24 and reproduced both credential findings through the actual snapshot routine with filesystem/Git operations substituted in memory. I also reproduced the outbox collision with an in-memory filesystem and fixed timestamp. I did not rerun filesystem-writing or live suites in this read-only checkout. The logs do not establish tests-first development order.

## Remaining for stage 0

- Fix both high credential findings, add snapshot-level regressions and mutation coverage, capture fresh revision-linked evidence, and obtain another independent review.
- Record the medium outbox finding in docs/backlog.md under decision 74.
- Save this revision-linked review in docs/reviews/; this checkout is read-only.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11. Decision 71 permits the second repeats during stage 1.
- Stage 1 completion additionally requires the user-assisted desktop-app plugin check.

## Findings

### 1. [high] Environment-entry inspection still loses credential context

`packages/cli/src/eval/snapshot.ts:392`

**Scenario.** The YAML name/value inspector reads only the first matching direct scalar. For an environment entry with name: DB_PASSWORD and value: *p, where &p names an opaque password elsewhere, scalar("value") returns undefined. The later alias traversal uses the key "value", losing DB_PASSWORD's sensitive meaning. Likewise, an entry containing value: "" followed by value: Synthetic9qvM2 checks only the empty first value; walking the remaining pairs also loses the environment name. I reproduced both being accepted and retained unchanged by createSnapshot without allowSecretsIn. Thus the duplicate/alias handling added after review 8 still exposes usable passwords in supported configuration forms.

**Fix.** Carry the environment entry's sensitive name through inspection of its value nodes, resolving aliases with the existing limits. Inspect every duplicate occurrence or reject ambiguous entries. Apply the same typed-value policy used for directly named credential fields. Add snapshot regressions for aliased names/values and duplicate environment-entry values.

### 2. [high] Tracked npm Basic-auth credentials pass the snapshot scan

`packages/cli/src/eval/snapshot.ts:211`

**Scenario.** A tracked .npmrc containing //registry.npmjs.org/:_auth=c3ZjOlN5bnRoZXRpYzlxdk0y passes every scanner and is retained unchanged. The value decodes to svc:Synthetic9qvM2. fieldName normalizes _auth to auth, which SECRET_FIELD excludes, and the base64 credential matches no token or URL pattern. The installed npm configuration implementation explicitly consumes this field as Basic-auth credentials. I reproduced acceptance through createSnapshot without allowSecretsIn. A task can therefore read a registry credential; an applicable allowlisted registry also permits direct authenticated requests outside the broker.

**Fix.** Inspect npm authentication fields according to their format, including scoped and unscoped _auth values. Redact or refuse literal credentials unless the file was explicitly reviewed. Add snapshot regressions for Basic-auth .npmrc entries while preserving empty/reference-only configurations.

### 3. [medium] Outbox actions can overwrite an earlier successful action

`packages/cli/src/broker/outbox.ts:12`

**Scenario.** Outbox filenames contain only a millisecond timestamp and operation. Two distinct actions of the same operation receiving the same timestamp write the same path with truncation. Both return succeeded receipts referencing that path, but only the second payload remains. I reproduced two different email actions returning success while the outbox retained one file containing only the second message. Payload-hash deduplication does not prevent collisions between different payloads.

**Fix.** Give each outbox action a unique identifier and create its file exclusively, preventing replacement of an earlier artifact. Add a deterministic same-timestamp regression requiring distinct files and preservation of both payloads.

## Builder response

See `stage0-codex-9-response.md`.
