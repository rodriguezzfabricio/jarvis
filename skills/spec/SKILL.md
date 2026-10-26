---
name: spec
description: Turns the research, the intake answers and the assumptions into a checkable, versioned spec (docs/spec/vN.md) in Jarvis's fixed grammar, ranked stories with WHEN … THE SYSTEM SHALL criteria, has a fresh-context reader check it for gaps, then asks for one confirmation that defaults after the runner's timeout. Use after intake, and for every later change to a fixed constraint or a P1 story.
---

# Spec

Write down what will be built and what won't, in a form a test can check and a fresh reader can follow without asking anyone. The spec is the only up-front approval (decision 9): later approvals are the hard stops and the morning vetoes. Every task records which spec version and which assumptions it depends on, so the format and the IDs matter as much as the content.

## When to use

| Tier (decision 37) | What runs here |
|---|---|
| 0 | Nothing. Tier 0 never gets a spec: bugs go straight to reproduce → failing test → fix → checks. |
| 1 | A short spec: one to three stories, their criteria and the assumptions. The reader check and the confirmation still run. |
| 2 | Everything below. |

Also run it when the plan changes mid-run (decision 40): a change to a fixed constraint or a P1 story produces the next version, and so does a morning veto that changes an assumption the spec lists. Don't run it for a change that touches neither; the build loop records those as decisions.

Confirmation belongs to the first hand-off only (decision 86). A mid-run version, from a steer note, a veto or a repair, goes through the checker and the reader, gets `status: unconfirmed` so it leads the morning report, and the runner replans only the slice that changed; there's never another confirmation round. A change that needs a choice outside what the user delegated (the only working provider costs money) doesn't become a version: it goes to decision 40's blocked state and waits for the user while the rest of the plan continues.

## Inputs

Read these before writing:
1. **The research file** (`docs/research/<date>-<slug>.md`): fixed constraints with sources, spike decisions and their wrappers, what was "not checked".
2. **The intake record** (`docs/intake/<date>-<slug>.md`): the framing (job story, story map, walking skeleton, first-value budget), the assumptions, every question with its answer and who gave it, and the engineering decisions.
3. **The answers** as recorded in the register (`docs/decisions.md`, decision 48), including which defaults are unconfirmed.
4. **`PRODUCT.md`**, and `DESIGN.md` if it exists.
5. **The latest version in `docs/spec/`**, if there is one. Its IDs carry over (see Versions).

If an input contradicts another (an answer conflicts with a fixed constraint), the register's firmness rules settle it (decision 48). Never settle it by quietly dropping one side.

## Write the spec

Bundled `templates/` paths resolve relative to this installed skill. Copy `templates/spec.md` to `docs/spec/vN.md` and fill it. The format is fixed (decision 83), because the spec format checker and the runner read it line by line:

- **Front matter, the first six lines exactly:** `---`, `spec: N`, `date: YYYY-MM-DD`, `status: draft`, `supersedes: none` or `supersedes: N-1`, `---`. N matches the file name. No other keys, no blank line inside.
- **An optional `# Spec vN`** with the same N, then exactly these six sections as `##` headings, spelled exactly, in this order: Goals, Non-goals, User stories, Acceptance criteria, Assumptions, Open questions. There are no other `##` headings. Prose and `###` subheadings are fine inside a section.
- **Stories:** `- **S1 (P1):** As …`, one line each, listed in priority order (all P1, then P2, then P3). The P1 stories together are the walking skeleton from the intake story map: one complete thin path from trigger to outcome.
- **Criteria:** `- **AC1 (S1):** WHEN … THE SYSTEM SHALL …` (EARS, decision 9), at least one per story, each naming a story that exists. One observable behavior per criterion, checkable by a test without asking anyone.
- **Assumptions:** `- **A1 [fixed]:** …` for a constraint from the project or the user, with its source; `[delegated]` for a choice left to Jarvis, including every default, labeled "default accepted" or "default unconfirmed".
- **Empty sections say `None.`** on a line of their own. Only Goals, Non-goals, Assumptions and Open questions may be empty; User stories and Acceptance criteria are never empty.
- **Delete the template's comments** once the spec is filled.

Copy the user's original request verbatim into Goals prose. Any default or assumption that rewrites or destroys the user's past data must surface in intake or the confirmation round's veto list: target edits recalculating old completion/streaks, restore replacement and deletion without archive all count. Never hide these as mechanical details.

What goes in:
- **Goals:** what must be true for the user when this is done. Test each one: if it were cut, would the product still solve the problem? If yes, it's a P2 or P3 story, not a goal.
- **Non-goals:** what this version deliberately doesn't do, each with its reason. Everything a fixed constraint rules out goes here with its source ("No follow-up emails: backlog P4 rules out a follow-up campaign"), so nobody adds it back later.
- **Stories:** from the story map, in its order. A walking-skeleton crutch (a manual step standing in for an open choice) is a story too, so the build makes it real.
- **Criteria** cover more than the happy path:
  - for a product with a UI, **the first-value budget** from the intake record (decision 55), as its own criterion: "WHEN a new user opens the app THE SYSTEM SHALL let them add their first habit in 3 taps or fewer";
  - the empty, loading, error and offline states of each screen the stories touch (decision 53);
  - every outside action through the broker, stated as behavior: "WHEN the user approves a draft THE SYSTEM SHALL send exactly that message, and nothing without approval";
  - nothing vague: "fast", "intuitive", "secure" and "user-friendly" become numbers or observable behavior, or they come out.
- **Assumptions:** every fixed constraint from research and every answer, then every default and every Jarvis choice a story depends on. Tasks cite them by ID, and a morning veto of one replans what depends on it.
- **Open questions:** only what doesn't block the build, each with the default the build uses meanwhile. A blocking product question belongs in intake; if one turns up now, see the reader check.

Then run the spec format checker, `jarvis spec check`, and fix every problem it reports. It checks structure and references only; the content is the reader's job.

Any decision you make while writing (a delegated choice the intake didn't cover) is recorded with `jarvis decide --by jarvis --class mechanical|taste --why "<the rationale>" --alternatives "<the alternatives>" --depends-on "<the story and criterion IDs, for Taste>" --source docs/spec/vN.md "<decision>"`. Never edit `docs/decisions.md` directly (decision 83).

## Versions

- **v1** has `supersedes: none`. Each later version is the next number after the highest file in `docs/spec/`, and supersedes its immediate predecessor: v3 has `supersedes: 2`. No gaps, no branches.
- **Start a new version from the latest one:** copy it, set the new number, today's date, `status: draft` and the new `supersedes`, then change only what changed.
- **Never edit a version once it's confirmed or unconfirmed.** Tasks, checks and the ledger point at it. The one edit allowed afterwards is the status line from `unconfirmed` to `confirmed`, when the user later confirms it unchanged. Any other change, even a typo in a criterion, is a new version. A draft has nothing depending on it yet, so it's edited in place.
- **IDs are stable across versions.** An unchanged or reworded story, criterion or assumption keeps its ID. A new one takes the next unused number. A removed ID is never reused for something else, because the runner compares versions by ID to find the tasks and checks that went stale and replans only that slice (decision 40).
- **Why it changed** goes in the register, not the spec: the decision that caused the version (the user's steer, a veto) is recorded with `jarvis decide`, citing the new spec file as its source.

## Check with a fresh reader

Before anyone confirms it, have the spec read by a reader with a fresh context (decision 9): the plugin's `spec-reader` role (`jarvis:spec-reader`), which gets only the spec file, `PRODUCT.md`, `DESIGN.md` if it exists, and the files the spec cites, never the intake conversation or your notes. It reads like the builder will, so it finds what only you know.

Ask it to report, each with the line it refers to:
- stories with no criterion that would fail if the story were broken,
- criteria a test can't check, or that need someone to judge them,
- contradictions between goals, non-goals, stories and assumptions,
- terms used but never defined, and screens, data or outside services the stories rely on but never name,
- missing empty, loading, error and offline cases, and a missing first-value budget for a UI,
- anything a builder would have to ask about before starting,
- whether the defaults still deliver the user's core request and the known trade-offs are visible,
- whether recorded state matches what happened. Copying a draft is not reaching out: copying, opening a mail client, user-confirmed sending and provider-confirmed delivery are distinct states,
- whether inferred labels need evidence or lower confidence; never label someone Recruiter as a fact solely from a guess.

Fix each gap in the draft, or record why not. The reader's findings and what you did with each go in the intake record under "Spec check vN".

**No second round of questions** (decision 8). A gap that turns out to be a product question becomes a `[delegated]` assumption using the default you would have offered, labeled "default unconfirmed", and is listed first in the confirmation. After fixing, re-read the whole spec after the last fixes, and run a fresh reader against the whole current decision register, until a pass finds no blocking gaps. Check no superseded citations, no answered question left open, and decision header ranges are current. Check goals, non-goals, stories, criteria and assumptions together; do not reintroduce plan pricing or metering that an active decision excludes. Re-run `jarvis spec check` after each final edit. Nonblocking gaps may stay under Open questions with explicit defaults; unresolved blocking gaps leave the spec draft and prevent hand-off. Repeat this check after applying confirmation changes too.

## Confirm

The user gets one page: **"here's what I'm building, and what I'm not"**. Build it from the spec: the goals, the P1 stories in plain words, the non-goals, and the assumptions the user hasn't confirmed, those first. It must fit the round's summary of at most 5 lines; the full spec stays on the Mac.

Confirmation happens once, at the initial hand-off (decision 86). It goes out like an intake round (decisions 10 and 83), as one more round in `.jarvis/intake/` with one question:

```json
{ "formatVersion": 2, "round": 2, "spec": "docs/spec/v1.md",
  "summary": "Building: …\nNot building: …\nUnconfirmed: A4 (weekly reminders), A6 (local storage)",
  "questions": [ { "id": "CONFIRM", "topic": "scope", "question": "Build spec v1 as written?",
    "why": "It's the only up-front approval; later changes replan part of the work.",
    "default": { "answer": "Yes, build as written", "reason": "It follows your answers and the project's rules", "tradeOff": "The unconfirmed choices and their known costs are listed above; no build has started" },
    "alternatives": ["Build it with the changes I describe", "Don't build yet"] } ],
  "mockups": [] }
```

1. Write `.jarvis/intake/round-<n>.json` (the next unused round number) and run `jarvis intake send .jarvis/intake/round-<n>.json`.
2. At the same time, print the same page in the session as **plain text**, never in a tool that waits for the user (decision 86).
3. Wait with `jarvis intake answers <n> --wait 540`, at most twice, with the Bash tool's `run_in_background: true`. Never require Esc. End the turn so the user can type while a wait is pending; submit their response once with `jarvis intake answer <n> <file>`, then read the background result. Never run your own timer. `deadline: null` means undelivered: wait for an answer in the session, never infer a timeout from two completed waits. Only a successful phone delivery creates a deadline. Print the actual delivery status, not a promise that a phone tap works.

   An explicit yes is a user answer even when it matches the default: write `{"CONFIRM": "yes. A24, A25 and A33 are fine as written."}` with the user's actual words. `{"CONFIRM": "<the changes>"}` asks for changes; `{"CONFIRM": "Don't build yet"}` stops. Only "defaults" uses `{}` or `"defaults"`. Do not split a confirmation into invented user decisions: a `--by user` entry needs its verified `--answer` reference and exact recorded text. Never relabel defaults as user answers.
4. Set the status line from what came back:

| Came back | Status | Then |
|---|---|---|
| "Yes", "defaults", or the phone's "Use defaults" | `status: confirmed` | Hand off |
| Changes | `status: confirmed` on the changed draft | Apply the changes to the draft, run the checker and the reader again, record each change as the user's decision with `jarvis decide` (the intake skill's first form, with `--source docs/spec/vN.md`), hand off. The answer is the confirmation; there's no second round |
| "Don't build yet" | stays `draft` | Stop, and say what would unblock it |
| A closed round reported by the CLI as a delivery-backed timeout | `status: unconfirmed` | Hand off; the unconfirmed spec goes at the top of the morning report |

A still-open round stays draft: wait for a session answer and stop the turn; do not hand off.

Free text from the phone's publish box is a steer note, never an answer: it doesn't confirm the spec or change it here, and it never widens a grant (it's unauthenticated). The runner handles it as a steer after the hand-off, which may produce the next version.

## Hand off

Hand back to the `/jarvis` pipeline with the spec path, its status, and the unconfirmed assumption IDs. What runs next is the pipeline's call (architecture §2): for a new product or a new kind of screen with no design system, the design skill writes `DESIGN.md` from the picked direction; then architecture, the acceptance checks generated from the criteria, and the hand-off to the runner. Don't start the runner from this skill, and don't generate the checks here: the runner locks them outside the repo (decision 49).

## Gotchas

- **The grammar is exact.** A missing blank front matter line, `## User Stories` with a capital S, or a `## Notes` section fails the checker, and a spec that fails the checker blocks the whole run. Copy the template; don't type the structure from memory.
- **Keep other files out of `docs/spec/`.** The checker treats every `v*.md` there as a version, so `v1-review.md` or `v1.old.md` breaks the history. Reader notes go in the intake record.
- **Renumbering breaks replanning.** Sorting stories by renumbering them makes every task look stale. Keep IDs; reorder lines instead (the ID numbers don't have to be in order, the priorities do).
- **"Should" isn't a criterion.** "The list should load quickly" can't fail a test. "WHEN the list has 500 habits THE SYSTEM SHALL show it within 1 second" can.
- **Non-goals stop scope creep.** If the backlog rules out follow-ups and the spec doesn't say so, a later session will helpfully add them.
- **Unconfirmed stays labeled.** An unconfirmed default copied into the spec without its label becomes a fake user decision; the morning report and the veto depend on the label.
- **The reader must not see your reasoning.** Giving it the intake conversation turns it into a second author who shares your blind spots.
- **Change only what the user asked.** When the confirmation asks for changes, apply exactly those to the draft (plus what the checker needs). Anything else you'd like to change waits for the next version, or the user approved one spec and got another.
