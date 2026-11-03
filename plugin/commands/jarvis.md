---
description: Triage, prepare and run a reviewed local Jarvis task.
argument-hint: "[fix:|build:|feature:|ask:] <request>"
---

# /jarvis

Request: $ARGUMENTS

Never write Claude Code memory files (auto-memory included), with any tool; keep learnings in the project notes the skills name.

## 1. Triage

1. In the project folder, run `jarvis triage --json "$ARGUMENTS"`. Leading `fix:`, `build:`, `feature:` or `ask:` overrides win. Without a colon, "Build fails on CI" is a bug.
2. Read the request and `signals`; rerun with your judgment:
   - `--judgment <type>` to correct the type (new-product, feature, bug, refactor, question, review, release);
   - `--missing-behavior` for unspecified behavior, with `--questions <n>` for product questions;
   - `--new-screen` for a new screen kind; `--new-platform` and `--platform <name>` for a client without UI, even if DESIGN.md covers another;
   - `--then <type>` for the edits a question also asks for (feature, refactor, bug, or none);
   - `--attached-error` for an attached error, stack trace or issue; `--touches <path>` for each file a quick search says the change touches;
   - `--onboarding`, `--judgment-tier <n>` (risk only raises it), `--reason "<one line>"`, and `--override <word>` if the user named an override another way.
   The override and an empty folder outrank your judgment.
3. **Before any progress narration, agent launch or skill dispatch, your first user-visible message MUST include the `headline` verbatim** from the final triage result. When there is an `upgrade.announcement`, display that sentence word for word immediately before the headline. Never upgrade silently.
Shell reads: Quote globs (`--include='*.go'`). Prefer `rg -F`; `grep` may be ugrep. Do not rely on `jarvis <cmd> --help` exiting 0.

## 2. Start the pipeline

For a new product in a folder without Git, run `jarvis plan init` before research/intake. It commits nothing.

Only after displaying the triage headline, start `dispatch` in order with the request and triage JSON. Skills chain; never repeat a step or run anything in `never`.
- `register-check` or `research`: start the `research` skill. It chains through spike, intake and spec, returning the spec status.
- `design`: spec runs the `design` skill's "after the pick" part before its reader check, so DESIGN.md is confirmed with the spec. If DESIGN.md is missing when spec hands back, run that part, then spec's Confirm again; never change a confirmed artifact here.
- `read-only-research` and `answer`: read the code and docs, answer with file citations, change nothing.
- `decision-archaeology`: the `onboard` skill. When triage's `onboarding` is true, start it at `read-only-research`: it reads, answers and does the archaeology.
- `review`: the `review` skill: read-only findings with fixes, no edits.
- `review-report`: its report mode, written to triage's `review.report`.
- `architecture`: the `architect` skill, only after spec is confirmed or unconfirmed; a draft stops. It checkpoints documents and installs checks. Under decision 170, three fresh read-only lenses judge the plan; resolve blockers by evidence, fix or escalation. The runner refuses a plan without a counted review.

When `then` is set, do the steps above first, then treat `then` as the pipeline: its `steps`, `never` and `handoff`. Steps whose `by` is `runner` happen after the hand-off; don't do them here.

## 3. Hand off

- `handoff: "after-spec"`: once spec is `confirmed` or `unconfirmed` (runner timeout default) and design is done. A spec left as `draft` ("don't build yet") stops here.
- `handoff: "now"`: once the session steps, if any, are done.
- `handoff: "none"`: stop after the answer or the review.

**Local build hand-off** (decision 186): after the architect reports approved checks and a counted plan review, run `jarvis run --local --detach`. For a bug/refactor (including `then`), use `jarvis run --local --request "$ARGUMENTS" --request-type <type> --request-tier <tier> --detach`, retaining final triage and each `--touches <path>`. An installed unit check is required. Other session plans keep their explicit `--plan` selector. Release requests stop: deployment is outside this local workflow.

Stop on any refusal; never bypass a failed gate. Report the pid and log path. Launch is not completion: inspect the log and runner status/report before claiming success. Never say it is safe to close Claude Code until the detached launch succeeds.
