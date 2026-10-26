---
spec: 1
date: YYYY-MM-DD
status: draft
supersedes: none
---
# Spec v1

<!-- The versioned spec (decision 9), saved as docs/spec/vN.md. The spec skill fills it.
     Format contract (decision 83; `jarvis spec check` validates it):
     - Front matter exactly as above, with real values: `spec: N` matches the file name vN.md;
       `status` is draft, confirmed or unconfirmed; v1 has `supersedes: none`, vN has `supersedes: N-1`.
     - One optional `# Spec vN` line, then these six `##` headings, exactly, in this order, no others.
     - Every section is non-empty. Goals and Non-goals use bullets, or `None.`
     - Stories: `- **S1 (P1):** As …`, unique IDs, P1/P2/P3, listed in priority order.
     - Criteria: `- **AC1 (S1):** WHEN … THE SYSTEM SHALL …`, each naming an existing story;
       every story has at least one.
     - Assumptions: `- **A1 [fixed]:** …` or `- **A1 [delegated]:** …`, or `None.`
     - Open questions may be `None.`
     Prose and `###` subheadings are allowed inside a section.
     IDs are stable across versions; a removed ID is never reused. Delete these comments when filling. -->

## Goals
<!-- What must be true when this is done, from the user's side. Each goal passes the P0 test:
     "if we cut this, does it still solve the problem?" -->
- <goal>

## Non-goals
<!-- What this version deliberately doesn't do, each with a reason. Include what the project's
     own rules rule out (for example "No follow-up emails: backlog P4 forbids a follow-up campaign"). -->
- <non-goal>: <reason>

## User stories
<!-- Ranked P1 first. Each story is testable on its own. P1 stories together form the walking
     skeleton: one complete thin path from trigger to outcome. -->
- **S1 (P1):** As <who>, I want <what>, so <why>.
- **S2 (P2):** As <who>, I want <what>, so <why>.

## Acceptance criteria
<!-- EARS form. One observable behavior per criterion, checkable by a test without asking anyone.
     Include the first-value budget (decision 55) and the empty, error and offline cases. -->
- **AC1 (S1):** WHEN <event or condition> THE SYSTEM SHALL <observable behavior>.
- **AC2 (S1):** WHEN <event or condition> THE SYSTEM SHALL <observable behavior>.
- **AC3 (S2):** WHEN <event or condition> THE SYSTEM SHALL <observable behavior>.

## Assumptions
<!-- fixed: a constraint from the project or the user (cite the source).
     delegated: a choice the user left to Jarvis, including defaults (mark "unconfirmed" if the
     intake timed out). Tasks record which assumptions they depend on. -->
- **A1 [fixed]:** <constraint> (source: <path or "user, intake Qn">)
- **A2 [delegated]:** <choice> (default accepted | default unconfirmed | Jarvis, <reason>)

## Open questions
<!-- Questions that don't block the build, each with the default the build uses meanwhile.
     Blocking product questions belong in intake, not here. Write `None.` if there are none. -->
None.
