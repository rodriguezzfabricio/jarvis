---
description: Start a Jarvis task. Triage selects the pipeline, skills prepare it, and reviewed local builds go to the runner.
argument-hint: "[fix:|build:|feature:|ask:] <request>"
---

# /jarvis

Request: $ARGUMENTS

Never write Claude Code memory files (auto-memory included), with any tool; keep learnings in the project notes the skills name.

## 1. Triage

1. In the project folder, run `jarvis triage --json "$ARGUMENTS"`. Overrides are the first word plus a colon: `fix:`, `build:`, `feature:` or `ask:`. They win. Without a colon, "Build fails on CI" is a bug.
2. Read the request and `signals`; rerun with your judgment:
   - `--judgment <type>` to correct the type (new-product, feature, bug, refactor, question, review, release);
   - `--missing-behavior` for unspecified behavior, with `--questions <n>` for product questions;
   - `--new-screen` when a feature needs a kind of screen the product doesn't have; `--new-platform` and `--platform <name>` when it targets a platform or client with no UI yet, even if DESIGN.md covers another;
   - `--then <type>` for the edits a question also asks for (feature, refactor, bug, or none);
   - `--attached-error` for an attached error, stack trace or issue; `--touches <path>` for each file a quick search says the change touches;
   - `--onboarding`, `--judgment-tier <n>` (risk only raises it), `--reason "<one line>"`, and `--override <word>` if the user named an override another way.
   The override and an empty folder outrank your judgment.
3. **Before any progress narration, agent launch or skill dispatch, your first user-visible message MUST include the `headline` verbatim** from the final triage result. When there is an `upgrade.announcement`, display that sentence word for word immediately before the headline. Never upgrade silently.
Shell reads: Quote globs (`--include='*.go'`). Prefer `rg -F` or simple fixed-string searches; `grep` may be ugrep. Do not rely on `jarvis <cmd> --help` exiting 0.

## 2. Start the pipeline

Only after displaying the triage headline, start the steps whose `dispatch` is true, in order, passing the request, the type, the tier and the triage JSON. Each skill chains to the next itself; start nothing a skill already ran. Never run anything listed in `never`.
- `register-check` or `research`: start the `research` skill. It runs any spike and chains to intake, intake to spec, and spec hands back here with the spec's status.
- `design`: spec runs the `design` skill's "after the pick" part before its reader check, so DESIGN.md is confirmed with the spec. If DESIGN.md is missing when spec hands back, run that part, then spec's Confirm again; never change a confirmed artifact here.
- `read-only-research` and `answer`: read the code and docs, answer with file citations, change nothing.
- `decision-archaeology`: the `onboard` skill. When triage's `onboarding` is true, start it at `read-only-research`: it reads, answers and does the archaeology.
- `review`: the `review` skill: read-only findings with fixes, no edits.
- `review-report`: its report mode, written to triage's `review.report`.
- `architecture`: the `architect` skill, only after spec is confirmed or unconfirmed; a draft stops. It checkpoints planning documents, installs checks and obtains a counted plan review.

When `then` is set, do the steps above first, then treat `then` as the pipeline: its `steps`, `never` and `handoff`. Steps whose `by` is `runner` happen after the hand-off; don't do them here.

## 3. Hand off

- `handoff: "after-spec"`: once spec has handed back with status `confirmed` or `unconfirmed` (defaulted after the runner's timeout) and any `design` step is done. A spec left as `draft` ("don't build yet") stops here.
- `handoff: "now"`: once the session steps, if any, are done.
- `handoff: "none"`: stop after the answer or the review.

**Local build hand-off** (decision 186): after the architect reports approved checks and a counted plan review, run `jarvis run --local --detach`. For a bug, pass the original report with `jarvis run --local --request "$ARGUMENTS" --detach`; it requires an installed unit check. Other session plans keep their explicit `--plan` selector. Release requests stop: deployment is outside this local workflow.

Stop on any refusal; never bypass a failed gate. Report the pid and log path. Launch is not completion: inspect the log and runner status/report before claiming success. Never say it is safe to close Claude Code until the detached launch succeeds.
