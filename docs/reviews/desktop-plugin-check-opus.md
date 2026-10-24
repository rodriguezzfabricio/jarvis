# Desktop compatibility kit: supplemental independent Opus review

Codex authored the kit. Independent reviewers used pinned Claude Code 2.1.309, `claude-opus-5-5`, high effort, Read/Glob/Grep only, validated restricted settings, clean child environment, and a fresh live canary (21/21 PASS) before each review. This is supplemental review, not independent Codex stage approval. Desktop compatibility itself remains pending Fabricio’s new app session.

## Revisions and evidence

- Initial candidate `b523716edf8ca94583fd92505414532c6eeec0ef`: FAIL, one medium provenance issue and low findings. Artifacts: /private/tmp/jarvis-desktop-opus-huZ62o.
- Follow-up target `d083ba8148c4e39883ea8bd3696696f40698c0b4`: PASS, no remaining actionable correctness or safety findings. Artifacts: /private/tmp/jarvis-desktop-opus-GXnNmS. Both reviewers completed exit 0 without timeout/overflow.
- `c0e89f5` removes one trailing space from `tests/unit/desktop-plugin-check.test.ts`. This landed after follow-up request metadata captured d083ba8. Production hashes remained unchanged; do not describe all review inputs as frozen. The only test-file difference is whitespace (verified by `git diff --ignore-space-at-eol d083ba8 c0e89f5`).

## Validation

- Parser and kit tests failed first with missing modules; revised Bash cases failed against the Read parser; provenance/manifest regression tests failed before fixes.
- Final targeted suite: 19 passed; strict typecheck passed. Full suite intentionally reserved for integrator’s quiet slot, per decision 82.
- Focused negative controls: 13/13 caught by named failed assertions, with passing clean baselines. Definitions are in `desktop-plugin-check-mutations.json`; raw results `/private/tmp/jarvis-desktop-mutations.json`. First driver attempt incorrectly expected Vitest JSON on stdout and reported NOT CAUGHT. Corrected explicit output-file parsing; all controls rerun. No false first-run pass claimed.
- Original forbidden Read protocol capture `/private/tmp/jarvis-desktop-protocol-aohKQy` is marked SUPERSEDED: permissions reject before hook, so not compatibility proof. Decision80 clarified by integrator.
- Replacement protocol capture `/private/tmp/jarvis-desktop-protocol-2opfpn`: fresh canary21/21 PASS, pinned CLI exit0; committed parser returned PASS with receipt/tripwire true. Exact harmless printf command, source jarvis@inline, linked tool result.
- Final prepared end-to-end run: `~/.jarvis/desktop-check/desktop-20261024-1206` (separate from protocol experiment). CLI outcome recorded there; desktop evidence must still be captured.

## Follow-up request hashes

- `packages/cli/src/harness/claude/desktop-evidence.ts`: `e9d48c3f739624cc33897438cce46c5f318513ab77d724a3b7b289466e6c7040` (unchanged)
- `scripts/desktop-plugin-check.mjs`: `412160990740ea8d02497ea2168695b7f22e52cd545e0997eab930b581f6dbb8` (unchanged)
- `tests/unit/desktop-evidence.test.ts`: `ea066acc4157ddca8cf2096f9443f391644a9ed12c4788791c302a076fbfed81` (unchanged)
- `tests/unit/desktop-plugin-check.test.ts`: `7d1e929ade14e106364de0b5d0f2b76af8d1bb12ca57e4d53648909a40588618` (unchanged)
- `docs/desktop-plugin-check.md`: `ea2c66d25d319f793552af05580ecbc0bc8c0f84fc023ab34f3a53d8b19b222f` (unchanged)

## Remaining limitations / integrator backlog

- Dense predicates/style cleanup (initial low9) remains nonbehavioral backlog.
- SDK provenance excludes interactive terminal records, not headless print mode or other SDK hosts. Framework records and runner-owned host files are trusted; this is not cryptographic attestation of app origin.
- Desktop cached plugin path and new SessionStart receipt shape remain unconfirmed until real capture. Mismatch fails closed.
- Prepare output presents desktop steps before CLI, while documentation recommends CLI first; cosmetic. verifyCheck reads CLI files through caller path rather than canonical run.directory; equivalent under trusted host model.

## Initial verdict

**Verdict: FAIL.** There is one Medium provenance gap that can produce a false "desktop" PASS. The rest are Low. This is a supplemental review only. It does not grant stage approval or replace independent Codex stage review. I didn't run tests, typecheck or mutation controls; everything below comes from reading the code.

## What holds up

- **CLI capture stays inside the restricted harness.** It goes through `buildTaskArgs` → `assertSafeTaskArgs` (`desktop-evidence.ts:94`), so `--restricted`, `dontAsk`, an explicit tool list (Bash only), the strict empty MCP config and `--no-session-persistence` are all enforced.
  - Settings come from `writeTaskSettings` with an empty network allowlist.
  - The child environment comes from `buildChildEnv`, which drops `JARVIS_RUN_HEADER`, so the receipt branch runs.
  - A fresh `runCanaryProbe` runs and must report ok before `runSession` (`:87-89`).
  - The `cli-started` marker is written with the `wx` flag, so each run can only capture once (`:85`).
- **The probe command is harmless.** `printf '%s\n' 'npm publish'` matches only `/\b(npm|pnpm|yarn)\s+publish\b/` (`tripwire.mjs:11`), and no earlier rule matches it. If the hook is missing it just prints text.
- **Model prose can't satisfy the checks.** Receipts and denials are only accepted from structured records: `attachment` / `system hook_response`, and a `tool_result` whose `tool_use_id` links to the exact Bash `tool_use`. Text blocks are ignored.
- **Unrelated transcript paths are rejected.** The transcript must sit in the project-directory slug, contain no symlinks, end in `.jsonl`, have one session, and match `cwd === workspace` and `timestamp >= notBefore`. The `jarvis@jarvis` vs `jarvis@inline` attribution also stops the CLI's own transcript being used as the desktop one; `--no-session-persistence` means it isn't written anyway.
- **Failures fail closed.** Malformed, partial or oversized input, missing probe or outcome files, and canary or process failure all produce a failing result. No verdict file is written.

## Findings

**1. Medium: the desktop channel doesn't check where the transcript came from** (`desktop-evidence.ts:35-39`)
- **Failure:** an interactive terminal `claude` session opened in the prepared workspace, with the Jarvis marketplace plugin enabled, produces records the parser can't tell apart from the desktop app's: same `cwd`, slug, `attachment hook_success`, `jarvis@jarvis` attribution and command path. `verifyCheck` would then report desktop compatibility from a non-desktop host.
- The fixture's `entrypoint: 'sdk-cli'` (`desktop-evidence.test.ts:15`) is never checked.
- **Smallest fix:** require that every relevant desktop record has the `entrypoint` value seen in the real prior desktop transcript (confirm it's distinct from the terminal's `cli`). Record it in the result next to `version`, and add a negative test with `entrypoint: 'cli'`.

**2. Open risk, not a defect: the desktop plugin path is unconfirmed** (`desktop-evidence.ts:48,52`)
- Both desktop checks require the hook command to be `node "<repo realpath>/plugin/hooks/…"`.
- If the app runs marketplace plugins from a copy under `~/.claude/plugins/cache/...`, the check can never pass. That fails closed, but would block the check entirely.
- The earlier check (`docs/backlog.md:8`) enabled the plugin through project settings. This kit enables it in the app UI, so the install path may differ.
- Before Fabricio's capture, confirm the `command` field in the prior desktop `hook_success` record. I couldn't read `~/.claude/projects` from this sandbox.

**3. Low: test gaps in the parser**
- Deleting the `jarvis@…` attribution clause (`desktop-evidence.ts:58`) would pass every current test, because no test feeds a desktop transcript with `jarvis@inline` or another plugin's attribution.
- The CLI branch has no negative tests for `init.cwd` mismatch, more than one `init`, plugin `name` mismatch, mixed `session_id`, or a missing CLI hook receipt or denial.
- Desktop `version` consistency and `hookName` checks are also untested.
- **Fix:** add one table-driven negative case for each predicate.

**4. Low: hashes don't cover `plugin.json`** (`scripts/desktop-plugin-check.mjs:18`)
- `plugin/.claude-plugin/plugin.json` can declare extra `hooks` paths, so changing it can alter what runs without tripping the "plugin changed" check.
- **Fix:** add `.claude-plugin/plugin.json` to the hashed list.

**5. Low: symlink check runs after directories are created** (`scripts/desktop-plugin-check.mjs:27`)
- `mkdirSync` runs before the `realpathSync(path) !== path` check. If `~/.jarvis-work` is a symlink, the run folders get created at the symlink's target before the error fires, and the partial run is left behind.
- **Fix:** realpath-check `dirname(path)` before creating the leaf folder.

**6. Low: `settings.json` is written twice** (`desktop-plugin-check.mjs:29` and `desktop-evidence.ts:90-91`)
- `writeTaskSettings` doesn't use the `wx` flag, so capture overwrites the copy made at prepare time. The content is identical and validated, but it goes against the doc's "never overwrite evidence".
- **Fix:** have capture assert the existing file with `assertSafeTaskSettings` instead of rewriting it.

**7. Low: step order burns the manual desktop chat** (`docs/desktop-plugin-check.md:7-16`)
- The desktop chat (step 1–2) comes before the CLI capture (step 3). A canary failure, such as a usage limit, burns the whole run, so Fabricio has to redo the desktop chat as well.
- **Fix:** document the CLI capture as the first step.

**8. Low: the capture-gate test could make a live call** (`desktop-evidence.test.ts:96-113`)
- The test relies on `vi.doMock` catching dynamic imports. If that wiring regresses, the real `runCanaryProbe` (a live model call) would run inside a unit test, and the `rejects.toThrow` assertion could still pass.
- **Fix:** add injectable `probe`/`session` parameters to `captureCompatibility`.

**9. Low (maintainability): dense one-line predicates and vague failure messages**
- `desktop-evidence.ts:36,43,52,58` and `desktop-plugin-check.mjs:37,54` pack many conditions into single lines and use single quotes, which differs from the harness modules.
- They also merge different failures into one message, e.g. `'CLI version, workspace or plugin mismatch'`, which makes diagnosing a failed live run harder.
- **Fix:** split them into named checks, each with its own problem string.

Once #1 is fixed (with a test) and #2 is confirmed against the real desktop record, I'd consider the compatibility-only claim adequately supported. That is still not stage approval.

## Follow-up verdict

**Verdict: PASS.** I found no remaining actionable correctness or safety findings at d083ba8. This is a static read of the five files only. I ran no tests, typecheck or mutants, and this is not stage approval.

**Prior findings, checked against the source:**
- **Medium 1 (terminal transcript could pass): fixed for interactive terminal sessions.**
  - `desktop-evidence.ts:37` rejects the transcript if any relevant record (assistant, user, attachment, system or result) lacks `entrypoint === 'sdk-cli'`, and line 38 reports the entrypoint in the result.
  - The check runs before the workspace, timestamp, version and evidence checks, and the session check at :35 covers the same records. Empty or untyped lines produce no relevant records and fail at :35.
  - The `entrypoint` test case makes every record `cli` and expects a failure.
- **Lows 3–8: fixed.**
  - The negative cases now cover CLI attribution, duplicate init, session, receipt and denial, plus desktop attribution and hookName.
  - `plugin.json` is hashed (`desktop-plugin-check.mjs:18`) and the hash check has a test.
  - Existing ancestors are checked for symlinks before any `mkdir` (:27-31). The test confirms nothing gets created under the symlink target.
  - `captureCompatibility` now validates the prepared `settings.json` with `assertSafeTaskSettings` instead of rewriting it (:98). The test asserts the bytes and mtime are unchanged.
  - Probe and session can be injected. The canary-failure test asserts the session never starts and no `stream.jsonl` exists. The single-use test asserts a second capture throws and probe and session were each called once.
- **Open risk 2 (exact SessionStart command unconfirmed on desktop):** the doc covers it (`docs/desktop-plugin-check.md:38-40`). A cached plugin path would make the check fail, not pass falsely.

**Other properties I checked:**
- A tool result only counts if its `tool_use` appeared earlier in the file, because `calls` fills as the loop runs.
- The desktop hook must be `SessionStart:startup`, so a resumed session doesn't count.
- The transcript path is pinned to the workspace's directory with no symlinks (:59), which excludes subagent and copied transcripts.
- Reads are size-capped, and a check fails if any problem is recorded (:63).

**Advisory notes (not blocking):**
1. **Doc overstates what `sdk-cli` tells apart.** As far as I know, `claude -p` (headless print mode) also writes `entrypoint: 'sdk-cli'`. So a `claude -p` run in a terminal, in the workspace, with the marketplace plugin enabled (so it reports `jarvis@jarvis`) and session persistence on, would pass the desktop channel. `docs/desktop-plugin-check.md:29` says this metadata "distinguishes terminal records", but it only rules out interactive terminal sessions. Suggested wording: "Interactive terminal (`cli`) records are rejected; headless `claude -p` and other SDK hosts are indistinguishable." This is the same residual risk you've already accepted, just stated more precisely.
2. **Step order differs between the doc and the script.** The doc puts the CLI step first, but `prepare` (`desktop-plugin-check.mjs:71`) prints the desktop steps as 1–2 and the CLI command after them. Either order produces valid evidence, since `notBefore` is set at prepare time, so this is cosmetic.
3. **`verifyCheck` uses two forms of the run path.** It reads `probe.json`, `outcome.json` and `stream.jsonl` through the caller's `directory` path, while `loadCheck` validated the realpath'd version. Under the runner-owned trust model this doesn't matter; using `run.directory` would make it consistent.
4. **Some framework assumptions fail closed.** Real desktop records may differ from the fixtures:
   - an array-shaped `tool_result.content`
   - the CLI hook_response not naming its hook command
   - ordering between `dontAsk` and PreToolUse hooks

   Each of these would make the check fail rather than pass, so they don't cause false PASSes.

Low 9 (dense predicates and style) is still in the backlog as stated.
