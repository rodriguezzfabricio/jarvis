# Plan review negative control, round 1 (stage 2b, the Goldfish lenses)

Nov 1, 2026. The integrator (Claude Fable 5.1) ran the Goldfish plan review's live negative control (`tests/live/plan-review-control.live.test.ts`, decision 170) five times on merged main, each run six fresh read-only `claude-opus-5-5` sessions (three lenses over the bad fixture, three over the good one, `tests/fixtures/plan-review/`). Policy hash of the passing run: `b7348066…` (the lens text was edited once, between runs 1 and 2; `plan-lenses.ts` has not changed since).

**Result: passed on run 5** (main `67c98e2`, 395 s): the bad plan fails naming all three planted scopes (T2's duplicate util, T3's storage left to the builder, D3's hard decision with no alternative), and the good plan passes with every lens valid and no blocker or major. Runs 1 to 4 failed, each time because the reviewers found a real defect in the fixture text, never because a lens misjudged; what they found and what changed is below, since it is the clearest evidence of what the lenses do.

## The five runs

| Run | Main | Bad plan | Good plan | What the good plan's majors were, and the fix |
|---|---|---|---|---|
| 1 | `9945faf` | `error` (zoom-out produced no verdict; the cause was not logged) | `fail` (blockers) | T2 wrapped a synchronous `appendFileSync` save in the async `retry()` while `cli.mjs` did not await `saveItem`; D3's "Why" claimed callers depended on retry timing when nothing called it; T1 and T3 restated work the repo already did; the checks covered half of AC2 and `item-list` passed on leftover state. Fix (lane `plan-control-fixtures`): one shared pre-state repo with no store, one check per criterion that resets and can fail for each half, no retry task in the good plan, per-lens diagnostics printed by the test, the lens text's output mandate spelled exactly. |
| 2 | lane | `fail` naming T2, T3, D3 (all lenses valid) | `resolve` (4 majors) | D2's rejection reason unverifiable; a torn last line could swallow the next save; how `add` reads argv unsettled; `item-blank` missed the line-break half of A2. Fixed in the lane before merge. |
| 3 | `5d32e3a` | `fail` naming T2, T3, D3 | `resolve` (3 majors; zoom-out pass) | Which characters count as a line break; the checks delete `data/items.jsonl`, a data-loss risk with no override; the newline-prefix rule's behaviour on an empty file. Fix: spec A2 names U+000A and U+000D; spec A4 makes the checkout's data file working data; the plan settles the prefix rule, the empty-list output and which task builds which part. |
| 4 | `baf345f` | `fail` naming T2, T3, D3 | `resolve` (1 major; critic and readiness pass) | The torn-line guard served the spec's "no recovery" non-goal (YAGNI, zoom-out). Fix: the good plan drops the guard; `saveItem` appends one line and nothing else. |
| 5 | `67c98e2` | `fail` naming T2, T3, D3 | `pass` | |

## What this shows

- **The lenses read the code, not the prose.** Every major in runs 1 to 4 cited a file and line (`store.mjs`, `cli.mjs`, the check scripts) or a register entry, and every one was true of the fixture. The runner's verdict stayed `resolve`, not `pass`, until the plan left the builder nothing to decide, which is the Zero-Decision Rule the readiness lens enforces (decision 170).
- **The three personas find different things.** The critic found false rationales and unaddressed failure modes; readiness found choices left to the builder and checks that could not fail; zoom-out found the one piece of work no criterion required. In run 4 the critic and readiness lenses passed while zoom-out alone held the plan at `resolve`.
- **The bad plan was never in doubt after run 1.** Four runs failed it with margin (run 2: 9, 12 and 11 findings across the lenses), always naming the three planted scopes.
- **Run 1's zoom-out `error` did not recur** in four later runs. Its ledger evidence was in a temporary folder the test removed, so the cause is unknown; the test now prints each lens's verdict, validity, `checked` list and error, and keeps the folder on failure, so a repeat is diagnosable (backlog 230 stays open until a cause is seen or the control passes often enough to call it noise).

## What counts, and what does not yet

A plan review counts only when the project's ledger holds a runner-written calibration pair for this model and policy hash whose bad entry is `fail` naming all three scopes and whose good entry is `pass` (decision 170, the design reviewer's pattern from decision 56). The test's own pair lived in its temporary ledger. The pair that counts is recorded with `jarvis plan review --calibrate bad|good` in a real project and published with `--save-calibration <bad>:<good>`; the hashes are in the ledger of the project it ran in, not here.

Not run: a Codex review of the Goldfish change (the installed Codex CLI is 0.166.0 against the 0.164.0 pin), the mutation confirm over the plan definitions (the fast runs on Nov 1 were verified by hand sweep, 25 of 25 caught, while the gate's control run kept timing out under worker load), and golden task 02 planned under the gate. Those remain stage 2b's proof per architecture §8.
