# Review runner — independent Opus review

October 24, 2026. Codex authored the runner and reporter changes; Claude is the sole main integrator. This supplemental scoped review does not replace independent Codex stage review, and grants no stage approval.

## Revisions

- `5e6f604`: initial runner, decision-79 lane manifest handling, tests and docs.
- `3dbe6de`: strengthened negative controls for reporter manifests and historical lanes.
- `25008f0`: low-review corrections for source-index preservation, prompt separator, exclusive reservation coverage and recorded setup failures.
- Final frozen code revision: `62517c506508336eddf10363ed7237a300cdec1e`, incorporating main `bbf5f52`. The merge commits import Claude-owned changes only; integration should cherry-pick the three Codex commits above, not the merge commits.

## Review method

Pinned Claude Code 2.1.309, independent `claude-opus-5-5` at high effort. Restricted Read/Glob/Grep only; exact policy written through writeTaskSettings; dontAsk, no permission prompts, strict empty external MCP config, no session persistence, clean child environment. Fresh 21/21 live canary before each review. Neither reviewer implemented the code or ran tests. Reviewer assertions are not verification evidence unless independently checked below.

First review PASS with six low findings. L1 (index refresh), L2 (prompt parsing), L4 (setup failure reporting), and L6 (coverage) were corrected and regression-tested. L3 (prompt-only future folders report missing manifest) follows the integrator's explicit conservative specification, now documented. L5 (Git history retains builder responses) also exists in the prior shell runner and is documented; deleting files is not a confidentiality boundary. No history was rewritten and no historical review severity changed.

The first reviewer claimed the worktree was clean at 5e6f604. This is not supported: tests-only strengthening occurred during that review. Its source hashes were captured before launch; the final follow-up reviews a frozen committed revision and supersedes that claim.

## Deterministic evidence

Initial candidate full suite: 274 passed, 4 live skipped. Final frozen revision: `pnpm test --maxWorkers=1` passed 284 tests / 4 live skipped (283.19 seconds); typecheck, node syntax check and git diff check passed. The final independent follow-up is PASS. All 14 focused mutations classified caught in one complete scoped run, with clean 13-test runner and 30-test reporter baselines, identical test identities and no unhandled errors. This is a focused proof, not a replacement for Claude’s full shared mutation suite. Tests were written before implementation; three new reporter regressions initially failed, and the runner initially did not exist. Low-fix regressions reproduced four failures before corrections. Negative controls exposed two insufficient manifest tests; strengthened assertions now catch them. Controls classify with the existing mutation-classify.mjs, clean baselines, identical test identities, and the unhandled-error reporter, never treating collection/runtime errors as catches.

All fifteen real historical reports (stage0-2 through stage0-16) match pre-change parsed report objects exactly, including stage0-16 FAIL. No review folder was written during this comparison.

## Initial independent verdict (verbatim)

**Verdict: PASS.** I found no critical, high or medium problems. There are six low-severity findings below. This is a supplemental scoped Opus review, not independent Codex stage approval.

I reviewed the code by reading it only; I didn't run any tests. The files I read match your diff, and the worktree is clean at 5e6f604.

## Findings

**L1 (low): `git status` on the source repo can rewrite `.git/index`** — `scripts/review-run.mjs:61`
- **Scenario:** touch a tracked file without changing it (for example `touch README.md` in the source repo), then run the runner, even with `--dry-run`. `git status` refreshes cached file timestamps and rewrites the source repo's `.git/index`, taking a lock while it does. Your own Git command running at the same moment can fail with "index.lock exists". Working-tree files are never touched, but the dry run isn't strictly read-only.
- **Fix:** pass `env: { GIT_OPTIONAL_LOCKS: '0' }` to `safeGit` for the `status` call, or put `--no-optional-locks` before `status`.

**L2 (low): the prompt is passed to Codex without a `--` separator** — `scripts/review-run.mjs:105`
- **Scenario:** `prompt-A.md` starts with `---` (YAML front matter, or a markdown rule). Codex's argument parser sees an unknown option and the lane exits nonzero. A prompt starting with `-c…` would be read as a config override. This fails closed and prompts come from the operator, so it's a robustness issue.
- **Fix:** add `'--'` before `texts[l]`, and check in the fake-Codex test that `--` comes just before the last argument.

**L3 (low): staging prompts in the round folder now shows that round as FAIL** — `scripts/review-status.mjs:62-63,75`
- **Scenario:** follow `docs/review-run.md` and put `prompt-{A,B,D}.md` and `schema.json` in `~/.jarvis/codex-review/stage0-17` before launching. `review-status` then reports stage0-17 as FAIL with `missing lane manifest`. Before this change it showed queued/PENDING. This errs on the safe side, but it's misleading.
- **Fix:** only require a manifest when the folder holds something other than `prompt-[A-D].md` and `schema.json` (the same rule the runner's pre-flight check uses). Otherwise show it as queued.

**L4 (low): a crash after reserving the round looks queued forever** — `scripts/review-run.mjs:77-92`
- **Scenario:** the committed tree contains `.review-evidence/`, so `mkdirSync` at :91 throws. A clone failure, or `docs/reviews` committed as a symlink (:87), has the same effect. The runner exits 1, but `lanes` and an empty `status` remain, so status shows queued/PENDING indefinitely. The docs disclose crash leftovers, so this is low.
- **Fix:** wrap everything after the reservation in try/catch, append a final marker such as `runner-error` (status already treats unknown markers as FAIL), then rethrow.

**L5 (low): reviewers can read builder responses through Git** — `scripts/review-run.mjs:85-89`
- **Scenario:** a reviewer runs `git status` or `git diff` in the workspace. The deleted `*-response.md` files show up, and `git diff` prints their full text. `git show HEAD:docs/reviews/…` also works. The files are removed only from disk, which meets the stated requirement. I couldn't check whether the old shell runner behaved the same way.
- **Fix:** after deleting, run `git update-index --skip-worktree` on those paths so status and diff don't show them, and note in the docs that history still contains them.

**L6 (low): some tests can't fail when the code they check is broken**
- **Lane-manifest tests** (`tests/unit/review-status.test.ts:255-262`): each bad-manifest case reuses a status file that already contains `lane C exit 0`. An invalid manifest also triggers the "lacks required lanes A,B,D" problem. So deleting the duplicate-letter check, deleting the `$` anchor in the manifest pattern, or deleting the `invalid lane manifest` problem would all leave every test green.
  - **Fix:** use an A,B,D-only status in these cases and check for the specific problem text.
- **Reservation test** (`tests/unit/review-run.test.ts:98-103`): the first `runReview` call runs all the way through the clone before the second call starts. The second call is then rejected by the `workspace already exists` check, so the exclusive `lanes` creation is never tested.
  - **Fix:** make two direct exclusive writes to `lanes`, or pre-create the workspace in a way that forces the round check to be what fails.
- **Untested guard:** nothing tests the `docs/reviews` symlink refusal at :87.

## Requirements that check out
- **Historical rounds:** stage0-2..15 single-lane rounds without a manifest are unchanged (the undeclared-lane check is a no-op for `single`). stage0-16 without a manifest still requires A, B, C and D, and its lane C high finding still fails. New rounds require A, B and D, an extra C must pass, and a malformed, duplicated, empty or extra-line manifest fails. A completion marker for an undeclared lane also fails.
- **Source repo:** dirty repos are refused before any files are created. The clone is made with `--no-hardlinks`, origin is removed, it's detached at the captured commit and the commit is re-checked. All Git calls go through `safeGit`, and the file-transport override applies to the clone command only.
- **No overwrites:** logs, events, stderr, `lanes`, `status` and `workspace.txt` are all created with exclusive-create, the round folder may only contain prompts and schema beforehand, and an existing workspace is refused. The output-folder symlink checks and the outside-the-repo check are present.
- **Evidence:** six commands run in order, terminal codes are stripped, an `exit <n>` footer is always added, and a failure persists even if later steps pass.
- **Lanes:** they run concurrently with stdin from `/dev/null`, `--sandbox read-only` and `--ephemeral`. Codex gets exactly HOME, USER, PATH and CODEX_HOME. The runner exits 1 unless status reports PASS, and it prints every verdict path.

## Limitations
- I had read-only file tools, so I couldn't run vitest or any mutation checks. The surviving test mutants in L6 come from tracing the code by hand.
- Permission to read `~/.jarvis/codex-review` was denied, so I couldn't confirm that no historical round other than stage0-16 has `prompt-[A-D].*` or `verdict-[A-D].*` files. Any such round would newly fail with `missing lane manifest`.
- **Not defects, but worth knowing:**
  - Evidence commands run with the real HOME, so pnpm and the live checks can read files like `~/.npmrc` and stored credentials. The runner itself reads none, but the docs' "No secret file is read" line (`docs/review-run.md:14`) should say that.
  - Nothing times out: a hung evidence command or lane blocks the run.
  - The runner needs a Node version that can import `.ts` files directly, and the default Codex launcher depends on `node` being found in `/opt/homebrew/bin`.
  - Manifest lane order is kept as given: `--lanes D,B,A` is accepted as written.

## Final independent follow-up (verbatim)

**Verdict: PASS.** None of the scoped changes has a remaining actionable finding.

I read `scripts/review-run.mjs`, `tests/unit/review-run.test.ts`, `tests/unit/review-status.test.ts` and `docs/review-run.md`. I also read `tests/fixtures/fake-review-codex.mjs`, `safeGit` in `packages/cli/src/eval/git.ts`, and the manifest and status parts of `scripts/review-status.mjs`. I only had read and search tools, so I ran no tests, mutations or git commands. I didn't check the file hashes against `request.json`. The working tree was clean at 62517c5 when the session started, and that is the state I read.

**How each fix checks out**

- **`--no-optional-locks`** (`review-run.mjs:64`): `safeGit` puts its config flags before the caller's arguments, so this global option still comes before `status`, where git expects it. The test (`review-run.test.ts:127-133`) changes `source.txt`'s timestamp, does a dry run, and compares the index bytes. Without the flag, `git status` would rewrite the index, so the test would catch its removal.
- **`--` before the prompt** (`:109`): it sits right before the prompt text. The test checks `argv.at(-2) === '--'`, and the fake still reads the prompt from `argv.at(-1)` (that is how its FAIL control works).
- **`runner-error`** (`:82-119`): The try block covers everything from cloning to `inspectReviews`. Reserving the manifest and creating `status` happen before the try, so a second starter that loses the race throws without writing to the winner's `status`.
  - The reporter turns `runner-error` into FAIL in two ways. It counts as an "Unrecognized status marker", or, if it comes after `codex-done`, as a "Status marker after review completion".
  - The test commits a `.review-evidence` directory, which makes setup fail with EEXIST. It then checks that `runner-error` is in `status` and that the reporter says FAIL.
- **`reserveLaneManifest`** (`:18-20`): it uses an exclusive create (`wx`). The test calls it twice in a bare directory and expects the second call to fail with EEXIST, with the content unchanged. It would catch a version that silently overwrites the manifest.
- **Symlinked `docs/reviews`** (`:89-93`): `home` is fully resolved and the output directories are already checked for symlinks. So a symlink anywhere in `docs` or `docs/reviews` makes the resolved path differ, and the run refuses before deleting anything. A broken link fails to resolve, which also ends in `runner-error`. The test fails if the refusal is missing.
- **Reporter assertions** (`review-status.test.ts:277-289`): they check the exact "required lanes D" message and "invalid lane manifest" with all other evidence passing. The historical lane C check uses `?.findings.high`, so a missing lane now fails as an assertion instead of a TypeError. That matches what you described.
- **Docs**: they agree with the code on the four Codex environment keys plus macOS's own key, the `runner-error` behaviour, no timeout, possible leftover child processes, deleted response files still in Git history (L5), and the prompt-only `missing lane manifest` result (L3).

**Optional, not blocking:** in the symlink test, the last assertion (`review-run.test.ts:152`) can never fail. The symlink is relative (`real-reviews`), so inside the clone it points at the clone's own copy, and the source repo's `docs/real-reviews/old-response.md` could never be deleted by the runner. The `rejects.toThrow(/symlink/)` line already catches removal of the check. To make the last line meaningful, either assert that the clone's `docs/real-reviews/old-response.md` survives, or use an absolute symlink pointing into the source repo.

This review is advisory and doesn't approve the stage. I didn't edit anything.

## Final reviewed file identities

Revision `62517c506508336eddf10363ed7237a300cdec1e`. Codex independently rehashed every file after the follow-up; all matched. Report markdown was subsequently added outside this reviewed scope.

| File | SHA-256 |
|---|---|
| `scripts/review-run.mjs` | `4c95ec71fe8d20780ca85429d6b98263a8ee2e2c1d4e5130be6cb43508695c3c` |
| `scripts/review-status.mjs` | `b02d174e448316c66de60f0fa6721545a17c0d51e2aad9caf39af2f8a029dbe0` |
| `tests/unit/review-run.test.ts` | `05aa509717d7b7d99d9033ea0ae1a0bd3eeb5be87e90135d8ca88ad6b2dcd43b` |
| `tests/unit/review-status.test.ts` | `3ab6ca68171cf789c60ab671703f5aca4aeea7f2fd33778578f42b8f69cfa9c8` |
| `tests/fixtures/fake-review-codex.mjs` | `270c151e02e4443d962984fe67817fcf4fd0461b3cc648e599b6442919fc47b7` |
| `docs/review-run.md` | `3485aa738534f73ead41487587eef492a3df6d0c0bfae2a54d18c8a4736df1c8` |
| `docs/review-status.md` | `ae2165e0af0dea2ea7fb4fc90a86022fd3359db3e99bfe485175af035603cdb8` |

Raw initial review/canary/request/outcome: `/private/tmp/jarvis-review-run-qqwRqg/`. Final follow-up/canary/request/outcome: `/private/tmp/jarvis-review-run-ithZOW/`. Both sessions reported apiKeySource none, dontAsk, and only Glob/Grep/Read. These runtime artifacts are temporary; verdict text, source hashes and verification summary are preserved here.

## Final mutation evidence

One complete scoped run: `/private/tmp/jarvis-run-controls-gd6VY6/results.json`. Exact mutation anchors/replacements are committed in `review-run-mutations.json`; `fourth review lane ignored` replaces the existing shared control, thirteen others are additions.

| Mutation | Classification |
|---|---|
| review manifest ignored | caught |
| review required lanes ignored | caught |
| fourth review lane ignored | caught |
| review manifest validation bypassed | caught |
| review runner inherits parent environment | caught |
| review runner accepts dirty source | caught |
| review runner exposes builder response | caught |
| review runner loses lane failure | caught |
| review runner gives writable sandbox | caught |
| review runner loses evidence failure | caught |
| review runner refreshes source index | caught |
| review runner parses prompt as flags | caught |
| review runner overwrites lane reservation | caught |
| review runner hides setup failure | caught |

## Verification scheduling failure retained

A concurrent full-suite attempt on the final code failed two timing-sensitive existing ledger/broker tests (282 passed / 2 failed / 4 skipped), and a simultaneous focused baseline timed out. Neither is counted as passing evidence. Main-side overlapping mutation processes were stopped by their owner. With a quiet slot and serialized checks, the unchanged source passed all 284 tests and then all 14 focused controls. No timeout or safeguard was weakened. Final full log: `/tmp/jarvis-run-serial-full.log`; final controls log: `/tmp/jarvis-run-controls-quiet.log`.
