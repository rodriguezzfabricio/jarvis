# Design negative control, run 2, round 3 (stage 4)

Oct 26, 2026. The integrator (Claude Opus 5.5) ran the third and last approved round of the design negative control on merged main (`0217e98`). The design reviewer's code is unchanged since `ccc1c1d`; policy hash `245fdcff…`. Only the private good fixture changed, so only its half ran again. Generic's round 2 calibration (same fixture, same policy, same ledger) still stands. As before, nothing from the fixtures is copied here beyond short quotes of the reviewer's findings.

**Result: passed.** Impeccable fails generic and passes good, in both scans. The reviewer failed generic in round 2, with all three friction choices and every planted choice flagged. In round 3 it passes good, with no high finding. With those two calibration entries in one ledger, a counted review of good was accepted, `counts: true`. This is the first time a design verdict has counted.

## What changed in the good fixture (private repo)

Exactly the three defects that round 2 and the coordinator named; nothing else changed:
- **History marks reach 3:1 non-text contrast.** The mark token goes from 1.93:1 to 3.43:1 against its surface. Both ratios come from the WCAG relative-luminance formula, not by eye. Filled marks stay solid; empty marks keep their outline and no fill.
- **A storage failure is visible and recoverable.** A refused write shows an inline alert with a "Try saving again" button. The change stays on screen, and a failed retry says so. A query switch forces the failure, so the runner can capture it.
- **The two typefaces `DESIGN.md` names now load.** They ship with the fixture as woff2 files (SIL OFL 1.1).
- **Offline reopening is left as it is.** The README records it as a known limit of a static fixture.

## How it ran

Same setup as rounds 1 and 2, from the private control's `review.mjs`. All six code checks ran through `runGate` in the srt sandbox. Then one fresh confined Codex `gpt-6-astra` session reviewed good, with `designSource: "new"`. The runner's four good flows:
1. Check off a habit on the returning person's week.
2. A first launch with an empty-name attempt; its empty state and validation are on one screen.
3. Add the first habit.
4. Add a habit while storage refuses, then retry.

The first-launch flow absorbed round 2's separate validation flow, because a review takes at most four flows. Two paid Codex sessions: the calibration review (64 s) and the counted review.

## Code checks, good fixture

| Check | Round 3 |
|---|---|
| `impeccable-source` | **pass** |
| `impeccable-url` (375 / 768 / 1440) | **pass** at every width |
| `ai-tells` | pass |
| `token-lint` | pass |
| `design-md-lint` | pass |
| `design-browser` | pass: 4 flows × 3 widths, axe clean |

Generic's checks are unchanged from round 2: both Impeccable scans, ai-tells, token-lint and design-browser (axe) fail; design-md-lint passes.

## Reviewer

| Round | Fixture | Purpose | Recorded verdict | Model's verdict | Quality / originality / craft / functionality | Weighted (pass ≥ 3.5) | Findings (high) | Friction recorded |
|---|---|---|---|---|---|---|---|---|
| 2 | generic | calibration | **fail** | fail | 2 / 1 / 2 / 2 | 1.65 | 17 (8) | all three |
| 3 | good | calibration | **pass** | pass | 4 / 4 / 4 / 3 | 3.85 | 3 (0) | none |
| 3 | good | counted | **pass**, `counts: true` | pass | 4 / 4 / 4 / 3 | 3.85 | 3 (0) | none |

**Good, round 3 (calibration), none blocking:**
- **[medium] "a mark only where it carries a fact".** The seven-day strips have "no visible timeframe or today indicator"; their accessible names say "last 7 days".
- **[medium] "Works offline; data stays on the device".** The runner "supplies no offline reopening or persistence verification". This is the README's known limit.
- **[low] Typography craft.** The empty week summary's last word ("off.") is stranded on its own line.

**Good, counted review, none blocking:**
- **[medium] Weekly marks.** A habit "New today" shows seven empty marks, the same treatment for the days before it existed and for days left unchecked.
- **[medium] Offline reopening.** Again unverified.
- **[low] The stranded word.**

None of these was fixed: they are not blockers, and round 3 is the last round.

## The calibration gate

- **Generic entry** (round 2, ledger entry `13a65f33…`): the model's verdict fail, with `launch-tour`, `multiple-primary` and `apologetic-error` recorded.
- **Good entry** (round 3, ledger entry `8bc6fda4…`): the model's verdict pass, recorded verdict pass, its code checks included.
- Both entries share policy hash `245fdcff…` in the same ledger. Given both, the design service ran a non-calibration review of good and recorded it as counting.
- In runs 1 and 2, the same request was refused before any Codex session.

## Caveats

- **Weaker evidence than a held-out pair.** Every change to the good fixture across the two runs followed a reviewer finding on these same fixtures, and the reviewer's design-source rule (decision 124) was found on them too. This pass is weaker evidence than a pass on a held-out pair of fixtures would be.
- **No production consumer yet.** The calibration lives in this control's own throwaway project. `jarvis run` has no design reviewer, and no cross-project calibration record exists yet (backlog 133).
- Backlog 134 and 137 are closed by this run.
