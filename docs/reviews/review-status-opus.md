# Review-status tool — independent Opus review

October 24, 2026. Codex branch: `codex/review-status`, based on `c27c882`. Scope: the new read-only diagnostic script, synthetic tests and usage documentation. No production source or existing stage-review artifacts changed.

## Result and validation

- Independent reviewer: pinned Claude Code 2.1.309, requested and reported `claude-opus-5-5`, requested effort high. Both sessions reported `apiKeySource: none`. Review tools were Read/Glob/Grep only, with the permanent restricted settings and no web or external MCP servers. The prerequisite live canary passed all 21 checks.
- `pnpm test`: 211 passed, 4 live tests skipped, 18 test files passed and 2 skipped; 55.47 seconds. The new file contributes 24 tests. `pnpm typecheck`, `node --check scripts/review-status.mjs` and `git diff --check` passed.
- Eight isolated negative controls were each rejected by a failing assertion after their unmodified targeted tests passed. They cover required evidence, required lanes, invalid verdicts, revision consistency, missing lane completion, mixed help flags, symlink entry detection, and nonblocking FIFO reads. The complete project mutation suite remains owned by Claude; these are additional focused experiments, not a replacement.
- Tests were written before implementation. The first review corrections were reproduced by five failing regression tests before fixes. The real saved rounds 15 and 16 were inspected read-only, showing the existing FAIL and incomplete state without changing artifacts.

## Review history

The first review requested changes for symlink entry detection, nonblocking special-file reads, ambiguous missing workspace pointers, progress marker validation, CLI argument handling, test gaps and documentation. These were fixed and re-reviewed.

The second review passed, with three low-priority follow-ups. Its two suggested tests were added (mixed known help flags and a missing lane completion marker), and its help-text wording was clarified. Only tests and the usage-message string changed after PASS; reversing that string correction reproduces the reviewed script SHA-256 exactly. Final full tests and all eight negative controls ran afterward.

Optional remaining diagnostic limitation: an unreadable workspace pointer is treated as unknown while review is incomplete, or failed once complete; its low-level read-error reason is not separately surfaced. This cannot produce PASS and is recorded here for the Claude integrator.

## Re-review verdict (verbatim)

**Verdict: PASS.** I found no correctness bugs. There are three small test and wording gaps you could fix but don't need to. I read all three files; I did not run the tests.

**Each fix checked against the code:**
- **CLI detection** (`scripts/review-status.mjs:170-173`): it resolves the real path of both `argv[1]` and the script. The symlink test expects exit 1 from a `codex-done-1` round, so it would catch the old silent exit 0.
- **Non-blocking read** (`:17-19`): it opens with `O_NONBLOCK`, then uses `fstat` on the open file to reject anything that isn't a regular file. The FIFO test has a 2s timeout and checks that `result.error` is undefined, so it would catch a hang.
- **Absent workspace pointer** (`:93-94`): evidence is only required once there is a pointer or the round has completed, so evidence-done without a pointer stays "reviewing". Completion without a pointer still fails.
- **Repeated/out-of-order markers** (`:69-86`): a second evidence-done, any marker after completion, a lane before evidence, and duplicate lane markers each add a problem. All four test cases hit a distinct check.
- **Missing explicit root** (`:188`) exits 1, and help alone exits 0.
- **Oversized files** fail for both status and verdict, and the test sizes are exactly one byte over each limit.

**Remaining issues (all low):**
1. **The help-combination check is never actually tested** (`tests/unit/review-status.test.ts:184`). The `["--help", "--bad"]` case is already rejected by the unknown-flag rule, so the check `help && args.length !== 1` could be deleted and the tests would still pass. Add `["--help", "--json"]` and `["-h", <root>]`.
2. **"Lane X lacks a completion marker" (`:133`) is never tested on its own.** It's only reached at test `:121`, where an unrecognised `codex-done-0` already causes the failure. Without that check, a four-lane status missing `lane D exit N` but ending in `codex-done` would show PENDING instead of FAIL. Add a test for exactly that status.
3. **Help text wording** (`:183`): "invalid arguments or explicit root" should say "missing/unreadable explicit root" to match the docs (`docs/review-status.md:24`).

**Optional:** if `workspace.txt` can't be read (permissions, FIFO, too large), it's treated as absent with no reason given (`:89-92`). That's safe, because it can never lead to a PASS, but it hides why.

**Scope:** The docs present this as advisory only: they make no liveness or approval claims and say stage gates stay authoritative. Your on-disk finding (`workspace.txt` written just before `evidence-done`) fits the docs' "normally not visible" wording for the capturing-evidence state.

## Final content hashes (SHA-256)

```json
{
  "scripts/review-status.mjs": "214b84a57f7f575e31b824f8297e5f3358b93ce5f9ea7e73d61929a0e8f2344a",
  "tests/unit/review-status.test.ts": "5eddcdbfe8417b94198992d1f5487c831c06ff9566ace7bf4c768060b0e6e49a",
  "docs/review-status.md": "ce04e7eec962bc0c6043c97b8a9dc11b85fa90c1f4dcc2a89e4e7f66c1fc60d6"
}
```

## Negative-control definitions

Each control ran in a disposable copy. No edits were made to the shared mutation list.

```json
[
  {
    "name": "missing required evidence ignored",
    "file": "scripts/review-status.mjs",
    "anchor": "\"unit-tests\", \"live-probe\", \"doctor-live\"",
    "replacement": "\"unit-tests\", \"doctor-live\"",
    "test": "requires all evidence",
    "caught": true
  },
  {
    "name": "fourth review lane ignored",
    "file": "scripts/review-status.mjs",
    "anchor": "[\"A\", \"B\", \"C\", \"D\"] : [\"single\"]",
    "replacement": "[\"A\", \"B\", \"C\"] : [\"single\"]",
    "test": "requires every parallel lane",
    "caught": true
  },
  {
    "name": "invalid verdict not reported",
    "file": "scripts/review-status.mjs",
    "anchor": "if (!valid) problems.push",
    "replacement": "if (false) problems.push",
    "test": "rejects malformed completed",
    "caught": true
  },
  {
    "name": "revision mismatch ignored",
    "file": "scripts/review-status.mjs",
    "anchor": "if (documented && inferred && documented !== inferred)",
    "replacement": "if (false)",
    "test": "refuses inconsistent revision",
    "caught": true
  },
  {
    "name": "missing completion marker ignored",
    "file": "scripts/review-status.mjs",
    "anchor": "if (exitCode === null) problems.push",
    "replacement": "if (false) problems.push",
    "test": "requires a completion marker",
    "caught": true
  },
  {
    "name": "mixed help accepted",
    "file": "scripts/review-status.mjs",
    "anchor": "(help && args.length !== 1)",
    "replacement": "false",
    "test": "rejects invalid CLI arguments",
    "caught": true
  },
  {
    "name": "symlink entry point ignored",
    "file": "scripts/review-status.mjs",
    "anchor": "realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))",
    "replacement": "resolve(process.argv[1]) === fileURLToPath(import.meta.url)",
    "test": "runs through a symlink",
    "caught": true
  },
  {
    "name": "FIFO open blocks",
    "file": "scripts/review-status.mjs",
    "anchor": "constants.O_RDONLY | constants.O_NONBLOCK",
    "replacement": "\"r\"",
    "test": "rejects a named pipe",
    "caught": true
  }
]
```

Local raw review evidence: `/private/tmp/jarvis-opus-review-status-UnOFc7/`. This report preserves the verdict, final hashes and negative-control definitions. It grants no stage approval.
