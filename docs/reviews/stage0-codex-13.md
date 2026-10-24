# Stage 0 review 13: Codex

Oct 24, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `c077b9fd78473f17188758da535d2652658b24c7`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-13.json`.

## Verdict: FAIL

Reviewed revision c077b9fd78473f17188758da535d2652658b24c7. Two high credential-exposure findings block approval. Stage 0 does not meet decision 71's revised proof, excluding baselines. Stage 1's no-secret safety proof also remains incomplete, excluding the desktop-app check.

Prior critical/high findings, by original numbering:
Review 1: #1 Project hooks: fixed by restricted mode and explicit tools, guarded by args/probe tests and the live malicious-hook negative control. #2 Outside reads: restricted, with settings/probe, escaping-symlink and private-cache regressions. #3 Research tools: excluded and denied, guarded by args/settings tests. #4 Missing preflight: fixed; baseline.test.ts verifies rejection starts neither workspace nor session. #5 Original multiline dotenv, URL and private-key cases: fixed and snapshot-tested. #6 Network false PASS: connectivity, blocked-host 000 and policy-denial evidence are required, with unit and live negative controls.
Review 2: #1 Inline comments: fixed, with quoting/comment, escaping and unterminated-value regressions. #2 Uninspected files: size/NUL skips and JSON-URL omissions are fixed, with size-boundary, UTF-16 and binary regressions. #3 Shared cache: replaced by private caches; tests check distinct paths, absent cross-run markers and deletion. #4 Host-specific failures: cannot satisfy the denial-record requirement, guarded by unit/live tests.
Review 3: #1 Placeholder exemptions: narrowed to whole-value classification, with short, encoded and punctuated password regressions. #2 Binary keys: DER parsing/container refusal, guarded by generated-key snapshot tests.
Review 4: #1 Short/encrypted PEM keys: envelope detection and generated-key regressions. #2 Password-only URLs: detection/redaction and tracked-dotenv snapshot regressions.
Review 5: #1 Apostrophes: URL and dotenv snapshot regressions. #2 Signal converted to success: sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Corrupt objects: verified pack-transport clone and substituted-blob regression. #4 Short writes: complete-write loops with short-write/zero-progress tests. #5 Concurrent reclamation: instance-specific ownership markers, live-marker tests and competing-writer fault tests.
Review 6: #1 Concurrent broker execution: atomic claim under Ledger.transact, with concurrent call/socket/instance/process regressions. #2 Encoded configuration credentials: decoding and field inspection, guarded by snapshot regressions. #3 Premature successful exit: runner-captured observations and isolated assertions, guarded by early-exit gate tests.
Review 7: #1 Fabricated observations: candidate-written files cannot replace runner-captured output; the planted-observation regression guards this. #2 Reported configuration forms: YAML block/flow, JSONC, plist and quoted-numeric snapshot regressions.
Review 8: #1 Environment lists, duplicate fields and binary scalars: node-aware inspection and snapshot regressions.
Review 9: #1 Aliased/duplicate environment values: sensitive-name context preserved, with snapshot regressions. #2 npm Basic auth: scoped/unscoped _auth inspection and snapshot regressions.
Review 10: #1 Docker auth: structural auths.*.auth inspection and snapshot regressions. #2 YAML merges: bounded expansion retaining environment context, with merged-name/value/sequence regressions.
Review 11: #1 Short/long/non-ASCII Docker auth: structural inspection and corresponding snapshot regressions.
Review 12: #1 XML name/value credentials: name/key context reaches value attributes and element text; snapshot regressions cover the original examples, escapes and related forms.

All 31 original concrete critical/high reproductions have code fixes and regression assertions that would reject them if the corresponding protection were removed. This does not establish complete credential protection. Review 12's medium exhausted-read-retries finding is also fixed: unstable reads return contention, and Ledger.verify retries under the writer lock, with a sustained-interleaving regression.

I established no new broker approval bypass, gate/evidence forgery, concurrent-writer ledger corruption or loss of an acknowledged entry. Broker claims are serialized; ledger entries and heads receive complete writes and fsync; recovery repairs a lagging head before extension. Fault tests cover killed writers, competing writers and a killed reclaimer. Current action adapters remain local outbox stubs.

Supplied evidence reports successful typecheck, 187 passing unit/fault tests, four passing live tests, successful doctor --live and all 93 mutations caught in a disposable clone. I independently passed typecheck under Node 24.21.0 and reproduced both new findings through the actual createSnapshot routine with filesystem/Git operations substituted in memory. Filesystem-writing and live suites were not rerun in this read-only checkout. The logs do not establish tests-first development order.

## Remaining for stage 0

- Close both credential leaks below, with snapshot-level regressions and mutation coverage.
- Capture fresh revision-linked verification evidence and obtain a passing independent review.
- Save this review under docs/reviews/.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Stage 1 separately still requires the user-assisted desktop-app plugin check; ntfy typed replies remain deferred to stage 2.

## Findings

### 1. [high] Literal HTTP authorization credentials pass the snapshot scan

`packages/cli/src/eval/snapshot.ts:230`

**Scenario.** Authorization is absent from credential-field classification. A tracked request.json containing {"headers":{"Authorization":"Bearer Synthetic9qvM2"}} passes every scanner. So does Authorization: Basic dTo4azJa, which decodes to u:8k2Z: the generic base64 detector skips its eight-character encoding. I reproduced both being accepted and retained unchanged by createSnapshot without allowSecretsIn. A task can read these credentials; an applicable allowlisted service can also receive authenticated requests outside the broker. The existing Basic-header regression covers only a longer value caught by the generic heuristic.

**Fix.** Inspect Authorization and Proxy-Authorization credentials by header structure and authentication scheme, independently of generic token prefixes or base64 length. Refuse or redact literal credentials while preserving empty/reference-only values and explicitly reviewed fixtures. Add snapshot regressions for opaque Bearer tokens and short, long and non-ASCII Basic credentials, plus mutation coverage.

### 2. [high] Embedded Kubernetes private keys survive snapshot sanitization

`packages/cli/src/eval/snapshot.ts:456`

**Scenario.** The YAML walker treats client-key-data as an ordinary field, while raw-pattern scanning does not decode embedded base64 private keys. I generated a valid Ed25519 PKCS#8 PEM key, base64-encoded it into users[].user.client-key-data in kubeconfig.yaml, and reproduced createSnapshot accepting and retaining the entire file without allowSecretsIn. Decoding the retained value produced a private key accepted by Node's createPrivateKey. The existing plain-PEM and DER tests do not guard this credential representation, so a task session can recover the private key from its sanitized workspace.

**Fix.** Inspect credential-bearing Kubernetes structures, including literal client-key-data, and refuse or redact embedded private keys independently of raw PEM patterns. Decode supported key-bearing fields and apply private-key detection, or require explicit review for literal values. Add snapshot regressions using generated embedded keys and mutation coverage, while preserving public certificate data and reference-only configuration.

## Builder response

See `stage0-codex-13-response.md`.
