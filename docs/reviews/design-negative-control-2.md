# Design negative control, run 2 (stage 4)

Oct 26, 2026. The integrator (Claude Opus 5.5) reran the design negative control on merged main (`ccc1c1d`, decision 124; reviewer policy hash `245fdcff…`, unchanged since run 1's second round). Before the run, the private good fixture was fixed for the genuine defects run 1 found (backlog 134). The generic fixture is unchanged. As in run 1, nothing from the fixtures is copied here beyond short quotes of the reviewer's findings.

**Result: not passed, stopped after the two allowed rounds.** Impeccable fails the generic fixture and passes the good one, in both scans and both rounds. The reviewer fails generic in both rounds and flags every planted choice, the three friction choices included. It still fails good: in round 2 every score clears its threshold, but two high findings remain. Both are real defects of the good fixture (quoted below). No design verdict counts yet: a counted review was refused live, before any Codex session.

## What changed in the good fixture (private repo)

- **Before round 1** (backlog 134): habits and their dated check-offs are kept on the device. The date, today's count, streaks, seven-day marks and week summary are all derived from them, so the streak and the strip agree. The empty first run shows a real empty summary instead of invented history.
- **Before round 2:** round 1's one high finding was real. The fix had seeded a sample history into a normal first launch, so a first launch showed progress that never happened. A normal launch now starts with no habits; the returning person's sample week sits behind an explicit query parameter, in its own store.
- Styles, tokens, typography and the rest of the copy were not changed. The private README now has the reviewer recipe (backlog 137), and the two known detector gaps decision 125 closed were dropped from the control's expectations.

## How it ran

Same setup as run 1, from the private control's new `review.mjs`. Every check ran through `runGate` in the srt sandbox: both Impeccable checks, ai-tells, token-lint, design-md-lint, and design-browser (4 flows × 375/768/1440 px). The reviewer was confined Codex `gpt-6-astra` (decision 110), one fresh session per fixture, with `designSource: "new"`. Flows: the main job (check off a habit, on the returning person's week) and the first-value path (first launch, add the first habit), plus empty-name validation.

Round 2's good half first ran on a stale copy of the fixture: the harness reused round 1's fixture repo. Its first-run flow failed in the capture, and the review recorded `error` ("Unexpected end of JSON input"), never a verdict. After the harness was fixed to commit the current fixture on every run, the good half ran again on the current fixture. That completes round 2; it is not a third round.

Five paid Codex sessions (56 to 110 s each); no Claude task session.

## Code checks (same outcome in both rounds)

| Check | Generic | Good |
|---|---|---|
| `impeccable-source` | **fail**: `ai-color-palette`, `icon-tile-stack`, `kicker-above-heading`, `low-contrast`, `marketing-buzzword`, `overused-font`, `skipped-heading` | **pass** |
| `impeccable-url` (375 / 768 / 1440) | **fail** at every width | **pass** at every width |
| `ai-tells` | **fail**: includes `launch-tour`, `multiple-primary`, `apologetic-error` | **pass** |
| `token-lint` | **fail** | **pass** |
| `design-md-lint` | pass | pass |
| `design-browser` | **fail**: 12 pages, axe `color-contrast` (serious) | **pass**: 12 pages, axe clean |

Impeccable on its own still flags none of the three friction choices; `ai-tells` flags all three.

## Reviewer

| Round | Fixture | Recorded verdict | Model's verdict | Quality / originality / craft / functionality | Weighted (pass ≥ 3.5) | Findings (high) | Friction recorded |
|---|---|---|---|---|---|---|---|
| 1 | generic | **fail** | fail | 2 / 1 / 2 / 2 | 1.65 | 17 (8) | all three |
| 1 | good | **fail** | fail | 4 / 4 / 3 / 2 | 3.55 | 5 (1) | none |
| 2 | generic | **fail** | fail | 2 / 1 / 2 / 2 | 1.65 | 17 (8) | all three |
| 2 | good | **fail** | fail | 4 / 4 / 3 / 3 | 3.70 | 5 (2) | none |

**Generic, both rounds:** every planted choice is flagged. The launch tour, the two primary buttons and the gradient/default-font/identical-card/emoji template are high findings. The marketing copy ("Welcome to your dashboard") and the apologetic validation are medium. The reviewer also notes that `DESIGN.md` adopts these choices, "but this is a new direction and PRODUCT.md requests none of these tells" (decision 124's design source). It also found that rows added at runtime can't be checked off, and that nothing persists.

**Good, round 1:** functionality 2 and one high: "The supplied load() implementation instead populates an unused normal URL with sample habits and invented completion history. A real first launch therefore presents personal progress that never happened." Real; fixed before round 2.

**Good, round 2:** every axis is at least 3 and the weighted score is 3.70, but two high findings fail it. Verbatim:
- **[high] WCAG 2.2 AA; a mark only where it carries a fact**, seven-day history marks: "The informational marks use [the mark color] against [the surface color], approximately 1.9:1 contrast. Their filled and outlined states communicate daily history but fall below 3:1 non-text contrast. The supplied text-contrast checks do not establish compliance for these graphics." Fix: "Darken the history marks to meet 3:1 against the surface while retaining distinguishable filled and outlined states."
- **[high] Error states; device-local data**, persistence feedback: "The supplied save() implementation silently catches storage failures and then renders the ordinary success state. A habit or check-off can appear saved even though it will disappear after reload." Fix: "Expose persistence failure with actionable inline feedback, preserve the pending changes, and provide a retry. Supply runner evidence for this failure state."
- **Medium:** the two specified typefaces are named but never loaded. PRODUCT.md's "works offline" is not shown: no runner evidence of an offline reload, and local storage alone isn't an offline app.
- **Low:** a stranded last word in the empty week summary at 375 px.

Both highs are real defects. The first is a contrast failure in the fixture's own mark token, present since the fixture was written. axe, the only accessibility gate, checks text contrast, not graphics, so it never failed. Run 1 reported it as medium. The second comes from the persistence added for backlog 134. Neither the rubric nor the calibration rule was changed.

## The calibration gate, live

The good entry's verdict is fail, so `calibrated()` refuses. A counted review with this round's two calibration entries recorded `error`, "design reviewer has no passing negative control for this model and policy", before any Codex session started.

## Open

Backlog 134 stays open. The good fixture still needs:
- its history marks at 3:1 or better against the surface;
- a visible, recoverable save failure.

Then it needs a fresh pair of calibration reviews. Whether a static fixture must also show offline reopening and bundled fonts (medium findings, not blocking) is Fabricio's call. Each fix here followed a reviewer finding on these same fixtures, so a pass on them is weaker evidence than a pass on a held-out pair would be (decision 124).
