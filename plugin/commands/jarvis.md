---
description: Start any Jarvis request. Triage picks the pipeline (new product, feature, bug, refactor, question, release), the matching skills run in order, then the build goes to the runner.
argument-hint: "[fix|build|feature|ask] <request>"
---

# /jarvis

Request: $ARGUMENTS

## 1. Triage

1. In the project folder, run `jarvis triage --json "$ARGUMENTS"`. A first word of fix, build, feature or ask is the user's override, and it always wins. Add `--literal` only when that word belongs to the sentence ("feature flags are broken", "ask users for their email").
2. Read the request and the result's `signals`, then run it once more with your judgment added:
   - `--judgment <type>` when you read the type differently from the words (new-product, feature, bug, refactor, question, release);
   - `--missing-behavior` when a "bug" is behavior nobody ever specified, with `--questions <n>` for the product questions it raises;
   - `--new-screen` when a feature needs a kind of screen the product doesn't have;
   - `--attached-error` when an error, stack trace or issue is attached; `--touches <path>` for each file a quick search says the change touches;
   - `--onboarding`, `--judgment-tier <n>` and `--reason "<one line>"` as they apply.
   The override and an empty folder outrank your judgment by design. Don't argue with the result; mention a doubt in one line.
3. Your first message: the `upgrade.announcement` sentence word for word when there is one, then the `headline`. Never upgrade silently.

## 2. Follow the pipeline

Run the result's `steps` whose `by` is `session`, in order, passing each skill the request, the type and the tier. Never run anything listed in `never`.
- `register-check`, `spike` and `research`: the `research` skill.
- `intake`: the `intake` skill. It calls the `design` skill for mockups only when `mockups` is true.
- `spec`: the `spec` skill.
- `design`: the `design` skill again, after the spec, to write DESIGN.md from the picked direction.
- `read-only-research` and `answer`: read the code and docs, answer with file citations, change nothing.
- `decision-archaeology`: the `onboard` skill (stage 6). Until it exists, list the decisions you can reconstruct, each marked "inferred" with its evidence.

Steps whose `by` is `runner` happen after the hand-off. Don't do them here, even when they look small.

## 3. Hand off

- `handoff: "after-spec"`: once the session steps are done and the spec's status is `confirmed` or `unconfirmed` (defaulted after the runner's timeout). A spec left as `draft` ("don't build yet") stops here.
- `handoff: "now"`: straight after triage.
- `handoff: "none"`: stop after the answer.

Then run `jarvis run --detach` and tell the user it's safe to close Claude Code. Before stage 3 there's no runner yet: say what's ready and stop.
