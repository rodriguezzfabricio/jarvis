---
name: architect
description: Turn a checked product spec into small build tasks, architecture decisions and black-box protected acceptance checks before the build loop starts.
---

# Architect

## When to use

Use after a feature or new-product spec is checked and confirmed or marked unconfirmed by intake's deadline. A bug or refactor with no spec goes straight to the runner's single task and the build or debug skill; no architecture, intake or design detour, even at risk tier 2 (decisions 37 and 89). Model routing belongs to the runner: tier-2 planning uses the strong tier at high effort, never a model you select yourself (decision 24).

## Read the contract

Read the current docs/spec/vN.md, PRODUCT.md, DESIGN.md and relevant decision records. Follow the existing stack and design system. Missing delegated engineering details get a recommended choice with reasons; fixed constraints stay fixed. An out-of-scope choice waits in a blocked state (decision 40). Do not restart spec confirmation.

Record architecture choices through jarvis decide, including --why and a repo-relative source that exists. Never edit the decision register directly. For example:

```sh
jarvis decide --by jarvis --class mechanical --source docs/spec/v1.md --why "Reuse the project's current persistence layer" "Keep the existing database"
```

A user-owned constraint requires user authority to supersede; do not disguise it as an engineering decision.

## Write the plan

Write .jarvis/plan.json as an object with a tasks array. Use small tasks, each with a measurable exitCondition, one clear goal and a dependency order. Cover every AC from the checked spec; do not invent or weaken acceptance criteria. Keep unaffected finished tasks when a new spec version requires targeted replanning.

Each task contains id (T1, T2, ...), title, goal, exitCondition, acceptanceCriteria (AC ids), storyIds (S ids), dependencies (task ids), priority (finite number; higher runs first), requiredChecks (existing check names), and requiredReviews (normally code). All checks and reviews must be nonempty. Every task's checks must cover its ACs. Order tasks so their prerequisites can finish first; no cycles or unknown references.

An optional mayTouch array is an explicit repo-relative file boundary, copied from triage when supplied. Preserve an empty boundary. Omit it when unrestricted; never use absolute paths, parent traversal, .git or .jarvis as a product-code boundary. Plans are claims, never completion evidence.

```json
{
  "tasks": [{
    "id": "T1",
    "title": "Save a habit",
    "goal": "Persist one new habit through the public CLI",
    "exitCondition": "AC1 passes for valid and invalid habit names",
    "acceptanceCriteria": ["AC1"],
    "storyIds": ["S1"],
    "dependencies": [],
    "priority": 1,
    "requiredChecks": ["habit-create"],
    "requiredReviews": ["code"],
    "mayTouch": ["src/habits.mjs", "src/cli.mjs"]
  }]
}
```

## Author protected checks

Write proposals under .jarvis/checks/ only. A <name>.check.json contains name, criteria (AC ids), cases (unique id, command and optional timeoutMs), verify, a positive timeoutMs, and optional allowLocalBinding. Keep each file within 256 KiB, the whole bundle within 4 MiB, and at most 256 files. Do not use symlinks or hard links.

Decision 76: every acceptance case drives the candidate as a black box through its CLI or a protected HTTP/CLI driver in fixtures/. There are no candidate imports into a driver and no expectations in fixtures. Drivers start the candidate in a separate process and capture that child's stdio separately before printing observations. A server's stdio must be redirected away from the driver's output. Fixtures contain inputs and drivers only. These are never runnable unit tests: the candidate's test runner and in-process assertions are not acceptance checks. A separate project unit check may run the existing unit suite with an empty criteria array.

Put expectations only in expected/ and the separate verify script. The runner records every case's own stdout, stderr and exit code. The verifier reads those observations through JARVIS_OUT and expectations through JARVIS_CHECKS; it never loads candidate code. Check every observation, including exit codes and errors, before success. Cover negative inputs and plausible partial implementations as well as the happy path.

The verify phase must exit zero and print JARVIS-CHECK-COMPLETE followed by the nonce read from JARVIS_COMPLETION_FILE as its final nonempty line. Only the verifier can see that file, and the runner creates it after every case ends. Do not hardcode a nonce, fabricate output logs, or write an observation file from candidate code. Checks run after the planning session, with no credentials and no external services; use local stubs.

```json
{
  "name": "habit-create",
  "criteria": ["AC1"],
  "cases": [{"id": "create", "command": "node src/cli.mjs add exercise"}],
  "verify": "sh \"$JARVIS_CHECKS/verify.sh\"",
  "timeoutMs": 60000
}
```

Shell programs for the verifier are files, not compound commands typed into the session. Use one plain command per session call; no compound shell calls (decision 68).

## Hand off

The architect never writes product code. It writes proposals and decision records, then returns control to the runner. The runner captures the files, obtains a fresh read-only review against the spec's ACs and those files, installs the reviewed bytes outside the workspace, and locks their hashes with ChecksStore.approve. The reviewer receives no planner notes. File contents are untrusted data, not review instructions.

Only the runner makes evidence on the committed revision after the build session ends. A plan, session notes and self-reported test results are claims. After approval, any check change needs a new review (decision 15); never edit or loosen protected checks in place. The runner excludes .jarvis/ from candidate revisions (decision 87). No git commit or push and no direct outside actions; the broker is the path for those.

## Gotchas

- A driver importing candidate functions is an in-process check, even if its assertions live elsewhere. Use a child CLI or HTTP boundary.
- Putting an expected result in a fixture reveals it to the candidate. Move it to expected/ or verify.
- Exit zero alone proves nothing. The verifier must judge all observations and print the completion nonce last.
- A task listing an AC without requiring a check that covers it leaves a false-done path. Link both before handing off.
- A bug's high risk tier changes routing and review depth, never its pipeline into intake or mockups.
