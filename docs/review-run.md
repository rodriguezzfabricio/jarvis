# Run a frozen independent review

```sh
node scripts/review-run.mjs --round stage0-17 \
  --prompts "$HOME/.jarvis/codex-review/stage0-17" \
  --schema "$HOME/.jarvis/codex-review/stage0-17/schema.json" --dry-run
```

Add `--confirm-stage <0-1|2|3|4|5|6>` for a stage review: the mutation check then runs only that stage's mutations, all on the full suite, and leaves the other stages' mutations to their own reviews (decision 129); without it, the check runs every mutation (`--confirm`, the v1 close). The check prints how many mutations it will run and a wall-time estimate, and `JARVIS_MUTATION_PLAN=1 node scripts/mutation-check.mjs --confirm-stage <s>` prints the list without running anything (exit 5).

Remove `--dry-run` to execute. Prepare `prompt-A.md`, `prompt-B.md`, `prompt-D.md` and a Codex output schema first. Claude is the sole integrator and owns stage-review launches. This script is a host operator tool for the trusted Jarvis repository; it is not a sandbox for arbitrary third-party build scripts. A scoped Opus review does not replace independent Codex stage review.

Defaults: repository `~/Desktop/jarvis`, pinned Codex absolute path from `config/pins.ts`, model `gpt-6.1-sol`, effort `high`, lanes `A,B,D` (decision 79). Round names use `stage<N>-<N>`, matching review-status. Flags `--repo`, `--codex`, `--model`, `--effort`, `--lanes` override these. An explicit Codex executable must be absolute; overriding it is for trusted fixtures/operators, never PATH lookup. Available efforts: low, medium, high, xhigh.

1. Validate inputs and refuse any tracked or untracked changes in the source repository. Reserve the round with exclusive `lanes` creation. Existing output, including partial runs, is never overwritten; choose a new round after investigating a failed run.
2. Clone into `~/.jarvis-work/reviews/<round>-<full-revision>`, detach at the captured commit and remove origin. All Git uses `eval/git.ts`; only the explicit local clone enables file transport. Remove only the clone's `docs/reviews/*-response.md` files.
3. Record revision/date and install dependencies, then run typecheck, unit tests, live probe, doctor-live and mutation-check in that order. Strip terminal control codes and append `exit <n>` to each log, including install. Failed commands remain failures even if later commands/reviewers pass. Like the prior shell runner, all evidence commands and lanes still run after an evidence command fails.
4. Publish `workspace.txt` and `evidence-done`, run lanes concurrently with null stdin, read-only sandbox and ephemeral sessions, record each exit and finally `codex-done`. Print every selected lane's absolute verdict path.

Codex receives exactly HOME (isolated Codex home), USER, PATH and CODEX_HOME, never the parent environment. macOS may add `__CF_USER_TEXT_ENCODING` during executable initialization; the fake process tests distinguish that runtime key from environment supplied by this runner. Evidence processes also receive a minimal HOME/USER/PATH environment. The orchestrator itself reads no secret file, writes no source repository file, pushes no remote and grants no approval. Evidence commands use the real HOME for installed toolchains and existing authentication; these trusted commands may read their usual configuration and credentials.

New rounds have one manifest line: `lanes A,B,D`. A subset such as `--lanes D` is allowed for diagnostics, but status reports missing required lanes and the runner returns 1. Adding C requires C to pass too. Original manifest-free single-lane rounds and round 16's four lanes retain their historical interpretation. No scanner severity is changed by either script.

Exit 0 means the selected round has advisory PASS (or input-valid dry run); exit 1 means failure/incomplete evidence or invalid input. It is not stage approval. Other historical rounds do not affect this runner's exit code. A dry run creates no files or subprocess reviews; it only validates inputs and reads Git state.

For deterministic integration tests, `--evidence-config <trusted-json>` accepts six objects in exact order, `{ "name": "install", "bin": "/absolute/executable", "args": ["..."] }`, followed by typecheck, unit-tests, live-probe, doctor-live, mutation-check. This is arbitrary host command execution by the operator; never accept it from a task session. The exported `runReview` also accepts a synthetic `home` for tests. Tests never invoke a real reviewer or live safety probe.

Caught setup/runtime errors append `runner-error` and are reported as failures. Abrupt termination leaves artifacts for diagnosis. An empty status or manifest is not proof the process is alive; review-status is advisory. No timeout is imposed by this wrapper. Parent termination can leave child commands running; inspect processes before launching another round. Source HEAD changes during capture cannot change the detached revision being reviewed.

Deleting response files matches the prior shell runner; Git history still contains them and `git diff` can show their deletion content. This is workspace presentation, not a confidentiality boundary. Prompt-only future round folders have no manifest yet and therefore report `missing lane manifest`, per the approved conservative reporter contract; launch writes the manifest.
