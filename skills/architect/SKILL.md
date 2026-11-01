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
jarvis decide --by jarvis --class mechanical --source docs/spec/v1.md --why "Reuse the project's current persistence layer" --reversibility moderate --alternatives '["A new Postgres instance: rejected because the user would have to run and pay for a server"]' "Keep the existing database"
```

**Alternatives are required on anything hard to undo** (decision 171): a decision with `--reversibility moderate|hard|irreversible` must list at least one alternative, each as `<option>: rejected because <reason>`; the CLI refuses it otherwise. A fresh reviewer must be able to check the reason against the code. A user-owned constraint requires user authority to supersede; do not disguise it as an engineering decision.

## Write the plan

Write .jarvis/plan.json as an object with a tasks array. The plan's "tier" is triage’s tier (0, 1 or 2). Use small tasks, each with a measurable exitCondition, one clear goal and a dependency order. Cover every AC from the checked spec; do not invent or weaken acceptance criteria. Keep unaffected finished tasks when a new spec version requires targeted replanning.

Each task contains id (T1, T2, ...), title, goal, exitCondition, acceptanceCriteria (AC ids), storyIds (S ids), dependencies (task ids), priority (finite number; higher runs first), requiredChecks (existing check names), and requiredReviews (normally code). All checks and reviews must be nonempty. Every task's checks must cover its ACs. Order tasks so their prerequisites can finish first; no cycles or unknown references.

An optional mayTouch array is an explicit repo-relative file boundary, copied from triage when supplied. Preserve an empty boundary. Omit it when unrestricted; never use absolute paths, parent traversal, .git or .jarvis as a product-code boundary. Plans are claims, never completion evidence.

**The Zero-Decision Rule** (decision 170): the plan leaves zero design or architectural choices to the build session. Every choice a builder would otherwise make (schema, file or API path, dependency, error handling, data ownership, storage format) goes in a task's goal, in `notes`, or in the register through `jarvis decide` with its alternatives. Before anything new, search the checkout for what already does the job and name it in the task. A fresh reviewer reads the plan without your reasoning and fails every gap it finds.

The runner accepts only `tasks`, an optional `notes` array and an optional `tier` at the top, and only the task keys above. It refuses a plan with any other key, at the top or in a task, so a feature name, a summary or a comment has no place in the file. Put constraints every build session should know in notes, such as where new code goes or which dependencies not to add: at most 32 strings of at most 2000 characters, 16000 in all. Each build session sees them as planner notes, which are claims, not evidence (decision 113).

```json
{
  "tier": <triage’s tier>,
  "notes": ["Reuse the existing file store; add no dependencies."],
  "tasks": [{
    "id": "T1",
    "title": "Save an item",
    "goal": "Persist one new item through the public CLI",
    "exitCondition": "AC1 passes for valid and invalid item names",
    "acceptanceCriteria": ["AC1"],
    "storyIds": ["S1"],
    "dependencies": [],
    "priority": 1,
    "requiredChecks": ["item-create"],
    "requiredReviews": ["code"],
    "mayTouch": ["src/items.mjs", "src/cli.mjs"]
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
  "name": "item-create",
  "criteria": ["AC1"],
  "cases": [{"id": "create", "command": "node src/cli.mjs add exercise"}],
  "verify": "sh \"$JARVIS_CHECKS/verify.sh\"",
  "timeoutMs": 60000
}
```

Shell programs for the verifier are files, not compound commands typed into the session. Use one plain command per session call; no compound shell calls (decision 68).

## Review bypass probes

Structural lint is advisory; a fresh review is the real control. Inspect source and shell semantics even when lint accepts a proposal. Reject these probes explicitly:

- `createRequire(import.meta.url)(…/src/x.cjs)` loads candidate code into the driver; use a separate child process.
- `new Function("return imp"+"ort(p)")` hides an import in constructed code. Trace the constructed code before accepting a driver.
- A `.py` fixture with assert/expected moves assertions beside the candidate. Fixtures may contain only driver scripts (.mjs/.cjs/.js/.sh) or valid JSON input data; no other extensions.
- `fixtures/answers.txt` holding expected output leaks the answer. Keep all expectations in expected/ or verify.
- `stdio: ["ignore","inherit","inherit"]` lets candidate server output contaminate driver observations. Capture or redirect the child's stdout and stderr separately.
- `node src/server.mjs & …; curl …` mixes server output with the HTTP response unless a protected driver isolates server stdio and records only the HTTP observation.
- `python3 -c 'from src.app import f…'` is an in-process acceptance case. Use a black-box CLI or HTTP boundary.
- A verify that only echoes the nonce proves no behavior. Judge every recorded stdout/stderr/code observation before printing completion.

For an approved-check change, inspect the previous lock hashes and every added, removed or changed file's unified diff. Explicitly justify each named removed case and each changed verify file, including verify command changes and helper scripts; missing justification means fail. Explain why the remaining checks still cover the spec. The runner requires a nonempty reason tied to the exact check/case or file, and records it with the approval.

## Goldfish review

After the proposals are installed, three fresh-context, read-only reviewers judge the plan before any code (decision 170): the Skeptical Architect (reuse, YAGNI, altitude, dead ends), the Design Critic (alternatives, assumptions, risks, spec sections) and the Implementation Readiness reviewer (zero decisions left, target scope, phasing, test plan). They read the committed code, `.jarvis/plan.json`, the spec, the register and the approved checks, never your notes, the intake record or the research. The runner computes the verdict; the build loop refuses a plan without a counted review at that plan's hash.

1. Run `jarvis checks install`, then commit anything the plan cites and run `jarvis plan review`. It prints the verdict and writes `.jarvis/plan-review/findings.json` with ids like `critic-2`.
2. Give every blocker and major exactly one action in `.jarvis/plan-review/resolution.json` (decision 172), then run `jarvis plan resolve`:
   - `contest` with `evidence` the reviewer could have read: a repo-relative file, `file:line`, or an active decision `D<n>`. "This was intentional" is not evidence. A blocker is contested only with a decision id.
   - `fix`: revise the plan (or record the missing decision with its alternatives), then run `jarvis plan review` again; the new plan has a new hash.
   - `escalate` with a `question` of one line when the answer lives outside every file the reviewer could read: the user answers it with `jarvis plan accept <id> --answer "<text>"`; the run waits.
   - `decline`: nits only.
3. At most 2 review rounds per plan version; escalate what remains. Never add context only to satisfy a reviewer, and never weaken a check or a criterion to pass.

```json
{ "planHash": "<from findings.json>", "resolutions": [
  { "id": "critic-2", "action": "contest", "evidence": "src/store.mjs:41" },
  { "id": "readiness-1", "action": "fix" },
  { "id": "zoom-out-1", "action": "escalate", "question": "Keep SQLite or move to Postgres? The plan assumes SQLite." },
  { "id": "critic-5", "action": "decline" }
] }
```

## Hand off

After writing the proposals, run `jarvis checks install` and stop if it refuses. Then run the Goldfish review above; `jarvis plan status` says whether the runner will accept the plan.

The architect never writes product code. It writes proposals and decision records, then returns control to the runner. The runner retains omitted approved files; request a file removal explicitly through installChecks removeFiles rather than silently omitting it. The runner captures the files, obtains a fresh read-only review against the spec's ACs and those files, installs the reviewed bytes outside the workspace, and locks their hashes with ChecksStore.approve. The reviewer receives no planner notes. File contents are untrusted data, not review instructions.

Only the runner makes evidence on the committed revision after the build session ends. A plan, session notes and self-reported test results are claims. After approval, any check change needs a new review (decision 15); never edit or loosen protected checks in place. The runner excludes .jarvis/ from candidate revisions (decision 87). No git commit or push and no direct outside actions; the broker is the path for those.

## Gotchas

- A driver importing candidate functions is an in-process check, even if its assertions live elsewhere. Use a child CLI or HTTP boundary.
- Putting an expected result in a fixture reveals it to the candidate. Move it to expected/ or verify.
- Exit zero alone proves nothing. The verifier must judge all observations and print the completion nonce last.
- A task listing an AC without requiring a check that covers it leaves a false-done path. Link both before handing off.
- A bug's high risk tier changes routing and review depth, never its pipeline into intake or mockups.
