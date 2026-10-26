---
description: Start any Jarvis request. Triage picks the pipeline (new product, feature, bug, refactor, question, review, release), its first skill starts and chains on, then the build goes to the runner.
argument-hint: "[fix:|build:|feature:|ask:] <request>"
---

# /jarvis

Request: $ARGUMENTS

## 1. Triage

1. In the project folder, run `jarvis triage --json "$ARGUMENTS"`. The user's override is the first word followed by a colon: `fix:`, `build:`, `feature:` or `ask:`. It always wins. Without the colon the word is prose, so "Build fails on CI" is a bug.
2. Read the request and the result's `signals`, then run it once more with your judgment added:
   - `--judgment <type>` when you read the type differently from the words (new-product, feature, bug, refactor, question, review, release);
   - `--missing-behavior` when a "bug" is behavior nobody ever specified, with `--questions <n>` for the product questions it raises;
   - `--new-screen` when a feature needs a kind of screen the product doesn't have; `--new-platform` and `--platform <name>` when it targets a platform or client with no UI yet, even if DESIGN.md covers another;
   - `--then <type>` for the edits a question also asks for (feature, refactor, bug, or none);
   - `--attached-error` for an attached error, stack trace or issue; `--touches <path>` for each file a quick search says the change touches;
   - `--onboarding`, `--judgment-tier <n>` (risk only raises it), `--reason "<one line>"`, and `--override <word>` if the user named an override another way.
   The override and an empty folder outrank your judgment by design. Don't argue with the result; mention a doubt in one line.
3. **Before any progress narration, agent launch or skill dispatch, your first user-visible message MUST include the `headline` verbatim** from the final triage result. When there is an `upgrade.announcement`, display that sentence word for word immediately before the headline. Never upgrade silently. Do not substitute "research is running" for the headline.

Shell reads: Quote globs (`--include='*.go'`). Prefer `rg -F` or simple fixed-string searches; `grep` may be ugrep. Do not rely on `jarvis <cmd> --help` exiting 0; inspect help separately from required work.

## 2. Start the pipeline

Only after displaying the triage headline, start the steps whose `dispatch` is true, in order, passing the request, the type, the tier and the triage JSON. Each skill chains to the next one itself, so start nothing a skill already ran. Never run anything listed in `never`.
- `register-check` or `research`: start the `research` skill. It runs any spike and chains to intake, intake to spec, and spec hands back here with the spec's status.
- `design`: after spec hands back, run the `design` skill's "after the pick" part to write DESIGN.md (intake already had it make the mockups).
- `read-only-research` and `answer`: read the code and docs, answer with file citations, change nothing.
- `decision-archaeology`: the `onboard` skill. When triage's `onboarding` is true, start it at `read-only-research`: it does the reading, the answer and the archaeology together.
- `review`: the `review` skill: read-only findings with file references and fixes, no edits.

When `then` is set, do the steps above first, then treat `then` as the pipeline: its `steps`, `never` and `handoff`. Steps whose `by` is `runner` happen after the hand-off. Don't do them here, even when they look small.

## 3. Hand off

- `handoff: "after-spec"`: once spec has handed back with status `confirmed` or `unconfirmed` (defaulted after the runner's timeout) and any `design` step is done. A spec left as `draft` ("don't build yet") stops here.
- `handoff: "now"`: once the session steps, if any, are done.
- `handoff: "none"`: stop after the answer or the review.

**Stage 2 hand-off: Say what's ready and stop.** Name the spec and its status, the design and any unconfirmed assumptions. Do not invoke `jarvis run`, even with `--help`, or inspect runner options. Give this as a future user instruction only: "When the build runner is available, start it from the project folder with `jarvis run --detach`." Do not claim a run has started or that it is safe to close Claude Code. Starting a build belongs to the next stage, not this intake session.
