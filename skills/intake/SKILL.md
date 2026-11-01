---
name: intake
description: Frames the job, checks decisions, lists assumptions, decides engineering and asks at most 7 ranked product questions with defaults, including design. Use after research, before spec.
---

# Intake

Ask the product decisions only the user can make (changes to what they see, do, pay or risk), once, with recommended defaults. Decide engineering and log it.

## When to use

After research (`docs/research/<date>-<slug>.md`), before spec. Use the triage tier (decision 37); if missing, return to triage.

| Tier | What runs here |
|---|---|
| 0 | Nothing. Bugs go straight to reproduce → failing test → fix → checks. |
| 1 | The conflict check, the assumptions list and the product questions the change raises (often zero to three). No mockups when a `DESIGN.md` exists. |
| 2 | Everything below. The design direction and its mockups only under the rule in "Write the questions". |

Mid-run changes of mind (`jarvis steer`, morning vetoes) are not intake: they produce a new spec version (decision 40).

## Inputs

Before assumptions or questions, read the project's README, IMPLEMENTATION/ARCHITECTURE-type docs, AGENTS.md/CLAUDE.md and relevant existing specs. Read these documents in full (paginate to the end). A keyword grep is not a full read. Never ask or assume what their rules settle; a build limit is a build constraint (Sort product from engineering), and a real conflict with the request goes under Request fidelity. A fork's own docs override what it inherited upstream.

Research must finish before the round, with a source for every material claim or an explicit "not checked" line per unsupported claim. Missing web access never proves that only manual or paid options exist.

Then read:
1. **The research file:** its fixed constraints, conflicts, Challenges, product questions raised and engineering decisions.
2. **The decision register** (`docs/decisions.md`, decision 48) and the backlog.
3. **The taste profile** (decision 39). Run `jarvis taste show` first (JSON profile or `null`). Reuse an existing profile. For a UI without a profile, offer it once within the round if budget permits; default to skip. Keep volunteered preferences; never add a separate profile questionnaire. Do not wait for a profile before framing the job. Draft the design directions without a profile, from constraints and research. Only for a complete supplied profile, write `.jarvis/intake/taste.json`, run `jarvis taste save .jarvis/intake/taste.json`, and copy it into `PRODUCT.md`'s Taste section. Keep partial preferences in `PRODUCT.md` without inventing fields or asking extra questions.
4. **`PRODUCT.md`, `DESIGN.md` and any design system in the code** (component library, tokens, theme files).

## Check the decision register

Compare the request with every active decision. Three rules settle it (decision 48):
- **An explicit new request beats an older decision.** An explicit request names the very behavior the old decision rules out. Record supersession only after the answer path captures the request and old decision ID, with exact words and provenance (Take the answers). Superseding money or safety rules changes the plan only: the outside action still needs the broker's approval.
- **Silence never overrides an old decision.** If the request doesn't mention something, the old decision stands, unasked.
- **Jarvis's own ideas never override the user's.** A better pattern from research is a Challenge for the report (decision 11), not a change.

How firmly each decision holds depends on who made it:

| Made by | How to treat a conflict |
|---|---|
| The user, explicitly | Only the user changes it: an implied change becomes a question |
| A default the user accepted | The same, until the user changes it |
| Jarvis (Mechanical or Taste) | Revisit it without a question; record the change with a note saying why |
| Inherited or inferred from old files, not yet confirmed | Confirm it with the user once: it becomes a question |

An implied change becomes the first question, citing the old decision ID and source; its default follows Request fidelity in Write the questions. Alternatives: keep, switch, or allow it for this feature only.

## Frame the job

For a new product, ask what the person does today and what's broken before solution questions. If their request already answers this, cite it instead of asking again. The job story stays provisional until answered. Do not invent a personal situation from market research.

Before sorting questions (decision 6), write:
1. One **job story**: "When <situation>, I want <motivation>, so <outcome>."
2. **The day after launch**: what the user does, sees and where.
3. The **top 3 reasons it could fail**, including product risks.
4. A **story map** of the new job only: every stage from its trigger to its last user-visible outcome, with variations per activity. Name an existing later stage of the project as a boundary, never pull it into the new job.
5. The **umbrella test**: chained verbs, fallbacks, repeated triggers, missing data, outside people or time-dependent steps. An umbrella has 3 outside-dependent activities, or 2 activities with 2 viable variations each. Mark one complete thin path as the **walking skeleton**, using manual crutches only when they preserve the requested outcome; slice the rest in story-map order.
6. For a UI, **the first-value budget** (decision 55), grounded in research: maximum taps/clicks to the core result. Record it as Taste; the spec makes it a criterion.

Apply fixed product constraints, not build-action limits, to the map; surface any conflict with the request under Request fidelity. Write a **draft `PRODUCT.md`** from `templates/PRODUCT.md` with product facts, the user's original request, vocabulary and constraints. Start the intake record with the framing and budget before design; update both after answers.

## List assumptions first

Before any question, list assumptions with a confidence level (high, medium, low) and source (research, code, register, inference). Low-confidence product assumptions are question candidates.

## Sort product from engineering

A project line that limits what the build may do (what it may not deploy, buy, send or connect) is a build constraint, not a product rule: it binds the build and never justifies a default against the request.

Every open decision is one or the other (decision 7):
- **Product:** an unresolved outcome, workflow or constraint that only the user can supply. Ask only what only the user can answer. Show privacy, cost and outside-action effects in assumptions and trade-offs; this neither turns mechanisms into product questions nor grants permission to act.
- **Engineering:** the mechanism for an outcome that the request, the project's rules, the law or the code already settle: ordering, fallbacks, data lifetime, safe repeats, required safeguards, retries, schema, caching and tests. Decide these yourself and record Decision / Rationale / Alternatives with the class (Mechanical or Taste, decision 11), dependencies for Taste and reversibility. Follow project constraints and preserve existing data by default; a mechanism never works against the job story's outcome. Ask about an unknown personal or business requirement only when it changes the outcome; never ask the user to design the mechanism.

Engineering that protects people outside the project (anyone the product messages, stores data about or acts on) is decided by the session and recorded, never left open or asked. At least: a refusal list checked before every message (anyone who declines gets none again), a retention rule for their data and an idempotency rule (a retry never repeats a message or action).

Never ask what the code, the register, the backlog or research already answers. Never ask the user to pick a library. Ask the product need, not which storage provider to use; decide the provider as engineering unless the user must hold an account, pay, or would notice the difference.

## Write the questions

**Rank:** scope first, then security, privacy and legal, then UX, then technical. A register conflict goes first of all, with topic `scope`. Design ranks with UX, topic `design`. For a new product, the current-situation question follows any conflict and precedes solution choices. Assign Q1–Q7 only after ranking; keep those IDs and that order in the JSON, display and answers.

**Cap: at most 7 questions.** The cap counts every question asked in this intake, including any profile offer, whether in prose, a tool or the JSON. Count each independently answerable part of a bundled prompt. Reuse answers and subtract earlier asks before sending. Count the design direction; cut an optional profile offer before necessary questions. Product questions beyond 7 become logged assumptions with the proposed default and its trade-offs, never extra asks. The contradiction repair in Take the answers is the only exception. The spec confirmation is a separate round, labeled as such.

**The design direction** (decision 39) is one of the questions when the work adds a UI and **either** it's a new product **or** it needs a new kind of screen while the project has neither a `DESIGN.md` nor a design system in its code (architecture §2). When a design system exists but `DESIGN.md` doesn't, there's no direction question: the design skill writes `DESIGN.md` from the existing system (decision 51). Backend-only work never gets one.

**Permissions belong to ship.** Release, production and spending permissions are not intake questions; the ship stage asks them against a concrete release or purchase. Intake records constraints and known costs. A product answer never authorizes an outside action, and accepting a default never authorizes the build to spend money, message a real person or bypass a build constraint.

**Personal defaults.** For a question about the user's own past or situation, use a neutral default stating what the product assumes when unknown; never invent a first-person answer or record an unknown history as fact.

**Default honesty.** Name the known costs and limitations from research, not just the upside, in the default's reason and `tradeOff`. Include behavior costs: errors, repeats and rework in normal use. Cite the research; unknown costs say "not checked". A recommended default must not choose the option its own trade-off names as a product failure risk, unless the question says in one line why that risk is accepted.

**Request fidelity.** A recommended default never narrows the requested outcome. Never drop or replace the core of the user's request. A default that makes the user do by hand what they asked to have done for them drops it. When a project rule really conflicts with the request, quote the exact doc line with its path and line number; the question states the conflict and the default keeps the request's outcome. Keep the conflict visible; record any supersession through the answer path (register rules above). If no viable way was found, say so plainly and ask; do not promise a different feature or present missing research as impossibility.

**Past data.** Any default or assumption that rewrites or destroys the user's past data must be a question or a listed assumption the user can veto in the round. Include edits that recompute past records, imports or restores that replace existing data, and deletion with no archive or undo. Put the effect in the persisted round summary and printed veto list, not only in the spec. Prefer preserving history; silence is never a destructive-action grant.

**Each question has** the question in one sentence, **why it matters** in one line, a **recommended default** with its reason, and 1–3 **alternatives** (the default is separate). Yes/no needs one alternative, never redundant permissions. Other choices have 2–3 **alternatives**.

**The design direction question** comes from the design skill: call it before sending the round for 3 different layouts and flows (decisions 52 and 39). Attach their screenshots, or local-only HTML paths if screenshots are unavailable; name the default and its reason. Mockups use made-up sample data, never real names or addresses.

## Send the round

Before sending, check each question's text, trade-off and default against the fixed constraints and build constraints; remove promises the build cannot keep and surface real conflicts under Request fidelity.

**One round, all at once.** First a summary of at most 5 lines (what you understood, the job story, the umbrella verdict), then any register conflicts, the assumptions list, the questions and the mockups. End with: **"Reply 'defaults' to accept all, or answer the ones you care about here; in a submitted reply, omitted questions accept their defaults. If phone delivery succeeded, you can also tap Use defaults."**

**No questions, no round.** When nothing needs asking (common at tier 1), record the assumptions and go straight to the spec.

**Every round goes to the runner, whether or not the user seems to be at the computer** (decisions 10 and 83). Only successful phone delivery starts the 15-minute timer. Read `jarvis intake answers <n>` immediately after sending: `deadline: null` means undelivered; wait for an answer in the session. Never promise a timeout or a working phone tap when delivery failed. Print the actual delivery status and deadline.
1. Pick `<n>`: one more than the highest round number in `.jarvis/intake/`, starting at 1. Never reuse a number.
2. Write `.jarvis/intake/round-<n>.json`:

   ```json
   { "formatVersion": 2, "round": 3, "spec": "docs/spec/v2.md",
     "summary": "at most 5 lines",
     "questions": [ { "id": "Q1", "topic": "scope", "question": "…", "why": "one line",
       "default": { "answer": "…", "reason": "…", "tradeOff": "known costs, or not checked with the limitation" }, "alternatives": ["…", "…"] } ],
     "mockups": [".jarvis/mockups/<direction>/<screen>.png"] }
   ```

   New rounds use `formatVersion: 2`, requiring every default's nonblank `tradeOff`.

   `spec` is the version the spec skill will write next. `topic` is one of scope, security, privacy, legal, ux, technical or design. At most 7 questions. Mockups are screenshot paths under `.jarvis/mockups/` (empty without a direction question); phone messages fit 4 KB, with full text on the Mac.
3. Run `jarvis intake send .jarvis/intake/round-<n>.json`.
4. At the same time, print the same round in the session as **plain text**. Never put it in a tool that waits for the user: it blocks hand-off after timeout (decision 86). Don't drip questions one at a time, and add no second round but the contradiction repair in Take the answers. Print questions in the JSON array order, preserving their IDs; never regroup them by topic or restart numbering.

Never send questions or mockups through any other channel, and never put code, secrets or personal data in them: the notifier passes through a public notification server.

## Take the answers

**Wait with a bounded call, never by polling** (decision 86). Call `jarvis intake answers <n> --wait 540` at most twice, using the Bash tool's `run_in_background: true`. Never require Esc to answer. End the turn after launching the background wait so answers stay available. Never run your own timer or sleep loop.

**One submission contract.** While a wait is pending, collect the whole session response, write `.jarvis/intake/answers-<n>.json` and run `jarvis intake answer <n> .jarvis/intake/answers-<n>.json` once. Include every explicit answer under its question id, even when it matches the default; quote the user's words, including corrections to assumptions. A single-question round also accepts a JSON string. Only "defaults" uses `{}` or `"defaults"`: listed ids are overrides, and every unlisted question takes its default as accepted. Read the pending wait's closure; never submit again. A later tap is "Not counted"; later additions are steer notes (decision 40).

- **On the phone, a tap** answers only "Use defaults" for the whole round.
- **Free text from the phone** is a steer note, never a partial answer, even when it reads "Q2: weekly". The publish box is unauthenticated, so a steer note **never grants or widens anything**: production, spending, outside actions, security and privacy keep defaults.
- **At a delivery-backed deadline (15 minutes after successful delivery),** all unanswered questions become "unconfirmed" defaults. Keep the label for the report.
- **If still open after either background wait,** inspect the returned deadline. `deadline: null` means wait for an answer in the session; leave the round open and stop the turn. Do not hand off until the CLI reports closed.
- **An answer after closure** is a steer, not another submission. Keep unrecorded text in the intake record, never as a user-attributed supersession.

Read `references/decision-examples.md` before recording for attribution, firmness and examples. Ambiguous free text becomes an assumption.

Hard stops still apply: a default can't authorize spending or an outside action; ship requests release, production and spending through the broker.

An entry states the decision itself, with who gave it and the question ID; never use a bare acknowledgement as decision text. A design direction pick is Taste, whoever gave it. Keep raw answers in the intake record as evidence.

**User attribution requires evidence.** `--by user` requires `--answer <answerSeq>:<questionId>` and `--recorded-answer "<the exact recorded answer>"`. Read `answerSeq` from the closed answer result. Only explicit session answers qualify; defaults, timeouts and phone notes do not. Supersessions must name the old ID in the question or answer. Never invent references or split an answer into new claims.

**Contradiction repair.** When an answer contradicts an accepted default of another question in the same round, re-ask that default once, in a short second round that holds only the contradicted defaults, before the spec starts. Send, wait and record it like any round, with a new number; cite the contradicting answer and recommend a default consistent with it and the requested outcome. Never silently keep or replace the contradicted default. Only one repair round runs; a conflict that remains becomes an unconfirmed assumption listed first in the spec confirmation.

Then, in this order:
1. **Complete the intake record** (see Output) with every answer and who gave it.
2. **Record every decision** with `jarvis decide`, one call each, with `--why`, a repo-relative `--source`, and `--reversibility` when not easily reversed. **Never edit `docs/decisions.md` directly** (decision 83).

   ```
   jarvis decide --by user --class mechanical|taste --why "<the question's why; who answered questionId>" --alternatives "<the options not taken>" --depends-on "<what depends on it, for Taste>" --answer <answerSeq>:<questionId> --recorded-answer "<the exact recorded answer>" --source docs/intake/<file>.md "<the decision itself, with question ID>"
   ```

   The reference covers defaults, supersessions and Challenges. Revisit Jarvis calls with `--by jarvis` and `--reason`.
3. **Update `PRODUCT.md`** (decision 51, from `templates/PRODUCT.md`) with the answers and the taste profile. Record the design pick here once, never again in design.
4. **Hand off to the spec skill** with the research file, the intake record, the assumptions (each marked fixed constraint or delegated preference, decision 9) and the answers.

## Output

Write `docs/intake/<YYYY-MM-DD>-<short-slug>.md` from the bundled `references/intake-record.md`, filling every section. Read `references/principles.md` for the rationale behind the six intake rules. Bundled `templates/` and reference paths resolve relative to this installed skill, never the project cwd.

## Gotchas

- **Seven is a cap, not a target.** Put consequential past-data effects in the veto list when the question cap is reached.
- **"Where will you see it?" is usually a real question.** Agents skip the surface: which screen, page or export. If the request names no surface, ask.
- **Don't ask engineering questions to look careful.** Decide mechanisms and log them.
- **Unconfirmed isn't confirmed.** Keep the label all the way to the report; the user may veto any of them in the morning.
- **Never send anything outside the session and the runner.** Preparing an action is not permission to take it.
