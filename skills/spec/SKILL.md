---
name: spec
description: Turns the research, the intake answers and the assumptions into a checkable, versioned spec (docs/spec/vN.md) in Jarvis's fixed grammar, ranked stories with WHEN … THE SYSTEM SHALL criteria, has a fresh-context reader check it for gaps, then asks for one confirmation that defaults after the runner's timeout. Use after intake, and for every later change to a fixed constraint or a P1 story.
---

# Spec

Write down what will be built and what won't, in a form a test can check and a fresh reader can follow without asking anyone. The spec is the only up-front approval (decision 9), and its confirmation covers every artifact handed to the builder (see Confirm); later approvals are the hard stops and the morning vetoes. Every task records which spec version and which assumptions it depends on, so the format and the IDs matter as much as the content.

## When to use

| Tier (decision 37) | What runs here |
|---|---|
| 0 | Nothing. Tier 0 never gets a spec: bugs go straight to reproduce → failing test → fix → checks. |
| 1 | A short spec: one to three stories, their criteria and the assumptions. The reader check and the confirmation still run. |
| 2 | Everything below. |

Also run it when the plan changes mid-run (decision 40): a change to a fixed constraint or a P1 story produces the next version, and so does a morning veto that changes an assumption the spec lists. Don't run it for a change that touches neither; the build loop records those as decisions.

Confirmation belongs to the first hand-off only (decision 86). A mid-run version, from a steer note, a veto or a repair, goes through the checker and the reader, gets `status: unconfirmed` so it leads the morning report, and the runner replans only the slice that changed; a mid-run version never gets its own confirmation round. A change that needs a choice outside what the user delegated (the only working provider costs money) doesn't become a version: it goes to decision 40's blocked state and waits for the user while the rest of the plan continues.

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
- **Criteria:** `- **AC1 (S1):** WHEN … THE SYSTEM SHALL …` (EARS, decision 9), at least one per story, each naming a story that exists. One observable behavior per criterion, checkable by a test without asking anyone. Acceptance criteria state behavior the user can observe. Implementation mechanics belong in the intake record's Engineering decisions, unless a safeguard needs them to be checkable.
- **Assumptions:** `- **A1 [fixed]:** …` for a constraint from the project or the user, with its source; `[delegated]` for a choice left to Jarvis, including every default, labeled "default accepted" or "default unconfirmed".
- **Empty sections say `None.`** on a line of their own. Only Goals, Non-goals, Assumptions and Open questions may be empty; User stories and Acceptance criteria are never empty.
- **Delete the template's comments** once the spec is filled.

Copy the user's original request verbatim into Goals prose. Any default or assumption that rewrites or destroys the user's past data must surface in intake or the confirmation round's veto list: edits that recompute past records, imports or restores that replace existing data, and deletion with no archive or undo all count. Never hide these as mechanical details.

What goes in:
- **Goals:** what must be true for the user when this is done. Test each one: if it were cut, would the product still solve the problem? If yes, it's a P2 or P3 story, not a goal.
- **Non-goals:** what this version deliberately doesn't do, each with its reason. Everything a fixed constraint rules out goes here with its source ("No automatic deletion: docs/storage.md:12 requires an explicit removal action"), so nobody adds it back later.
- **Stories:** from the story map, in its order. A walking-skeleton crutch (a manual step standing in for an open choice) is a story too, so the build makes it real.
- **Criteria** cover more than the happy path:
  - for a product with a UI, **the first-value budget** from the intake record (decision 55), as its own criterion: "WHEN a new user opens the app THE SYSTEM SHALL let them save their first catalogue item in 3 taps or fewer";
  - the empty, loading, error and offline states of each screen the stories touch (decision 53);
  - every outside action through the broker, stated as behavior: "WHEN the user approves a payment THE SYSTEM SHALL charge exactly the approved amount, and nothing without approval";
  - nothing vague: "fast", "intuitive", "secure" and "user-friendly" become numbers or observable behavior, or they come out.
- **Assumptions:** every fixed constraint from research and every answer, then every default and every Jarvis choice a story depends on. Tasks cite them by ID, and a morning veto of one replans what depends on it.
- **Open questions:** only what doesn't block the build, each with the default the build uses meanwhile. A blocking product question belongs in intake; if one turns up now, see the reader check.

**One-confirmation budget.** One confirmation can carry about 20 P1 acceptance criteria and 7 unconfirmed assumptions. When a draft has more of either, cut it to the walking skeleton as P1 and the rest as P2/P3 stories, each with its own criteria and assumptions; the runner still builds them all, P1 first. Never drop a safeguard or a fixed constraint, or merge independent assumptions, to fit. A walking skeleton over the budget is too thick: thin it to the shortest complete path and move the rest to P2/P3.

Then run the spec format checker, `jarvis spec check`, and fix every problem it reports. It checks structure and references only; the content is the reader's job.

A decision after intake that widens who or what the product acts on, or overrides a safeguard research found, is never a silent Mechanical or Taste call. Keep the requested scope and the safeguard, and list the widening first in the confirmation as a `[delegated]` "default unconfirmed" assumption that applies only if the user explicitly asks for it. No label authorizes bypassing a fixed constraint or a hard stop.

Any decision you make while writing (a delegated choice the intake didn't cover) is recorded with `jarvis decide --by jarvis --class mechanical|taste --why "<the rationale>" --alternatives "<the alternatives>" --depends-on "<the story and criterion IDs, for Taste>" --source docs/spec/vN.md "<decision>"`. Never edit `docs/decisions.md` directly (decision 83).

## Versions

- **v1** has `supersedes: none`. Each later version is the next number after the highest file in `docs/spec/`, and supersedes its immediate predecessor: v3 has `supersedes: 2`. No gaps, no branches.
- **Start a new version from the latest one:** copy it, set the new number, today's date, `status: draft` and the new `supersedes`, then change only what changed.
- **Never edit a version once it's confirmed or unconfirmed.** Tasks, checks and the ledger point at it. The one edit allowed afterwards is the status line from `unconfirmed` to `confirmed`, when the user later confirms it unchanged. Any other change, even a typo in a criterion, is a new version. A draft has nothing depending on it yet, so it's edited in place.
- **IDs are stable across versions.** An unchanged or reworded story, criterion or assumption keeps its ID. A new one takes the next unused number. A removed ID is never reused for something else, because the runner compares versions by ID to find the tasks and checks that went stale and replans only that slice (decision 40).
- **Why it changed** goes in the register, not the spec: the decision that caused the version (the user's steer, a veto) is recorded with `jarvis decide`, citing the new spec file as its source.

## Check with a fresh reader

When design applies, finish its After the pick or An existing design system step first so readers see final DESIGN.md. Run the `egm-review` skill with the spec path and pass number (decision 203). It uses a fresh context for document-only comprehension, then the plugin's `spec-reader` role (`jarvis:spec-reader`) with the spec, PRODUCT.md, DESIGN.md if present and safely resolved cited files, never the intake conversation or your notes. Together these count as one pass. Preserve the paraphrases and findings. An incomplete review stops confirmation and handoff, even at the cap.

Ask the spec-reader to report, each with the line it refers to:
- stories with no criterion that would fail if the story were broken,
- criteria a test can't check, or that need someone to judge them,
- contradictions between goals, non-goals, stories and assumptions,
- terms used but never defined, and screens, data or outside services the stories rely on but never name,
- missing empty, loading, error and offline cases, and a missing first-value budget for a UI,
- anything a builder would have to ask about before starting,
- whether the defaults still deliver the user's core request and the known trade-offs are visible,
- whether recorded state matches what happened: preparing something, handing it to another app, the user confirming they did it and an outside service confirming it are distinct states,
- whether inferred labels need evidence or lower confidence; never state a guessed role or category as fact.

Each finding gets one action (decision 172): fix the draft; contest it citing a file or decision, never "intentional"; escalate what no file settles into the confirmation, never pad the spec; decline nits. Record each under "Spec check vN".

**No second round of questions** (decision 8). A gap that turns out to be a product question becomes a `[delegated]` assumption using the default you would have offered, labeled "default unconfirmed", and is listed first in the confirmation. After fixing, re-read the whole spec after the last fixes, check it against the whole current decision register, and run a fresh reader again while blocking gaps remain; any fresh-reader pass counts toward the cap below. Check no superseded citations, no answered question left open, and decision header ranges are current. Check goals, non-goals, stories, criteria and assumptions together; do not reintroduce anything an active decision excludes. Re-run `jarvis spec check` after each final edit. Nonblocking gaps may stay under Open questions with explicit defaults. Repeat the self-check and format checker after confirmation changes; a fresh reader runs only if the cap below permits it.

**Bound the reader loop.** A clean pass ends the loop immediately. At most 3 fresh-reader passes in total per spec version, including checks after confirmation changes. Never reset the count, even for new blockers or revised wording. At the cap, turn every remaining blocking product question into a `[delegated]` assumption labeled "default unconfirmed", listed first in the confirmation; report every other remaining blocker there as a known gap. Then start confirmation, never another reader. Mid-run versions follow When to use instead, with these assumptions and known gaps leading the morning report. Record the pass count and unresolved gaps in the intake record under Spec check vN. Nonblocking polish never prolongs the loop.

## Confirm

Start by saying **"This is the separate spec confirmation round"**. The user gets one page: **"here's what I'm building, and what I'm not"**. Build it from the spec: the goals, the P1 stories in plain words, the non-goals, and the assumptions the user hasn't confirmed, those first. List every unconfirmed assumption as a short numbered list, each one line with its ID; the count you report is the count in the file, P2/P3 stories included (recount after every edit; zero when there are none). The five-line summary is a digest, not a replacement for this list: put the full list in the confirmation question's `question` and print it in the session; keep `why` one line. Include every known gap from the reader cap in the confirmation question and the printed page. The full spec stays on the Mac.

**What the user confirms is final.** Before sending, make the spec, `DESIGN.md`, `PRODUCT.md`, the register and the picked mockup agree (tokens, screens, flows), and update or mark superseded every file line that states an earlier position, research and intake records included (a "pending" marker, a reversed recommendation; `jarvis decide` for the register). When design revised the picked mockup, attach its new paths in `mockups`. Nothing in the spec, `DESIGN.md`, `PRODUCT.md`, the decision register or the picked mockup changes after confirmation without a new confirmation round; only the status line and the recorded confirmation answer are written after it. A later change starts a new draft version (Versions), goes through the checker and reader, and is confirmed again with every changed artifact shown. Mid-run versions follow When to use instead.

Confirmation covers exactly the artifacts handed off. It goes out like an intake round (decisions 10 and 83), as one more round in `.jarvis/intake/` with one question:

```json
{ "formatVersion": 2, "round": 2, "spec": "docs/spec/v1.md",
  "summary": "Separate spec confirmation round\nBuilding: …\nNot building: …\nUnconfirmed: 2 (listed below)",
  "questions": [ { "id": "CONFIRM", "topic": "scope", "question": "Unconfirmed assumptions:\n1. A2: Archive format is a delegated choice.\n2. A4: Local storage is a delegated choice.\nBuild spec v1 as written?",
    "why": "Confirm the scope and the listed assumptions together.",
    "default": { "answer": "Yes, build as written", "reason": "It follows your answers and the project's rules", "tradeOff": "The unconfirmed choices and their known costs are listed above; no build has started" },
    "alternatives": ["Build it with the changes I describe", "Don't build yet"] } ],
  "mockups": [] }
```

1. Write `.jarvis/intake/round-<n>.json` (the next unused round number) and run `jarvis intake send .jarvis/intake/round-<n>.json`.
2. At the same time, print the same page in the session as **plain text**, never in a tool that waits for the user (decision 86).
3. Wait with `jarvis intake answers <n> --wait 540`, at most twice, with the Bash tool's `run_in_background: true`. Never require Esc. End the turn so the user can type while a wait is pending; submit their response once with `jarvis intake answer <n> <file>`, then read the background result. Never run your own timer. `deadline: null` means undelivered: wait for an answer in the session, never infer a timeout from two completed waits. Only a successful phone delivery creates a deadline. Print the actual delivery status, not a promise that a phone tap works.

   An explicit yes is a user answer even when it matches the default: write `{"CONFIRM": "yes, A2 and A4 are fine as written."}` with the user's actual words. `{"CONFIRM": "<the changes>"}` asks for changes; `{"CONFIRM": "Don't build yet"}` stops. Only "defaults" uses `{}` or `"defaults"`. Do not split a confirmation into invented user decisions: a `--by user` entry needs its verified `--answer` reference and exact recorded text in `--recorded-answer`; its text is `CONFIRM: <what was confirmed>`. Never relabel defaults as user answers.
4. Set the status line from what came back:

| Came back | Status | Then |
|---|---|---|
| "Yes", "defaults", or the phone's "Use defaults" | `status: confirmed` | Hand off |
| Changes | stays `draft` | Apply the requested changes, align the other artifacts, run the checker and self-check (a fresh reader only within the version's remaining cap), record the answer once with its exact words as evidence, the decision itself as entry text, with `--answer <answerSeq>:CONFIRM` and `--recorded-answer "<the exact recorded answer>"` (`jarvis decide`, intake's first form, with `--source docs/spec/vN.md`), then show the revised artifacts in a new confirmation round |
| "Don't build yet" | stays `draft` | Stop, and say what would unblock it |
| A closed round reported by the CLI as a delivery-backed timeout | `status: unconfirmed` | Hand off; the unconfirmed spec goes at the top of the morning report |

A still-open round stays draft: wait for a session answer and stop the turn; do not hand off.

Free text from the phone's publish box is a steer note, never an answer: it doesn't confirm the spec or change it here, and it never widens a grant (it's unauthenticated). The runner handles it as a steer after the hand-off, which may produce the next version.

## Hand off

Hand off exactly the artifacts the confirmation covered; drift found now goes back through Confirm, never a silent fix. Hand back to the `/jarvis` pipeline with the spec path, its status, and the unconfirmed assumption IDs. What runs next is the pipeline's call (architecture §2): any step of the design skill already ran before the reader check, so next come architecture, the acceptance checks generated from the criteria, and the hand-off to the runner. Don't start the runner from this skill, and don't generate the checks here: the runner locks them outside the repo (decision 49).

## Gotchas

- **The grammar is exact.** A missing blank front matter line, `## User Stories` with a capital S, or a `## Notes` section fails the checker, and a spec that fails the checker blocks the whole run. Copy the template; don't type the structure from memory.
- **Keep other files out of `docs/spec/`.** The checker treats every `v*.md` there as a version, so `v1-review.md` or `v1.old.md` breaks the history. Reader notes go in the intake record.
- **Renumbering breaks replanning.** Sorting stories by renumbering them makes every task look stale. Keep IDs; reorder lines instead (the ID numbers don't have to be in order, the priorities do).
- **"Should" isn't a criterion.** "The list should load quickly" can't fail a test. "WHEN the list has 500 catalogue items THE SYSTEM SHALL show it within 1 second" can.
- **Non-goals stop scope creep.** If the backlog rules out automatic deletion and the spec doesn't say so, a later session will helpfully add them.
- **Unconfirmed stays labeled.** An unconfirmed default copied into the spec without its label becomes a fake user decision; the morning report and the veto depend on the label.
- **The reader must not see your reasoning.** Giving it the intake conversation turns it into a second author who shares your blind spots.
- **Change only what the user asked.** When the confirmation asks for changes, apply exactly those to the draft (plus what the checker needs). Anything else you'd like to change waits for the next version, or the user approved one spec and got another.
