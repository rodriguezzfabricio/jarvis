---
name: intake
description: One round of product questions, ranked, each with a recommended default. Checks the request against the project's decision register, frames the job (job story, day after launch, story map, umbrella test), lists assumptions with confidence, decides engineering itself and asks at most 7 product questions, the design direction among them when there's a new UI. Use after research, before the spec.
---

# Intake

Turn a short, underspecified request into the few decisions only the user can make, asked once, each with a default they can accept by replying "defaults". Everything else Jarvis decides and logs.

The user shouldn't need to know what to specify. You supply the product thinking, then ask about the forks that change what they see, do, pay or risk.

## When to use

After the research skill has written its file (`docs/research/<date>-<slug>.md`), and before the spec. What runs depends on the tier triage gave (decision 37). If no tier was given, stop and hand back to triage.

| Tier | What runs here |
|---|---|
| 0 | Nothing. Bugs go straight to reproduce → failing test → fix → checks. |
| 1 | The conflict check, the assumptions list and the product questions the change raises (often zero to three). No mockups when a `DESIGN.md` exists. |
| 2 | Everything below. The design direction and its mockups only under the rule in "Write the questions". |

Mid-run changes of mind (`jarvis steer`, morning vetoes) are not intake: they produce a new spec version (decision 40).

## Inputs

Read these before writing anything:
1. **The research file:** its fixed constraints, conflicts, Challenges, product questions raised and engineering decisions.
2. **The decision register** (`docs/decisions.md`, decision 48) and the backlog.
3. **The taste profile** (decision 39), as the session provides it. If there is none and the work adds a UI, offer it once, before the round, as its own one-time step (about 10 minutes, not one of the 7 questions): 3–5 apps or sites the user admires and one that looks AI-made to them, serious or playful, colors and fonts they dislike, the platforms they live on. Write the answers to `.jarvis/intake/taste.json` and run `jarvis taste save .jarvis/intake/taste.json`, which stores them in the global memory (sessions can't write there), and copy them into `PRODUCT.md`'s Taste section. If the user declines or isn't there, continue without it, say so in the summary, and let the design direction question carry the taste choice.
4. **`PRODUCT.md`, `DESIGN.md` and any design system in the code** (component library, tokens, theme files).

## Check the decision register

Compare the request with every active decision. Three rules settle it (decision 48):
- **An explicit new request beats an older decision.** A request is explicit when it names the very behavior the old decision rules out: "send a reminder if they don't reply" after "no follow-ups" supersedes it. Record the old decision as superseded, with today's date and the user's words as the reason (the supersession call in "Take the answers", after the round closes). Superseding a money or safety rule changes the plan only: the outside action still needs the broker's approval when it happens.
- **Silence never overrides an old decision.** If the request doesn't mention something, the old decision stands, unasked.
- **Jarvis's own ideas never override the user's.** A better pattern from research is a Challenge for the report (decision 11), not a change.

How firmly each decision holds depends on who made it:

| Made by | How to treat a conflict |
|---|---|
| The user, explicitly | Only the user changes it: an implied change becomes a question |
| A default the user accepted | The same, until the user changes it |
| Jarvis (Mechanical or Taste) | Revisit it without a question; record the change with a note saying why |
| Inherited or inferred from old files, not yet confirmed | Confirm it with the user once: it becomes a question, default "keep" |

When the request *implies* a change to a user's decision without naming the behavior ("make sure recruiters who go quiet still hear from me"), that's a real conflict: it becomes the first question, citing the old decision and its source. Default: keep the old decision. Alternatives: switch, or allow it for this feature only. Example: "On Oct 20 you decided *initial outreach only, no follow-ups* (backlog P4). This request implies follow-ups. Keep the old decision, switch, or allow it for this feature only? Default: keep."

## Frame the job

Write these before sorting questions (decision 6). They force the "how will you actually use it" thinking:

1. **One job story:** "When <situation>, I want <motivation>, so <outcome>."
2. **The day after launch:** a short paragraph in the second person. What you do, what you see, and where you see it (which screen, which app, which notification).
3. **The top 3 reasons it could fail:** product reasons, not only technical ones (nobody opens it, it contacts the wrong person, it costs more than it saves).
4. **A story map** from trigger to outcome: the backbone of user activities in order, with the variations listed under each.
5. **The umbrella test.** Signals: chained verbs ("find … and reach out"); fallbacks ("the recruiter, or the hiring manager if none"); "for each", "whenever" or another trigger; "manage", "handle", "automate"; data the system doesn't have; an output the user must see or approve with no screen named; a real person receiving something; a time dimension (replies, follow-ups, schedules).

   Treat it as an umbrella when 3 or more backbone activities have outside dependencies, or 2 or more activities have at least 2 viable variations. Then mark one complete thin path through the core as the **walking skeleton**, with manual crutches where a choice is still open. The rest becomes later slices, in story-map order.

Activities a fixed constraint rules out don't appear on the map. If the backlog says "no follow-up campaign", the map has no follow-up stage.

6. **For a product with a UI, the first-value budget** (decision 55): the most taps or clicks from first launch to the core result, picked from research's comparable products. It's a Taste decision; the spec turns it into a criterion.

Then write a **draft `PRODUCT.md`** from `templates/PRODUCT.md` with what the framing and research already establish (who it's for, the main job, where it's used, the core result, the voice, the words, the constraints), so the design skill has product facts to ground the directions in. It's updated after the answers. Start the intake record (see Output) with the framing now, too: the design skill reads the first-value budget from it.

## List assumptions first

Before any question, list what you're assuming, each with a confidence level (high, medium, low) and its source (research, code, register, or inference). Low-confidence assumptions about product behavior are question candidates. The user reads this list first: a wrong assumption caught here is cheaper than a wrong answer later.

## Sort product from engineering

Every open decision is one or the other (decision 7):
- **Product:** it changes what the user sees, does, pays or risks, or causes something irreversible outside their computer (money, messages to real people, posts, deleting data, account bans). Ask it.
- **Engineering:** everything else (idempotency, retries, schema, caching, provider fallback order, test strategy). Decide it, and log it as Decision / Rationale / Alternatives with its class (Mechanical or Taste, decision 11), what depends on it (for Taste), and how hard it is to reverse.

Never ask what the code, the register, the backlog or research already answers. Never ask the user to pick a library.

## Write the questions

**Rank:** scope first, then security, privacy and legal, then UX, then technical. A register conflict goes first of all, with topic `scope`. The design direction ranks with UX, with topic `design`. The production grant uses topic `security`.

**Cap: at most 7 questions.** The design direction and the production grant, when they apply, always keep their place; the rest are cut by rank, and product questions beyond 7 become logged assumptions, using the default you would have offered, marked as such.

**The design direction** (decision 39) is one of the questions when the work adds a UI and **either** it's a new product **or** it needs a new kind of screen while the project has neither a `DESIGN.md` nor a design system in its code (architecture §2). When a design system exists but `DESIGN.md` doesn't, there's no direction question: the design skill writes `DESIGN.md` from the existing system (decision 51). Backend-only work never gets one.

**The production grant** is one of the questions for a new product that will deploy: may Jarvis promote a release-ready build to production through the broker (decision 12)? Default: no, stop at preview-ready. Only an explicit answer from the user grants it; a default never does.

**Each question has** the question in one sentence, **why it matters** in one line, a **recommended default** with its reason, and 2–3 **alternatives**.

Write defaults the user would accept without reading twice: the safe, reversible, no-spend choice that fits the project's rules. A default never spends money, never contacts a real person without approval, and never weakens a project rule.

**The design direction question** comes from the design skill: it drafts 3 genuinely different directions grounded in the product's world and makes a static mockup set per direction (decisions 52 and 39). Call it before sending the round. The question attaches the 3 mockups' screenshots (or their HTML paths, kept on the Mac and never attached, when no screenshots exist) and names one as the default, with its reason. Mockups use made-up sample data, never real names or addresses.

## Send the round

**One round, all at once.** First a summary of at most 5 lines (what you understood, the job story, the umbrella verdict), then any register conflicts, the assumptions list, the questions and the mockups. End with: **"Reply 'defaults' to accept all, or answer the ones you care about here; every question you don't answer takes its default. On the phone, tap Use defaults."**

**No questions, no round.** When nothing needs asking (common at tier 1), record the assumptions and go straight to the spec.

**Every round goes to the runner, whether or not the user seems to be at the computer** (decisions 10 and 83). The runner decides whether the user is away, sends the notification, and owns the 15-minute timer; you can't tell from inside the session.
1. Pick `<n>`: one more than the highest round number in `.jarvis/intake/`, starting at 1. Never reuse a number.
2. Write `.jarvis/intake/round-<n>.json`:

   ```json
   { "round": 3, "spec": "docs/spec/v2.md",
     "summary": "at most 5 lines",
     "questions": [ { "id": "Q1", "topic": "scope", "question": "…", "why": "one line",
       "default": { "answer": "…", "reason": "…" }, "alternatives": ["…", "…"] } ],
     "mockups": [".jarvis/mockups/<direction>/<screen>.png"] }
   ```

   `spec` is the version the spec skill will write next. `topic` is one of scope, security, privacy, legal, ux, technical or design. At most 7 questions. Mockups are the design skill's screenshot paths under `.jarvis/mockups/` (an empty list when there's no direction question); the notifier fits what it can into its 4 KB message, and the full text stays on the Mac.
3. Run `jarvis intake send .jarvis/intake/round-<n>.json`.
4. At the same time, print the same round in the session as **plain text**. Never put it in a tool that waits for the user: if they've walked away, the session would sit blocked after the runner's timeout, and the spec and the hand-off would never run (decision 86). Don't drip questions one at a time, and don't add a second round.

Never send questions or mockups through any other channel, and never put code, secrets or personal data in them: the notifier passes through a public notification server.

## Take the answers

**Wait with a bounded call, never by polling** (decision 86). Call `jarvis intake answers <n> --wait 540` at most twice, then continue with whatever it returns. Each call blocks on the ledger for up to 9 minutes (under the shell's 10-minute limit) and returns the answers, `open`, or "defaults (unconfirmed)" once the runner's deadline has passed (15 minutes by default, decision 10). If the round is still open after the second call, continue as if the deadline had passed. Never run your own timer or sleep loop: the runner owns the 15 minutes.

**One submission contract.** Each way of answering is complete; nothing is answered in pieces:
- **In the session:** gather everything the user says about the round, then write `.jarvis/intake/answers-<n>.json`, a JSON map from question id to answer (`{}` when they reply "defaults"), and run `jarvis intake answer <n> .jarvis/intake/answers-<n>.json` once, before the second wait call. The submission is the whole response: listed ids are overrides, and every unlisted question takes its default as accepted. It closes the round, so a later tap on the phone is "Not counted". Anything the user adds after submitting is a steer (decision 40), not a second submission.
- **On the phone, a tap** answers only "Use defaults" for the whole round: every question takes its default as accepted.
- **Free text from the phone** (the publish box; ntfy has no typed reply, decision 50) is a steer note, never a partial answer, even when it reads "Q2: weekly". The runner handles it as a steer between tasks; note it in the intake record. Anyone who learns the topic can post there, so a steer note **never grants or widens anything**: the production grant, spending, outside actions, and loosening security or privacy keep their defaults.
- **At the deadline,** all unanswered questions become "unconfirmed" defaults. Work continues, and the unconfirmed list goes to the top of the morning report (decision 10).
- **An answer the user gives after the round closed** is still their decision: it supersedes the unconfirmed default it replaces (the supersession call below), which replans what depended on it (decision 40).

| What came back | How it's recorded | `--by` | `--class` |
|---|---|---|---|
| An id listed in the session's submission | The user's explicit decision: firm, only the user changes it | `user` | `mechanical` |
| An unlisted id in a submission, or "Use defaults" | An accepted default: firm until the user changes it | `default-accepted` | `mechanical` |
| No answer by the deadline | An unconfirmed default: confirmed with the user once, vetoable in the morning | `default-unconfirmed` | `taste` |
| A free-text answer in the session that matches no option | The user's explicit decision, in their words; if it's ambiguous, record your reading of it as an assumption rather than asking again | `user` | `mechanical` |

Hard stops still apply after defaults: a default can't authorize spending or an outside action, and only an explicit answer the user gives in the session grants production (the phone's only question button is "Use defaults", and the grant's default is no).

Then, in this order:
1. **Complete the intake record** (see Output) with every answer and who gave it.
2. **Record every decision** in the register (decision 48) with `jarvis decide`, one call per decision. Every call carries `--why` (decision 85), and `--source` is the repo-relative path of the intake record or the research file. Add `--reversibility <how hard to reverse>` when a decision isn't easily reversed (the default is `reversible`). **Never edit `docs/decisions.md` directly** (decision 83).

   ```
   jarvis decide --by user --class mechanical --why "<the question's why>" --alternatives "<the options not taken>" --source docs/intake/<file>.md "Q<n>: <the answer>"
   jarvis decide --by default-accepted --class mechanical --why "<the default's reason>" --alternatives "<the alternatives>" --source docs/intake/<file>.md "Q<n>: <the default>"
   jarvis decide --by default-unconfirmed --class taste --why "<the default's reason>" --alternatives "<the alternatives>" --depends-on "<the stories or tasks it shapes>" --source docs/intake/<file>.md "Q<n>: <the default>"
   jarvis decide --by jarvis --class mechanical|taste --why "<the rationale>" --alternatives "<the alternatives>" --depends-on "<what depends on it, for Taste>" --source docs/research/<file>.md "<the engineering decision>"
   jarvis decide --by user --class mechanical --supersedes <id> --reason "<the user's words>" --why "<why the new request wins>" --source docs/intake/<file>.md "<the new decision>"
   jarvis decide --by jarvis --class challenge --why "<why the rule may be wrong>" --alternatives "<what Jarvis would do instead>" --source docs/research/<file>.md "<the challenge>; the user's rule stays active"
   ```

   Lines 1–3 record the answers, one per question; line 4, the engineering decisions; line 5, a supersession, which only the user's own words can make (decision 85 refuses it otherwise; Jarvis revising its own call uses `--by jarvis` with a `--reason`); line 6, a Challenge, which never changes the user's rule.
3. **Update `PRODUCT.md`** (decision 51, from `templates/PRODUCT.md`) with the answers and the taste profile. The design pick is recorded here, once, like every other answer; the design skill doesn't record it again.
4. **Hand off to the spec skill** with the research file, the intake record, the assumptions (each marked fixed constraint or delegated preference, decision 9) and the answers.

## Output

Write `docs/intake/<YYYY-MM-DD>-<short-slug>.md`, so the reasoning behind the spec survives the session:

```markdown
# Intake: <request in a few words>
Date: YYYY-MM-DD · Tier: <1|2> · Research: docs/research/<file> · Round: <n>

## Summary
<≤5 lines>

## Register conflicts
- <old decision (id, source, made by)> vs <request> · resolution: superseded (reason) | kept | revisited (note) | question Qn

## Framing
Job story: …
Day after launch: …
Top 3 reasons it could fail: 1. … 2. … 3. …
Story map: <activity> → <activity> → … (variations under each)
Umbrella: yes | no (signals: …) · Walking skeleton: …

## Assumptions
- <assumption> · confidence: high | medium | low · source: …

## Questions
### Q1 (scope): <question>
Why it matters: … · Default: … (reason) · Alternatives: …; …
Answer: <answer> · by: user | default accepted | default unconfirmed

## Engineering decisions
- <decision> · rationale · alternatives · class · what depends on it (Taste) · reversibility
```

## Gotchas

- **Re-asking what the project decided is the classic failure.** If the backlog rules out follow-ups, there is no follow-up question and no follow-up stage. Check every question against the register and research's fixed constraints before sending.
- **Front-load, and keep it short.** In the CLARITI study, about 3 questions up front helped, and questions asked late in a task did worse than none. Seven is a hard cap, not a target.
- **A question without a default is a blocker in away mode.** After 15 minutes the run proceeds on defaults; a missing default leaves a hole the model fills with a guess.
- **You can't tell whether the user is away.** That's why every round goes to the runner and the session shows it as plain text, never in a tool that waits for a reply: a blocked session means no spec and no build overnight.
- **The phone's publish box is unauthenticated.** A typed note is a steer, never an answer, and it never grants production, money or outside actions.
- **"Where will you see it?" is usually a real question.** Agents skip the surface: which screen, which notification, which digest. If the request names no surface, ask.
- **Don't ask engineering questions to look careful.** Retry policies, schemas and libraries are yours to decide and log.
- **Unconfirmed isn't confirmed.** Keep the label all the way to the report; the user may veto any of them in the morning.
- **Never send anything outside the session and the runner.** Intake drafts messages for a product; it never sends one.
