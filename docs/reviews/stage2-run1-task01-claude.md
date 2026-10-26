# Stage 2 proof, task 1 (recruiter finder): Claude judge verdict

Judge: fresh `claude-opus-5-5` worker, independent (decision 105). Read: `task01/transcript.md`, every file in `task01/artifacts/`, the snapshot's `IMPLEMENTATION.md`, `docs/google-oauth-verification.md`, `openspec/specs/application-followup-draft/spec.md`, and the plugin's `skills/intake|research|spec/SKILL.md`. I read no other judge's output.

**Questions: 2 / 5.** The questions are well formed, but a senior PM who had read the project would not have asked several of them as written.
- Q1 (who sends), Q3 (where "Reach out" shows up) and Q7 (LinkedIn-only contact) are good questions with good defaults.
- Q2 has the right topic and the wrong default. The request is "finds the recruiter", and the default de-scoped it: "You enter it; freehire pre-fills a person who already emailed you … and never guesses." That default rests on an unresearched claim from the round summary: "No job source freehire reads names a recruiter, so finding one means you, your inbox, or a paid service" (`round-1.json`). It also yields almost nothing in this fork, where Gmail isn't connected (`IMPLEMENTATION.md`: "No … account connection … is authorized").
- Q4 and Q5 were framed for a multi-member product: "Free template, or an AI-personalised note for Pro?" and "Shared per company with other members". `IMPLEMENTATION.md` line 3 says "Fork of FreeHire for a private, single-user job application automation". The session admitted afterwards: "reading `IMPLEMENTATION.md` for the personal-only scope I missed."
- Q6 re-asks something the request already settles ("the recruiter …, or the hiring manager if it can't find one"). Choosing one labelled slot or two slots is Jarvis's call.

**Vetoes: 6**
1. Assumption veto: "It's for every freehire member, not a personal tool (medium)". It contradicts `IMPLEMENTATION.md:3` and the "Personal-only scope" section.
2. Rejected default, Q2 ("You enter it … never guesses"). It drops the core of the request and is built on the unchecked "you, your inbox, or a paid service" premise.
3. Rejected default and framing, Q4 ("A fixed template, free for every account", alternatives "Pro only"). Pro versus free has no audience in a single-owner fork.
4. Struck question, Q5 ("Who can see a contact you save?"). It is moot with one owner, and sharing with other members cannot happen.
5. Struck question, Q6 (one labelled contact versus two slots). The request gives the fallback rule, and the slot layout is a design decision to log, not to ask.
6. Assumption veto: A21 together with AC47 ("'Copy' records the intro as in AC29") and AC31 (no further draft to that address ever). A stray Copy blocks a person for good, and no criterion undoes it. The stand-in noticed this and let it pass; I wouldn't.

**Number of questions asked: 7** in the intake round (Q1–Q7 in `round-1.json`, plus 4 printed assumptions). Round 2 added 1 `CONFIRM`, which is the spec skill's designed one-time confirmation and doesn't count against the cap.

**Each rubric line:**
- **Found the project's own rules first and didn't ask about them: NO.**
  - What it found: `followup.go:31` "nothing here sends mail", the assistant's "No tool sends mail", and the `gmail.readonly`-only scope.
  - What went wrong:
    - It still asked Q1 "Who sends the intro?".
    - It grepped `IMPLEMENTATION.md` without reading it, and so missed the single-user rule.
    - "No follow-up" appears only as a medium-confidence assumption with no source.
    - Q2 offered "a paid people-lookup service … as a Pro feature".
  - Gap to note: the P4 backlog (exact approval hash, send-only Gmail scope) is not in the snapshot (`486c357`). A grep finds no approval contract, and `docs/google-oauth-verification.md` says "We do not request `gmail.modify`, `gmail.send`".
- **Research before questions (contact finders and free tiers, LinkedIn terms, ATS team data): NO.**
  - Research revision 1 says "Web: none", and round 1 went out at 19:04:41 with "cost and terms not yet checked".
  - Hunter (50 a month, no card), Apollo, Snov and Skrapp ("no API on the free tier"), LinkedIn User Agreement §8.2, and "Greenhouse, Lever, Ashby: no person field" arrived only in revision 2. That was 19:08–19:18, after the stand-in demanded it.
  - Revision 2 used live web, against the rubric's "recorded snapshots only" (decision 70).
  - It doesn't note that Greenhouse and Lever expose department and team.
- **Mapped trigger → find people → pick target → get channel → draft → approve → send, with no follow-up stage: NO (partial).**
  - The intake record's map is "Apply → Find the contact → Find the address → Draft → Send (by you) → Record … (No follow-up stage, by D9.)".
  - "No follow-up" is right, but "pick the target" and "approve" are folded into other stages, not mapped.
  - The round-1 skeleton had no finding stage at all: "contact you enter … -> template intro -> your mail client".
- **At most 7 questions, each with a default, one about where you see the drafts: YES.**
  - Q1–Q7 each carry a `default.answer` and `reason`.
  - Q3 "Where and when is 'Reach out' offered?" (card, or the card's menu, or a "to send" list) is the question about where the drafts appear.
- **Decided engineering itself (idempotency, provider fallback chain, provenance, suppression list): YES**, all without asking. Two of the four are weak.
  - Fallback chain: the spec's "Lookup order", D11 and D15, with Exa as the swap-in.
  - Provenance: each contact has a source, a source URL and a confidence, and D16 requires every name and address to appear verbatim in its source.
  - Idempotency (weak): one lookup or contact row per user and job (AC2), and the intro dedupe in AC30 is a one-hour window rather than a key per application and contact.
  - Suppression (weak): AC31 blocks a second intro to the same email or link, but it covers only people already contacted. There is no do-not-contact list and no undo.
- **Sent nothing: YES.**
  - The command log shows no SMTP, Gmail or other send call. `jarvis run --detach` was denied by the CLI rule.
  - AC27 and AC40 forbid send code. The web calls were reads only, and there was no signup (the Tavily key is left to the owner).

**Jarvis defects a user would notice, most serious first:**
1. **It asked before it researched, and the core default suffered.**
   - Round 1 stated a false premise as fact ("finding one means you, your inbox, or a paid service") and defaulted to manual entry for a feature whose whole point is finding.
   - The finder check (company pages, JSON-LD `applicationContact`, Tavily or Exa free tiers, Hunter's free tier) only happened because the user asked for it in his answer.
   - Root causes: the plugin ships no `agents/` folder (no `researcher` and no `spec-reader`; `ls plugin/agents` → "No such file or directory"), and the run had no recorded research fixture.
2. **It skipped the project's own scope document.**
   - Before round 1 it grepped `IMPLEMENTATION.md` but didn't read it.
   - The user had to correct the "every freehire member" assumption, and Q4 and Q5 spent two of the seven slots on an audience that doesn't exist.
3. **Live web ran through ordinary Explore subagents instead of the quarantined researcher role.**
   - That was 129 WebFetch and 55 WebSearch calls, against the research skill's "Live web only through the researcher role … Don't call web tools yourself" and decision 70.
   - The quarantine was only a prompt line ("do not run shell commands"), and Explore agents have Bash.
   - The session also tried `ls ~/.jarvis-work/stage2-proof/`, the folder that holds `ratings.md`, and the stand-in denied it.
4. **Answering was clumsy.**
   - The first `jarvis intake send` failed schema validation ("questions.4.alternatives: Too small").
   - `jarvis intake answers 1 --wait 540` blocked in the foreground, so the only way to answer was Esc. That ended the turn with `error_during_execution`, and round 2 skipped the wait altogether.
   - Both rounds told the user "a tap on your phone works", though no runner was running.
5. **The "confirmed" spec contradicts itself in places.**
   - It still lists the Hunter question under Open questions after D25 answered it, cites the superseded D12, and its header says "D1–D24" although D25–D27 exist.
   - D22 adds "50 a day for Pro and Ultra" metering to a tool where D8 says plan pricing doesn't apply.
   - Provenance doesn't line up: the ledger records round 2 as `"defaults (accepted)"` with `"by":"session"`, yet the session wrote D8–D10 and D25–D27 as `--by user` itself.

**VERDICT: FAIL.**
- The questions score 2, below the required 4.
- Two rubric lines are "no" (project rules first, research before questions) and a third is only partial (the map). The pass rule allows at most one "no".
- "Sent nothing" is "yes".
- On the 12-row task rubric this is about 7 of 12, short of the 10 needed, and the required row 1 fails.
- The spec it finally produced (D11–D24, 61 acceptance criteria, two fresh-reader passes) is strong. It became strong because the stand-in overrode Q2 and Q4 and demanded the research, not because intake got it right first.
