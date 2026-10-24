# Stage 0 review 12: Codex

Oct 24, 2026 · codex-cli, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).
- **Reviewed revision:** `8bd94f1398ab996be947d8e99431838b32fbadd1`, plus the stage 1 modules.
- **Raw verdict:** `stage0-codex-12.json`.

## Verdict: FAIL

Reviewed revision 8bd94f1398ab996be947d8e99431838b32fbadd1. One high credential-exposure finding blocks approval. Stage 0 does not meet decision 71's revised proof, excluding baselines; stage 1's no-secret safety proof also remains incomplete, excluding the desktop-app check.

Prior critical/high findings, by original numbering:
Review 1: #1 Project hooks: restricted mode, explicit tools and malicious-hook regressions in args/probe/live tests. #2 Outside reads: settings/probe boundaries, snapshot symlink removal and private-cache regressions. #3 Research tools: excluded and denied, guarded by args/settings tests. #4 Missing preflight: baseline rejection test verifies neither workspace nor session starts. #5 Original credential cases: multiline dotenv, URL and private-key snapshot regressions. #6 Network false PASS: denial evidence plus connectivity controls, guarded by probe tests and live negative controls.
Review 2: #1 Inline comments: quoting/comment regression tests. #2 Uninspected files: size-boundary, UTF-16, binary and JSON-URL snapshot tests. #3 Shared cache: distinct private paths, cross-run marker checks and deletion assertions. #4 Host-specific failures: denial-record tests and live negative control.
Review 3: #1 Placeholder exemptions: whole-value classification, guarded by short, encoded and punctuated password regressions. #2 Binary keys: DER parsing/container refusal, guarded by generated-key snapshot tests.
Review 4: #1 Short/encrypted PEM keys: envelope detection and generated-key regressions. #2 Password-only URLs: detection/redaction and tracked-dotenv snapshot regressions.
Review 5: #1 Apostrophes: URL and dotenv snapshot regressions. #2 Signal converted to success: sandbox library preserves process outcomes; gate tests reject SIGTERM/SIGINT cases. #3 Corrupt objects: verified pack-transport clone and substituted-blob regression. #4 Short writes: complete-write loops and short-write/zero-progress tests. #5 Concurrent reclamation: instance-specific ownership markers, live-marker tests and racing-writer fault tests.
Review 6: #1 Concurrent broker execution: atomic claim under Ledger.transact; concurrent call/socket/instance/process regressions. #2 Encoded configuration credentials: decoding and field inspection, guarded by snapshot regressions. #3 Premature successful exit: runner-captured observations and isolated assertions, guarded by early-exit gate tests.
Review 7: #1 Fabricated observations: candidate-written files cannot replace runner-captured output; planted-observation regression. #2 Reported configuration forms: YAML block/flow, JSONC, plist and quoted-numeric snapshot regressions.
Review 8: #1 Environment lists, duplicate fields and binary scalars: node-aware inspection and snapshot regressions.
Review 9: #1 Aliased/duplicate environment values: sensitive-name context preserved, with snapshot regressions. #2 npm Basic auth: scoped/unscoped _auth inspection and snapshot regressions.
Review 10: #1 Docker auth: structural auths.*.auth inspection, with snapshot regressions. #2 YAML merges: bounded expansion retaining environment context, with merged-name/value/sequence regressions.
Review 11: #1 Docker short/long/non-ASCII auth: structural inspection and corresponding snapshot regressions.

All 30 original critical/high reproductions have code fixes and regression assertions that would reject those cases if the relevant protection were removed. The broader credential boundary remains incomplete below. Review 11's medium reader-race fix also remains incomplete under sustained writes.

I established no new broker approval bypass, gate/evidence forgery, concurrent-writer ledger corruption or loss of an acknowledged ledger entry. Complete writes, fsync, head repair and serialized ownership support the ledger guarantees; fault tests cover killed writers, competing writers and a killed reclaimer. Current action adapters remain local outbox stubs.

Supplied evidence reports 186 passing unit/fault tests, four passing live tests, successful typecheck and doctor --live, and all 89 mutations caught in a disposable clone. I independently passed typecheck under Node 24.21.0 and reproduced both findings in memory, including XML acceptance through the actual createSnapshot routine with filesystem/Git operations substituted. Filesystem-writing and live suites were not rerun in this read-only checkout. The logs do not establish tests-first development order.

## Remaining for stage 0

- Close the XML credential leak with snapshot-level regressions and mutation coverage, capture fresh verification evidence, and obtain a passing independent review.
- Reopen backlog entry 18 for exhausted ledger-read retries; this medium finding does not independently block approval.
- Save this revision-linked review under docs/reviews/.
- After approval, record at least one valid baseline each for tasks 1, 2 and 11; decision 71 permits second repeats during stage 1.
- Stage 1 completion additionally requires the user-assisted desktop-app plugin check.

## Findings

### 1. [high] XML name/value configuration exposes literal credentials

`packages/cli/src/eval/snapshot.ts:466`

**Scenario.** The XML scanner checks attribute names independently, losing credential context carried by an attribute's value. A tracked spring.xml containing <property name="password" value="Synthetic9qvM2"/> receives no credential hits. Likewise, <properties><entry key="db.password">Synthetic9qvM2</entry></properties> passes because neither entry nor key is classified as sensitive. I reproduced both through createSnapshot with filesystem/Git operations substituted in memory: both were accepted unchanged without allowSecretsIn. A task can therefore read the literal password from its sanitized workspace.

**Fix.** Inspect XML configuration structurally, carrying credential names from name/key attributes to the associated value attribute or element text. Refuse sensitive structures that cannot be inspected safely. Add snapshot regressions for property/name/value and entry/key/text forms, including XML escapes, plus mutation coverage.

### 2. [medium] Exhausted read retries still classify a healthy ledger as tampered

`packages/cli/src/ledger/ledger.ts:115`

**Scenario.** On the fifth attempt, verifyLedger calls verifyText even when the head changed during the read. A busy writer can therefore exhaust all retries and pair an older ledger snapshot with a newer head. Using the existing afterLedgerRead seam to append on every attempt, I reproduced a tampering result after five interleavings; immediate stable verification passed with all six entries intact. Doctor can falsely report corruption, and Broker.decide can reject a legitimate approval. The regression test covers only one interleaving.

**Fix.** Never classify an unstable snapshot as tampering. Obtain a consistent snapshot under writer coordination, or return a distinct retryable contention outcome after exhausting retries. Add a deterministic regression with an append during every attempt and preserve genuine-mismatch rejection.

## Builder response

See `stage0-codex-12-response.md`.
