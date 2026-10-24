# Inspect review progress

```sh
node scripts/review-status.mjs
node scripts/review-status.mjs /path/to/review-root --json
```

This read-only command summarizes `stage<N>-<round>` directories under `~/.jarvis/codex-review` by default. It uses existing artifacts; it never invokes Git, a model, tests, or an approval operation. It reads bounded file contents, rejects special files without blocking, and does not print raw model output or stderr.

| State | What the files establish |
|---|---|
| queued | No status marker or workspace pointer is visible. Process activity is unknown. |
| capturing evidence | A workspace pointer exists, but evidence is not marked complete. Current runners publish the pointer late, so this state is normally not visible. |
| reviewing | Evidence is marked complete; reviewer completion is still pending. If the workspace pointer is not visible yet, its evidence remains unknown. |
| failed | A completed command failed, evidence is missing after completion, a verdict is missing/invalid after its lane exits, or a reviewer reports a blocking result. |
| finished | All required recorded checks and completed reviewer lanes pass. This is advisory, not stage approval. |

The five required evidence logs are `typecheck`, `unit-tests`, `live-probe`, `doctor-live`, and `mutation-check`, in the workspace's `.review-evidence` directory. Each needs a final `exit 0` line. Mutation evidence also needs a positive `all N mutations caught` summary with no reported misses. `install.log` is informational because existing runners omit its exit footer; an explicit nonzero install exit still fails the report.

Old rounds use `verdict.json` and `codex-done-<exit>`; the final status can overwrite `evidence-done`. Four-lane rounds use `verdict-{A,B,C,D}.json`, one `lane <L> exit <n>` marker per lane, and a final `codex-done`. Stage-0 round 16 onward always requires four lanes, even when one lane's files are missing. Other stages are recognized as parallel when lane prompt/verdict files or lane status markers exist.

An advisory **PASS** requires complete evidence, a known revision, all required lane exits equal to zero, schema-valid PASS verdicts, and no critical/high findings. Medium/low findings are counted without changing a PASS verdict. A reviewer FAIL remains a failure regardless of its finding counts. An incomplete JSON write remains pending until its lane exits. Conflicting revision identities, duplicate completion markers, lanes completing before evidence, and markers after review completion are failures.

CLI exit codes: **0** means every discovered round has an advisory PASS; **1** means at least one round failed, arguments were invalid, or an explicitly supplied root is missing/unreadable; **2** means no rounds or at least one incomplete round, with no failures. `--help` or `-h` alone prints usage and exits 0 without checking reviews. Historical failed rounds therefore keep the root-level command's exit code at 1 even after a newer round passes. JSON consumers can select the desired round by `name`.

## Limits

The command reports artifacts, not live process state or authenticated proof. Existing runners write `workspace.txt` only after collecting evidence, so a queued-looking round can still be collecting evidence. A stalled process and a running process with unchanged files look identical. A revision can be inferred from the workspace folder name if the README has none; disagreement between both is rejected. Recorded logs/verdicts are not cryptographically verified or matched to their file modification times. Independent stage review and the project stage gates remain authoritative.

Tests use synthetic temporary rounds. They cover both runner formats, partial output, failed commands, missing evidence, inconsistent verdicts, revision conflicts, read-only behavior, and CLI exit codes.
