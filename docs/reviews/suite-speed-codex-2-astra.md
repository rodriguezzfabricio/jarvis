**FAIL — independent verification**

Head: `fec7eaf844ff8958e78819cb5187bed8cf95feb0`  
Base: `21003f65e5f0cde244a2294a3a914637933bdffe`

same-family review; Claude cross-review pending

**F1 — P1: the required fresh-clone full suite fails in a newly added test.** In [real-git-native.test.ts](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/repo/tests/unit/real-git-native.test.ts:13), each API probe must finish within 10 seconds. Its helper runs 15 comparison scenarios twice, sequentially. With the unmodified head and default full-suite execution, the `execFileSync` probe was killed with `ETIMEDOUT`; the assertion at line 15 failed. Installation and typecheck had completed. The suite exited **1**, with **1 failed, 3,629 passed, 16 skipped** tests. See [failure](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1261), [timeout diagnostic](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1269), [counts](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1293) and [exit](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1300). The same failure and counts occurred in a second exact-head fresh clone supplied by the host in response to request 005: [repeat failure](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/second-independent-head-suite.log:1294), [repeat counts](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/second-independent-head-suite.log:1326), [repeat exit](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/second-independent-head-suite.log:1336).

This is a reproducible acceptance failure in the test harness, not evidence that native Git itself behaves incorrectly. The focused tests passed with less competing suite work; that does not satisfy the full-suite requirement. Preserve all scenarios and assertions when addressing the probe's execution budget or scheduling, then rerun the required clean-head checks and confirmation. I made no repository changes.

**Strongest case against acceptance, recorded before deciding.** The changes could make tests faster by replacing the conditions they need to test: copied repositories might differ from real initialization or share mutable data; global setup might intercept native process APIs; reused snapshot workers might misassociate cases; mock ACL output might bypass actual trust checks; compile caching and shorter waits might conceal faults. Test relocation could also lose cases or stop mutation selection from reaching them. Ordinary green tests would not settle those concerns. The pre-verdict case is saved in [strongest-case.md](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/strongest-case.md). Source comparison and targeted faults address much of this risk, but the actual full-suite timeout and absent confirmation prohibit a PASS.

**Execution evidence.** All counted executions came through the host fresh-clone protocol at the exact head above, using Node 24.21.0. The workspace was used only for read-only inspection. Host log headers contain the clone, full SHA, exact argv, start/end times and exit code. I recomputed each supplied log's SHA-256 and matched the host response and supplied manifest rows. [evidence-index.json](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/evidence-index.json) records those checks; [verified-manifest-rows.tsv](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/verified-manifest-rows.tsv) contains only the relevant rows from the host's `/Users/fabriciorodriguez/.jarvis-work/handoff/evidence/MANIFEST.tsv` mirror.

| Check | Observed result | Log evidence |
|---|---|---|
| `pnpm install --frozen-lockfile`, then `pnpm typecheck`, then `pnpm test` under `set -e` | Install/typecheck succeeded; test exited 1, counts above | [exact command and SHA](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1); [install and typecheck](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:20); [suite exit](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1300) |
| Second independent fresh-clone install/typecheck/test | Same failure, same counts, exit 1 | [exact command](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/second-independent-head-suite.log:3); [result](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/second-independent-head-suite.log:1326) |
| Request 003 focused controls and faults | Experiment driver exited 0; both clean controls passed 53 tests; 13 selected faults each produced the expected assertion failures | [first green](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:19); [faults](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:20); [restored green](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:33) |
| Request 004 SIGKILL polling check | Green 0 → disabled escalation 1 by assertion → restored green 0 | [green](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-004-head-escalation-biting-test.log:40); [red](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-004-head-escalation-biting-test.log:106); [restored](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-004-head-escalation-biting-test.log:128) |
| V8 random spot-check: `pnpm typecheck` after fresh installation | Exit 0; agrees with first run | [command](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-004-random-spot-check-typecheck.log:3); [result](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-004-random-spot-check-typecheck.log:22) |
| `node scripts/mutation-check.mjs --confirm-stage 0-1` | **UNVERIFIED: not run.** Host declined expensive confirmation after the ordinary failure. No exit code or catch count is claimed | [host response](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/response-002.json:2) |
| Additional ACL fault experiment, request 006 | **UNVERIFIED: not run.** Host deferred further testing of this failing head | [host response](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/response-006.json:2) |

The repeat full-suite log was an independently requested run already executing when request 005 arrived; the host supplied its raw log instead of scheduling a third duplicate. Its exact argv is disclosed above. It is corroboration, not the V8 selection. The random selection used `node:crypto.randomInt(3)` over install, typecheck and test; [spot-check-selection.json](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/spot-check-selection.json) records the selection before request 004.

Log hashes:

| Log | SHA-256 |
|---|---|
| suite-speed-2-astra-request-001-head-install-typecheck-test.log | `6518d5611eff61c5503c6a6faf993aadcaee61d7b6d657bd033f783969422ba9` |
| second-independent-head-suite.log | `590944aa0f367add19abd47bc8d04927a5590fb4cff9d56a4dd21a61026db294` |
| suite-speed-2-astra-request-003-head-targeted-biting-tests.log | `1fc6512e4410c00f15f2abd2403d4516fb958a32196f2e8de68a1711236c09ca` |
| suite-speed-2-astra-request-004-random-spot-check-typecheck.log | `3466a871c27a3b8456a12691821d9e636d1f7e366bc5e2f60c99431bb984d7bd` |
| suite-speed-2-astra-request-004-head-escalation-biting-test.log | `fdbf5d771059263f2ec12c83aef6b8410588dea68e287f2ee2510b8443d4b063` |

**Biting-test evidence.** The 19 newly introduced cases are the six fixture tests, five native API tests, five native/setup tests and three decision CLI regressions. All were green in the 53-test control and restored control. Every one was observed failing by assertion under the relevant fault below. Patches were applied only in the host's disposable experimental clone and restored in `finally`. Exact scripts are in [request-003.json](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/request-003.json) and [request-004.json](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/request-004.json); individual commands, times, exit codes, test names and assertion messages are logged.

| Guarded behavior | Verifier-selected fault | Assertion failures / evidence |
|---|---|---|
| Template branch equivalence, both identity variants | Disable branch-specific HEAD update | 2, [line 20](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:20) |
| Fixture storage independence | Replace recursive copy with shared .git symlink | 1, [line 21](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:21) |
| Runner Git hooks disabled | Remove `core.hooksPath=/dev/null` | 1, [line 22](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:22) |
| Runner Git fsmonitor disabled | Remove `core.fsmonitor=false` | 1, [line 23](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:23) |
| Runner Git global configuration disabled | Remove `GIT_CONFIG_GLOBAL=/dev/null` | 1, [line 24](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:24) |
| Native execution/API identity for all five APIs | Wrap Node process functions | 5, [line 25](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:25) |
| Native path, caller environment and inert context | Redirect bare Git, overwrite CPATH, supply nonempty context | 5, [line 26](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:26) |
| Decide and why preserve uncaught command stacks | Normalize child stderr to its first line in each harness | 1 each, [line 27](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:27) and [line 28](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:28) |
| Decide handles malformed rows without uncaught parser stack/write | Rethrow instead of `command.error` | 1, [line 29](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:29) |
| Shorter descendant observation still catches missing cleanup | Remove `await cleanupGroup()` | 1, [line 30](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:30); unmodified case passed at [full-suite line 756](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:756) |
| Atomics wait still holds payload until onSpawn approves | Release child before invoking onSpawn | 1, [line 31](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:31); unmodified case passed at [full-suite line 649](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:649) |
| Reused workers still detect scanner acceptance | Disable snapshot credential refusal | Both snapshot halves failed, [line 32](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-003-head-targeted-biting-tests.log:32); unmodified halves passed at [full-suite line 1208](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1208) and [line 1211](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:1211) |
| Bounded SIGKILL polling still detects absent escalation | Disable the SIGKILL callback | Green/red/green, [lines 40, 106, 128](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-004-head-escalation-biting-test.log:40) |

These selected experiments establish specific assertion sensitivity. They are **not** mutation-gate evidence: no `--confirm` or `--confirm-stage` completed successfully, and no filtered/fast run is counted as confirmation.

**Equivalence and coverage assessment.** The base-to-head diff has no production or mutation-script changes. `eval/git.ts` retains its clean environment, disabled hooks/fsmonitor, and native `execFileSync`. Gate and worktree operations still call that interface; copied-repository helpers are test-only. The new planted-command tests also execute the same commands without runner restrictions as positive controls, so an inert planted command cannot pass those tests accidentally.

The relocated checks-2→checks-3 (137-line tail), probe-2→probe-3 (84-line tail), runner-loop-4→8 (37-line tail), and runner-loop-5→9 (49-line tail) blocks compare byte-for-byte. Their hooks, skips and surrounding describe policies were inspected separately. The 73-line runner-loop-6→7 block differs only in the SIGKILL fixed-wait/polling change; its fault check is reported above. These are explicitly equivalence-preserving relocations, not newly added behavioral coverage. [static-audit.txt](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/out/static-audit.txt) records the exact comparisons, including the non-identical polling block.

Three ACL seam call sites reduce repeated real discovery and are labeled justified weakening below. Existing `setup-acl.test.ts` still exercises invalid/unreadable/inherited ACLs and real macOS `chmod +a`/`/bin/ls`; all 14 cases passed in the ordinary suite ([line 749](/Users/fabriciorodriguez/.jarvis-work/verification/suite-speed-2-astra/evidence/suite-speed-2-astra-request-001-head-install-typecheck-test.log:749)). The separately requested ACL fault experiment was not run, so its sensitivity is unverified. Ownership, modes and symlinks are still checked against actual filesystem state.

Tests-first chronology is not inferred from endpoint files or prose. No production safety, ledger or settings implementation changed in this diff; the added test infrastructure was checked with the faults above. The six permanent safety policies and existing mutation anchors are unchanged. Their complete confirmation remains unverified.

No base/head speed comparison was run, and this verdict makes **no suite-speedup claim**, including the microtiming claims in source comments. The new AGENTS setup description matches the inert implementation. The allowed changed documentation about host process lifetimes and guarded-stop orchestration describes external operations; these tests do not prove those claims. Prior verdicts and the prohibited decision sections were excluded from the review.

Protocol limitation: the host-supplied shared manifest contained unrelated prior-SHA command metadata, which was inadvertently displayed once. I then filtered it to the cited exact-head records and did not use those historical rows or open their logs. No builder transcript, auth file, private eval material or prior verdict was opened. Only the raw second exact-head check expressly supplied through response 005 was used as corroboration. This is one verifier's FAIL, not certification of the second-verifier or integration requirements.

**Complete hunk audit follows.** Every hunk under tests/, tests/setup/, fixtures, vitest.config.ts and scripts/mutation-*.mjs is enumerated. No unchecked or unperformed command is treated as PASS.


Complete anti-tamper hunk audit for 21003f65e5f0cde244a2294a3a914637933bdffe..fec7eaf844ff8958e78819cb5187bed8cf95feb0

Generated from git diff --no-ext-diff --unified=3 BASE HEAD -- tests vitest.config.ts scripts/mutation-*.mjs. Every relevant hunk is listed. No scripts/mutation-*.mjs or tests/fixtures file changed; no production code, six permanent safety settings or hidden-check file changed. Classification is based on source inspection; command outcomes are reported separately.

| ID | Path | Hunk (base to head) | Classification | Reason |
|---|---|---|---|---|
| 1 | tests/setup/real-git-global.ts | @@ -0,0 +1,15 @@ | Neutral | Provides empty compatibility values and only a TypeScript context declaration; no executable discovery or redirection. |
| 2 | tests/setup/real-git.ts | @@ -0,0 +1,5 @@ | Neutral | Calls inert useRealGit with those empty values; native child_process remains in place. |
| 3 | tests/setup/use-real-git.ts | @@ -0,0 +1,3 @@ | Neutral | No-op compatibility entry point; neither Node APIs nor environment are patched. |
| 4 | tests/unit/broker-server.test.ts | @@ -69,13 +69,15 @@ | Neutral | Adds per-file Node compile cache to real broker children; process, signals and assertions remain real. |
| 5 | tests/unit/broker-server.test.ts | @@ -94,7 +96,7 @@ | Neutral | Same compile-cache environment for act; exit and socket diagnostic assertions unchanged. |
| 6 | tests/unit/broker-server.test.ts | @@ -107,7 +109,7 @@ | Neutral | Same compile-cache environment for empty-socket broker cases; assertions unchanged. |
| 7 | tests/unit/checks-1.test.ts | @@ -1,4 +1,4 @@ | Neutral | Split-count comment only. |
| 8 | tests/unit/checks-2.test.ts | @@ -1,13 +1,11 @@ | Neutral | Split-count comment and imports adjusted to match test relocation; hook and describe limits unchanged. |
| 9 | tests/unit/checks-2.test.ts | @@ -15,7 +13,6 @@ | Neutral | Blank line removal only; no timeout change. |
| 10 | tests/unit/checks-2.test.ts | @@ -104,141 +101,4 @@ | Neutral | Nine gate tests relocated intact to checks-3; byte-for-byte block comparison. Existing macOS skips preserved. |
| 11 | tests/unit/checks-3.test.ts | @@ -0,0 +1,153 @@ | Neutral | Receives the same nine gate tests, setup hook and 120-second describe/hook limits. No newly skipped case. |
| 12 | tests/unit/cli-approvals.test.ts | @@ -10,6 +10,8 @@ | Neutral | Declares a per-file compile cache; does not replace child CLI execution. |
| 13 | tests/unit/cli-approvals.test.ts | @@ -19,13 +21,13 @@ | Neutral | Enables compile caching for child approvals CLI and help; assertions and real command registration unchanged. |
| 14 | tests/unit/commands-gate.test.ts | @@ -10,6 +10,7 @@ | Neutral | Imports copied-repository helper. |
| 15 | tests/unit/commands-gate.test.ts | @@ -37,8 +38,8 @@ | Neutral | Replaces fixture init/config only; same branch/identity, subsequent add/commit and gate assertions remain real. |
| 16 | tests/unit/decisions-decide.test.ts | @@ -1,7 +1,9 @@ | Added coverage | Imports Commander and vi for explicit uncaught-error regression; existing assertions unchanged. |
| 17 | tests/unit/decisions-decide.test.ts | @@ -16,6 +18,8 @@ | Neutral | Loads Commander prototype for fault seam and declares compile cache; original child command script retained. |
| 18 | tests/unit/decisions-decide.test.ts | @@ -41,7 +45,7 @@ | Neutral | Child process still runs; adds only compile-cache directory to its environment. |
| 19 | tests/unit/decisions-decide.test.ts | @@ -168,3 +172,39 @@ | Added coverage | Asserts uncaught command stack and controlled malformed-register errors/no write. Finally restores spy and NODE_OPTIONS; no catch-and-ignore. |
| 20 | tests/unit/decisions-why.test.ts | @@ -1,8 +1,10 @@ | Added coverage | Imports Commander and vi to inject and observe uncaught-error regression. |
| 21 | tests/unit/decisions-why.test.ts | @@ -16,9 +18,11 @@ | Neutral | Loads fault seam and adds compile cache while retaining real child execution. |
| 22 | tests/unit/decisions-why.test.ts | @@ -97,3 +101,26 @@ | Added coverage | Asserts uncaught failure status, empty stdout, diagnostic and stack; finally restores spy/environment. |
| 23 | tests/unit/eval-jarvis-fixture.ts | @@ -15,6 +15,7 @@ | Neutral | Imports copied-repository helper. |
| 24 | tests/unit/eval-jarvis-fixture.ts | @@ -96,7 +97,7 @@ | Neutral | Changes only source fixture init; real snapshot/add/commit/evaluation assertions retained. No hidden check edit. |
| 25 | tests/unit/eval-jarvis-grade.test.ts | @@ -9,6 +9,7 @@ | Neutral | Imports copied-repository helper. |
| 26 | tests/unit/eval-jarvis-grade.test.ts | @@ -21,7 +22,7 @@ | Neutral | Changes only synthetic repo init; buggy/fixed contents, commits and grading assertions unchanged. |
| 27 | tests/unit/helpers/checks-fixture.ts | @@ -7,6 +7,7 @@ | Neutral | Imports copied-repository helper. |
| 28 | tests/unit/helpers/checks-fixture.ts | @@ -21,10 +22,7 @@ | Neutral | Equivalent main-branch/identity fixture creation; real commits and sandboxed gate remain. |
| 29 | tests/unit/helpers/git-repo.ts | @@ -0,0 +1,31 @@ | Neutral | Per-file template cache; copies .git, selects branch, removes templates in afterAll; no changed production git path. |
| 30 | tests/unit/helpers/git-template.ts | @@ -0,0 +1,26 @@ | Neutral | Builds real native Git template in clean environment and deep-copies files; branch HEAD set explicitly. Exact files/modes and isolation have new tests. |
| 31 | tests/unit/helpers/native-git-probe.mjs | @@ -0,0 +1,81 @@ | Added coverage | Native API comparison probe includes PATH/cwd/environment, shell and error cases. Catch converts errors to compared records, not success; identity and full case list asserted by caller. |
| 32 | tests/unit/helpers/no-acl.ts | @@ -0,0 +1,6 @@ | Neutral | Defines explicit no-ACL fixture seam; no production ACL logic changed. Integration reduction at its call sites is separately labeled. |
| 33 | tests/unit/helpers/review-service-fixture.ts | @@ -9,6 +9,7 @@ | Neutral | Imports copied-repository helper. |
| 34 | tests/unit/helpers/review-service-fixture.ts | @@ -18,7 +19,8 @@ | Neutral | Creates master fixture by template; later safeGit add/commit/review behavior unchanged. |
| 35 | tests/unit/helpers/runner-loop-fixture.ts | @@ -1,6 +1,6 @@ | Neutral | Removes mkdir import after fixture creation moves to helper. |
| 36 | tests/unit/helpers/runner-loop-fixture.ts | @@ -9,6 +9,7 @@ | Neutral | Imports copied-repository helper. |
| 37 | tests/unit/helpers/runner-loop-fixture.ts | @@ -16,9 +17,9 @@ | Neutral | Replaces empty main repo init only; safeGit is retained for all candidate operations. |
| 38 | tests/unit/helpers/runner-worktrees-fixture.ts | @@ -1,9 +1,10 @@ | Neutral | Adjusts filesystem import and imports copied-repository helper. |
| 39 | tests/unit/helpers/runner-worktrees-fixture.ts | @@ -11,8 +12,7 @@ | Neutral | Preserves run-branch fixture; real worktree operations and assertions unchanged. |
| 40 | tests/unit/helpers/setup-run-fixture.ts | @@ -11,6 +11,7 @@ | Neutral | Imports explicit no-ACL seam. |
| 41 | tests/unit/helpers/setup-run-fixture.ts | @@ -59,7 +60,7 @@ | Weakening (justified) | Stops real ACL discovery in broad setup fixtures. Ownership/mode/symlink checks remain real; extra.acl overrides still work; dedicated setup-acl tests retain malformed/unreadable/inherited cases and a real chmod+/bin/ls test. |
| 42 | tests/unit/helpers/snapshot-fixture.ts | @@ -6,8 +6,11 @@ | Neutral | Imports worker compatibility context and real Git template helpers. |
| 43 | tests/unit/helpers/snapshot-fixture.ts | @@ -15,9 +18,7 @@ | Neutral | Preserves main and t/t@t identity for source repo; commits/remotes/fixture contents unchanged. |
| 44 | tests/unit/helpers/snapshot-fixture.ts | @@ -146,28 +147,42 @@ | Neutral | One outstanding case per reused worker, results stored by original index, error/exit reject, finally terminates workers. Credential case list/assertions unchanged. Rejection on unexpected exit is retained, not ignored. |
| 45 | tests/unit/probe-1.test.ts | @@ -1,4 +1,4 @@ | Neutral | Split-count comment only. |
| 46 | tests/unit/probe-2.test.ts | @@ -1,11 +1,9 @@ | Neutral | Adjusts split comment/imports; original fixture cleanup retained. |
| 47 | tests/unit/probe-2.test.ts | @@ -67,88 +65,4 @@ | Neutral | Sixteen probe tests moved intact to probe-3; byte-for-byte body comparison. |
| 48 | tests/unit/probe-3.test.ts | @@ -0,0 +1,99 @@ | Neutral | Same fake-Claude probe tests and both root cleanups; no live Claude enabled or weaker assertions. |
| 49 | tests/unit/real-git-fixtures.test.ts | @@ -0,0 +1,71 @@ | Added coverage | Six tests: exact native files/modes/branch/identity, independent fixture storage, and planted hook/fsmonitor/global config negative and positive controls. |
| 50 | tests/unit/real-git-native.test.ts | @@ -0,0 +1,21 @@ | Added coverage | Five API parity tests, exact cases and original function identities. New 10-second child cap is not a raised existing timeout, but caused observed ordinary-suite failure (finding F1). |
| 51 | tests/unit/real-git-redirect.test.ts | @@ -0,0 +1,57 @@ | Added coverage | Five tests for native executable resolution, environment/cwd and inert setup; no conditional coverage or catch-and-ignore. |
| 52 | tests/unit/review-evidence.test.ts | @@ -8,6 +8,7 @@ | Neutral | Imports copied-repository helper. |
| 53 | tests/unit/review-evidence.test.ts | @@ -49,7 +50,8 @@ | Neutral | Changes only empty master fixture initialization; review evidence assertions remain unchanged. |
| 54 | tests/unit/runner-loop-1.test.ts | @@ -1,4 +1,4 @@ | Neutral | Split-count comment only. |
| 55 | tests/unit/runner-loop-2.test.ts | @@ -1,4 +1,4 @@ | Neutral | Split-count comment only. |
| 56 | tests/unit/runner-loop-3.test.ts | @@ -1,4 +1,4 @@ | Neutral | Split-count comment only. |
| 57 | tests/unit/runner-loop-4.test.ts | @@ -1,10 +1,10 @@ | Neutral | Split comment and type-only import moved with tests. |
| 58 | tests/unit/runner-loop-4.test.ts | @@ -39,40 +39,3 @@ | Neutral | Six tests moved byte-for-byte to runner-loop-8; catch returns error subsequently asserted, unchanged. |
| 59 | tests/unit/runner-loop-5.test.ts | @@ -1,11 +1,11 @@ | Neutral | Adjusts comment/imports for moved review verdict tests. |
| 60 | tests/unit/runner-loop-5.test.ts | @@ -44,52 +44,3 @@ | Neutral | Six tests and their review helper moved byte-for-byte to runner-loop-9. |
| 61 | tests/unit/runner-loop-6.test.ts | @@ -1,11 +1,11 @@ | Neutral | Adjusts comment/imports for moved attempt bookkeeping tests. |
| 62 | tests/unit/runner-loop-6.test.ts | @@ -82,77 +82,3 @@ | Neutral | Nine bookkeeping tests moved to runner-loop-7; only SIGKILL observation changes from fixed wait to bounded polling. |
| 63 | tests/unit/runner-loop-7.test.ts | @@ -0,0 +1,84 @@ | Neutral | Same nine assertions/cases; vi.waitFor polls same SIGKILL assertion with original 1300ms deadline. Its caught assertion is retried only to that deadline and propagated on failure; targeted green/red/green completed (request 004). |
| 64 | tests/unit/runner-loop-8.test.ts | @@ -0,0 +1,49 @@ | Neutral | Same six runner-loop-4 tests and afterEach cleanup; unchanged error-catching assertion flow. |
| 65 | tests/unit/runner-loop-9.test.ts | @@ -0,0 +1,58 @@ | Neutral | Same six runner-loop-5 tests, review helpers and afterEach cleanup. |
| 66 | tests/unit/runner-review-errors.test.ts | @@ -8,6 +8,7 @@ | Neutral | Imports copied-repository helper. |
| 67 | tests/unit/runner-review-errors.test.ts | @@ -24,7 +25,7 @@ | Neutral | Equivalent empty main fixture; actual runner/review calls and assertions unchanged. |
| 68 | tests/unit/session-1.test.ts | @@ -47,10 +47,10 @@ | Neutral | Descendant touch at 1s instead of 2s, observation at 2s instead of 3s; retains 1s margin and marker assertion. Missing-cleanup fault produced an assertion failure (request 003); no raised timeout. |
| 69 | tests/unit/session-2.test.ts | @@ -27,7 +27,8 @@ | Neutral | Atomics.wait blocks same thread for requested time without CPU spin; held-payload fault produced an assertion failure (request 003). Event-loop blocking semantics retained. |
| 70 | tests/unit/setup-command.test.ts | @@ -7,6 +7,7 @@ | Neutral | Imports explicit no-ACL seam. |
| 71 | tests/unit/setup-command.test.ts | @@ -34,7 +35,7 @@ | Weakening (justified) | Mocks ACL discovery in command setup fixture; all command/permission assertions retained and ACL seam covered by dedicated setup-acl suite including real macOS listing. |
| 72 | tests/unit/setup-trust.test.ts | @@ -10,6 +10,7 @@ | Neutral | Imports explicit no-ACL seam. |
| 73 | tests/unit/setup-trust.test.ts | @@ -43,7 +44,7 @@ | Weakening (justified) | Mocks ACL discovery in runSetup fixtures, with caller overrides still available. This file's direct checkTrustedDir/checkTrustedTree/writePrivateAtomic calls retain native ACL behavior; dedicated adverse/live ACL tests unchanged. |
| 74 | tests/unit/snapshot-1.test.ts | @@ -4,6 +4,7 @@ | Neutral | Imports copied-repository helper. |
| 75 | tests/unit/snapshot-1.test.ts | @@ -117,9 +118,7 @@ | Neutral | Equivalent identity-bearing empty repo for credential refusal/allowlisting; assertions unchanged. |
| 76 | tests/unit/snapshot-1.test.ts | @@ -132,9 +131,7 @@ | Neutral | Equivalent identity-bearing empty repo for UTF-16/binary/env cases; assertions unchanged. |
| 77 | tests/unit/snapshot-1.test.ts | @@ -151,9 +148,7 @@ | Neutral | Equivalent identity-bearing empty repo for binary key/container cases; assertions unchanged. |
| 78 | tests/unit/snapshot-1.test.ts | @@ -188,9 +183,7 @@ | Neutral | Equivalent identity-bearing repos per config case; full case loop and assertions retained. |
| 79 | tests/unit/snapshot-1.test.ts | @@ -202,9 +195,7 @@ | Neutral | Equivalent identity-bearing empty repo for accepted empty/reference/placeholder credentials; assertions unchanged. |
| 80 | tests/unit/snapshot-1.test.ts | @@ -248,9 +239,7 @@ | Neutral | Equivalent identity-bearing empty repo for Redis redaction; assertions unchanged. |
| 81 | tests/unit/snapshot-1.test.ts | @@ -261,9 +250,7 @@ | Neutral | Equivalent identity-bearing empty repo for symlink stripping; assertions unchanged. |
| 82 | tests/unit/snapshot-case-worker.mjs | @@ -1,22 +1,28 @@ | Neutral | Worker becomes message-driven and uses copied Git template; same content encoding, add/commit, createSnapshot and returned message. Existing rejection-to-message conversion unchanged; no fabricated success. |
| 83 | tests/unit/snapshot-false-positives.test.ts | @@ -6,6 +6,7 @@ | Neutral | Imports copied-repository helper. |
| 84 | tests/unit/snapshot-false-positives.test.ts | @@ -35,7 +36,7 @@ | Neutral | Changes only empty snapshot source initialization; actual scanner/snapshot acceptance checks unchanged. |
| 85 | tests/unit/snapshot-scanner-backlog.test.ts | @@ -7,6 +7,7 @@ | Neutral | Imports copied-repository helper. |
| 86 | tests/unit/snapshot-scanner-backlog.test.ts | @@ -32,7 +33,7 @@ | Neutral | Changes only empty snapshot source initialization; actual backlog scanner/snapshot checks unchanged. |
| 87 | vitest.config.ts | @@ -8,6 +8,9 @@ | Neutral | Registers inert context/setup; include pattern, testTimeout, hookTimeout and live opt-in behavior unchanged. |

Three ACL seam call sites reduce repeated integration coverage and are explicitly labeled weakening with a concrete coverage justification. No assertions were removed or loosened, expected values widened, existing timeout increased, new skip/only/todo/it.fails added, or mutation deleted/re-anchored. The two macOS skipIf calls and 120-second limits in checks-3 are unchanged moves from checks-2. Product code has no added VITEST/NODE_ENV branches. New catch-and-compare in native-git-probe is asserted; existing catches in moved runner tests and snapshot workers are unchanged. Polling in runner-loop-7 has the same deadline and propagates the final failed assertion.
