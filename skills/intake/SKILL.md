---
name: intake
description: One round of product questions, ranked, each with a recommended default. Checks the request against the project's decision register, frames the job (job story, day after launch, story map, umbrella test), lists assumptions with confidence, decides engineering itself and asks at most 7 product questions, the design direction among them when there's a new UI. Use after research, before the spec.
---

# Intake

Ask the product decisions only the user can make, once, with recommended defaults. Decide engineering and log it. Ask about changes to what they see, do, pay or risk.

## When to use

After the research skill has written its file (`docs/research/<date>-<slug>.md`), and before the spec. What runs depends on the tier triage gave (decision 37). If no tier was given, stop and hand back to triage.

| Tier | What runs here |
|---|---|
| 0 | Nothing. Bugs go straight to reproduce → failing test → fix → checks. |
| 1 | The conflict check, the assumptions list and the product questions the change raises (often zero to three). No mockups when a `DESIGN.md` exists. |
| 2 | Everything below. The design direction and its mockups only under the rule in "Write the questions". |

Mid-run changes of mind (`jarvis steer`, morning vetoes) are not intake: they produce a new spec version (decision 40).

## Inputs

Read these before writing assumptions or questions. Read these documents in full (paginate to the end): the project's README, IMPLEMENTATION/ARCHITECTURE-type docs, AGENTS.md/CLAUDE.md and existing specs relevant to the request or project scope, when present. A keyword grep is not a full read. Their explicit ownership, privacy, scope and deployment rules are fixed constraints: never ask or assume what they settle. A fork's own docs override what it inherited upstream.

Research must finish before the round, with a source for every material claim or an explicit "not checked" line per unsupported claim. Missing web access never proves that only manual or paid options exist.

Then read:
1. **The research file:** its fixed constraints, conflicts, Challenges, product questions raised and engineering decisions.
2. **The decision register** (`docs/decisions.md`, decision 48) and the backlog.
3. **The taste profile** (decision 39). Run `jarvis taste show` first (JSON profile or `null`). Reuse an existing profile. If none exists and this adds a UI, offer it once within the round only if the question budget permits; default to skip. Accept preferences volunteered in that answer, but never add a separate profile questionnaire. Do not wait for a profile before framing the job. Draft the design directions without a profile using product constraints and research; the design direction question carries the choice. Only for a complete supplied profile, write `.jarvis/intake/taste.json`, run `jarvis taste save .jarvis/intake/taste.json`, and copy it into `PRODUCT.md`'s Taste section. Keep partial preferences in `PRODUCT.md` without inventing fields or asking extra questions.
4. **`PRODUCT.md`, `DESIGN.md` and any design system in the code** (component library, tokens, theme files).

## Check the decision register

Compare the request with every active decision. Three rules settle it (decision 48):
- **An explicit new request beats an older decision.** An explicit request names the very behavior the old decision rules out. Record a supersession only after the answer path captured that request and the old decision ID; use its exact words and provenance (Take the answers). Superseding a money or safety rule changes the plan only: the outside action still needs the broker's approval when it happens.
- **Silence never overrides an old decision.** If the request doesn't mention something, the old decision stands, unasked.
- **Jarvis's own ideas never override the user's.** A better pattern from research is a Challenge for the report (decision 11), not a change.

How firmly each decision holds depends on who made it:

| Made by | How to treat a conflict |
|---|---|
| The user, explicitly | Only the user changes it: an implied change becomes a question |
| A default the user accepted | The same, until the user changes it |
| Jarvis (Mechanical or Taste) | Revisit it without a question; record the change with a note saying why |
| Inherited or inferred from old files, not yet confirmed | Confirm it with the user once: it becomes a question, default "keep" |

An implied change becomes the first question, citing the old decision ID and source. Default: keep the old decision. Alternatives: switch, or allow it for this feature only.

## Frame the job

For a new product, ask what the person does today and what's broken before solution questions. If their request already answers this, cite it instead of asking again. Put this discovery question first after any register conflict, within the same round; mark any proposed job story as provisional until answered. Do not invent a personal situation from market research.

Before sorting questions (decision 6), write:
1. One **job story**: "When <situation>, I want <motivation>, so <outcome>."
2. **The day after launch**: what the user does, sees and where.
3. The **top 3 reasons it could fail**, including product risks.
4. A **story map** from trigger to outcome, with variations per activity.
5. The **umbrella test**: chained verbs, fallbacks, repeated triggers, missing data, outside people or time-dependent steps. An umbrella has 3 outside-dependent activities, or 2 activities with 2 viable variations each. Mark one complete thin path as the **walking skeleton**, using manual crutches only when they preserve the requested outcome; slice the rest in story-map order.
6. For a UI, **the first-value budget** (decision 55), grounded in research: maximum taps/clicks to the core result. Record it as Taste; the spec makes it a criterion.

Activities a fixed constraint rules out don't appear on the map. Write a **draft `PRODUCT.md`** from `templates/PRODUCT.md` with product facts, the user's original request, vocabulary and constraints. Start the intake record with this framing and first-value budget before calling design; update both after answers.

## List assumptions first

Before any question, list assumptions with a confidence level (high, medium, low) and source (research, code, register, inference). Low-confidence product assumptions are question candidates.

## Sort product from engineering

Every open decision is one or the other (decision 7):
- **Product:** an unresolved outcome, workflow or constraint that only the user can supply. Ask only what only the user can answer. Effects on privacy, cost or outside actions must be visible in assumptions and trade-offs; they do not make every implementation choice a product question or grant permission to act.
- **Engineering:** fallback ordering, retention, idempotency of side effects, and suppression/opt-out for anyone the product messages; also retries, schema, caching and test strategy. Decide these yourself and record Decision / Rationale / Alternatives with the class (Mechanical or Taste, decision 11), dependencies for Taste and reversibility. Follow project constraints, preserve existing data and honor opt-outs by default. Ask about an unknown personal or business requirement only when it changes the outcome; never ask the user to design the mechanism.

Never ask what the code, the register, the backlog or research already answers. Never ask the user to pick a library.

## Write the questions

**Rank:** scope first, then security, privacy and legal, then UX, then technical. A register conflict goes first of all, with topic `scope`. The design direction ranks with UX, with topic `design`. For a new product, the current-situation question follows any conflict and precedes solution choices. Assign Q1–Q7 only after ranking, then keep those IDs and that order through the JSON, session display and answer record.

**Cap: at most 7 questions.** The cap counts every question asked in this intake, including any profile offer, whether in prose, a tool or the JSON. Count each independently answerable part of a bundled prompt; grouping asks under one ID does not reduce the count. Reuse any answers already given and subtract any earlier asks before sending the remaining round. The design direction counts when applicable; omit the optional profile offer before cutting necessary product questions. Product questions beyond 7 become logged assumptions with the proposed default and its trade-offs, never extra asks. The spec confirmation is a separate round, labeled as such.

**The design direction** (decision 39) is one of the questions when the work adds a UI and **either** it's a new product **or** it needs a new kind of screen while the project has neither a `DESIGN.md` nor a design system in its code (architecture §2). When a design system exists but `DESIGN.md` doesn't, there's no direction question: the design skill writes `DESIGN.md` from the existing system (decision 51). Backend-only work never gets one.

**Permissions belong to ship.** Release, production and spending permissions are not intake questions; the ship stage asks them against a concrete release or purchase. Intake records constraints and known costs. A product answer never authorizes an outside action; the broker's hard stops still apply.

**Default honesty.** Name the known costs and limitations from research, not just the upside, in the default's reason and `tradeOff`. Include behavior costs as well as money: what the default gets wrong, repeats or makes the user redo in normal use. Cite the research; unknown costs say "not checked".

**Request fidelity.** Never drop or replace the core of the user's request with the default. A default that makes the user do by hand what they asked to have done for them drops it. If the project's own docs forbid the requested behavior, quote the exact doc line with its path and line number and say the default follows it. Keep the conflict visible and apply the register rules above; never imply that a constrained default satisfies the entire request. If no viable way was found, say so plainly and ask; do not promise a different feature or present missing research as impossibility.

**Past data.** Any default or assumption that rewrites or destroys the user's past data must be a question or a listed assumption the user can veto in the round. Include edits that recompute past records, imports or restores that replace existing data, and deletion with no archive or undo. Put the effect in the persisted round summary and printed veto list, not only in the spec. Prefer preserving history; silence is never a destructive-action grant.

**Each question has** the question in one sentence, **why it matters** in one line, a **recommended default** with its reason, and 1–3 **alternatives** (the default is separate). A yes/no question needs only one alternative; never invent a second form of permission to fill the list. Other choices normally have 2–3 **alternatives**.

Defaults are safe, reversible, no-spend choices within the project's rules. A default never spends money, never messages a real person without approval, and never weakens a project rule.

**The design direction question** comes from the design skill: call it before sending the round for 3 different layouts and flows (decisions 52 and 39). Attach their screenshots, or local-only HTML paths if screenshots are unavailable; name the default and its reason. Mockups use made-up sample data, never real names or addresses.

## Send the round

**One round, all at once.** First a summary of at most 5 lines (what you understood, the job story, the umbrella verdict), then any register conflicts, the assumptions list, the questions and the mockups. End with: **"Reply 'defaults' to accept all, or answer the ones you care about here; in a submitted reply, omitted questions accept their defaults. If phone delivery succeeded, you can also tap Use defaults."**

**No questions, no round.** When nothing needs asking (common at tier 1), record the assumptions and go straight to the spec.

**Every round goes to the runner, whether or not the user seems to be at the computer** (decisions 10 and 83). The CLI records the round and delivery. Only successful phone delivery starts the 15-minute timer. Read `jarvis intake answers <n>` immediately after sending: `deadline: null` means undelivered; wait for an answer in the session. Never promise a timeout or a working phone tap when delivery failed. Print the actual delivery status and deadline.
1. Pick `<n>`: one more than the highest round number in `.jarvis/intake/`, starting at 1. Never reuse a number.
2. Write `.jarvis/intake/round-<n>.json`:

   ```json
   { "formatVersion": 2, "round": 3, "spec": "docs/spec/v2.md",
     "summary": "at most 5 lines",
     "questions": [ { "id": "Q1", "topic": "scope", "question": "…", "why": "one line",
       "default": { "answer": "…", "reason": "…", "tradeOff": "known costs, or not checked with the limitation" }, "alternatives": ["…", "…"] } ],
     "mockups": [".jarvis/mockups/<direction>/<screen>.png"] }
   ```

   New rounds use `formatVersion: 2`, requiring every default's nonblank `tradeOff`. Bundled `templates/` paths resolve relative to this installed skill, never the project cwd.

   `spec` is the version the spec skill will write next. `topic` is one of scope, security, privacy, legal, ux, technical or design. At most 7 questions. Mockups are the design skill's screenshot paths under `.jarvis/mockups/` (an empty list when there's no direction question); the notifier fits what it can into its 4 KB message, and the full text stays on the Mac.
3. Run `jarvis intake send .jarvis/intake/round-<n>.json`.
4. At the same time, print the same round in the session as **plain text**. Never put it in a tool that waits for the user: if they've walked away, the session would sit blocked after the runner's timeout, and the spec and the hand-off would never run (decision 86). Don't drip questions one at a time, and don't add a second round. Print questions in the JSON array order, preserving their IDs; never regroup them by topic or restart numbering.

Never send questions or mockups through any other channel, and never put code, secrets or personal data in them: the notifier passes through a public notification server.

## Take the answers

**Wait with a bounded call, never by polling** (decision 86). Call `jarvis intake answers <n> --wait 540` at most twice, using the Bash tool's `run_in_background: true`. Never require Esc to answer. End the turn after launching the background wait so answers stay available. Never run your own timer or sleep loop.

**One submission contract.** While a wait is pending, collect the whole session response, write `.jarvis/intake/answers-<n>.json` and run `jarvis intake answer <n> .jarvis/intake/answers-<n>.json` once. Include every explicit answer under its question id, even when it matches the default; quote the user's words, including corrections to assumptions. A single-question round also accepts a JSON string. Only "defaults" uses `{}` or `"defaults"`: listed ids are overrides, and every unlisted question takes its default as accepted. The existing wait sees the closure and returns; read its result instead of submitting again. A later tap is "Not counted"; later additions are steer notes (decision 40).

- **On the phone, a tap** answers only "Use defaults" for the whole round.
- **Free text from the phone** is a steer note, never a partial answer, even when it reads "Q2: weekly". The publish box is unauthenticated, so a steer note **never grants or widens anything**: production, spending, outside actions, security and privacy keep their defaults.
- **At a delivery-backed deadline (15 minutes after successful delivery),** all unanswered questions become "unconfirmed" defaults. Keep the label for the report.
- **If still open after either background wait,** inspect the returned deadline. `deadline: null` means wait for an answer in the session; leave the round open and stop the turn. Do not hand off until the CLI reports closed.
- **An answer after closure** is a steer, not another submission. Do not manufacture user-attributed supersessions from unrecorded text; retain it in the intake record until the answer path can record it.


| What came back | How it's recorded | `--by` | `--class` |
|---|---|---|---|
| An id listed in the session's submission | The user's explicit decision: firm, only the user changes it | `user` | `mechanical` |
| An unlisted id in a submission, or "Use defaults" | An accepted default: firm until the user changes it | `default-accepted` | `mechanical` |
| No answer by the deadline | An unconfirmed default: confirmed with the user once, vetoable in the morning | `default-unconfirmed` | `taste` |
| A free-text answer in the session that matches no option | The user's explicit decision, in their words; if it's ambiguous, record your reading of it as an assumption rather than asking again | `user` | `mechanical` |

Hard stops still apply after defaults: a default can't authorize spending or an outside action. Intake answers never grant release, production or spending permission; ship requests those through the broker.

**User attribution requires evidence.** `--by user` requires `--answer <answerSeq>:<questionId>` and the exact recorded answer. The closed answer result returns `answerSeq`. Only explicit session answers qualify; defaults, timeouts and phone notes do not. Supersessions must name the old ID in the question or answer. Never invent references or split an answer into new claims.

Then, in this order:
1. **Complete the intake record** (see Output) with every answer and who gave it.
2. **Record every decision** with `jarvis decide`, one call each, with `--why` and a repo-relative `--source` (intake or research record). Set `--reversibility` when not easily reversed. **Never edit `docs/decisions.md` directly** (decision 83).

   ```
   jarvis decide --by user --class mechanical --why "<the question's why>" --alternatives "<the options not taken>" --answer <answerSeq>:<questionId> --source docs/intake/<file>.md "<the exact recorded answer>"
   jarvis decide --by jarvis --class mechanical|taste --why "<the rationale>" --alternatives "<the alternatives>" --depends-on "<what depends on it, for Taste>" --source docs/research/<file>.md "<the engineering decision>"
   ```

   These forms record explicit answers and engineering decisions. Read `references/decision-examples.md` for accepted/unconfirmed defaults, provenance-backed supersessions and Challenges that keep the user's rule. Jarvis revises its own calls with `--by jarvis` and `--reason`.
3. **Update `PRODUCT.md`** (decision 51, from `templates/PRODUCT.md`) with the answers and the taste profile. The design pick is recorded here, once, like every other answer; the design skill doesn't record it again.
4. **Hand off to the spec skill** with the research file, the intake record, the assumptions (each marked fixed constraint or delegated preference, decision 9) and the answers.

## Output

Write `docs/intake/<YYYY-MM-DD>-<short-slug>.md`, so the reasoning behind the spec survives the session:

Use the bundled `references/intake-record.md` and fill every section. Read `references/principles.md` for the rationale behind the six intake rules. Reference paths resolve relative to this installed skill.

## Gotchas

- **Read the project's rules in full.** A grep can miss an ownership or scope rule; re-asking what the project settled is the classic failure.
- **Seven is a cap, not a target.** Put consequential past-data effects in the veto list when the question cap is reached.
- **"Where will you see it?" is usually a real question.** Agents skip the surface: which screen, notification or digest. If the request names no surface, ask.
- **Don't ask engineering questions to look careful.** Retry policies, schemas and libraries are yours to decide and log.
- **Unconfirmed isn't confirmed.** Keep the label all the way to the report; the user may veto any of them in the morning.
- **Never send anything outside the session and the runner.** Drafting is not sending.
