# Design negative control, run 1 (stage 4)

Oct 26, 2026. The integrator (Claude Opus 5.5) ran the design negative control (docs/02-golden-tasks.md, decision 56) through the merged design reviewer and Impeccable checks on branch `lane/design-reviewer` (decision 124). The fixtures live in the private eval repository; nothing from them is copied here beyond short quotes of the reviewer's findings.

**Result: not passed.** Impeccable fails the generic fixture and passes the good one. The reviewer fails the generic fixture in both rounds and flags all three friction choices. It also fails the good fixture in both rounds, so its calibration does not pass and none of its verdicts count yet (the service refused a counted review live, see below). The good fixture's blocking findings are real defects in that fixture (backlog 134).

## How it ran

- **The real gates.** A throwaway project under `~/.jarvis-work/design-control-1` with an approved checks store: `installDesignChecks` (the engine copied into the protected fixtures, hash-checked), a QA toolchain materialized into the protected fixtures (Playwright 1.64.1, axe-core 4.14.0, Chrome Headless Shell 151.0.7922.34), and runner-owned `ai-tells`, `token-lint` and `design-md-lint` checks. The case collects the sources and the verify phase runs `lanes/tells.ts` and `lanes/design.ts` on them; production has no such definitions yet (backlog 133). Every check ran through `runGate` in the srt sandbox, against a git revision of each fixture. The runner served each fixture on 127.0.0.1, outside the sandbox; the cases reached it through `allowLocalBinding`.
- **The real reviewer.** `createDesignReviewService` with the default reviewer: the pinned Codex 0.164.0, `gpt-6-astra` at high effort, inside decision 110's Seatbelt profile and CONNECT proxy, with the canary probe and the screenshots attached with `-i`. One fresh session per fixture, never both in one (decision 56). Material: the fixture's `DESIGN.md`, its "Principles" line as the principles, and the shared `PRODUCT.md` without its preamble, which names the control and its two fixtures. Round 2 adds `designSource: "new"`, because both `DESIGN.md` files are directions picked for a new product.
- **Two rounds.** Round 1 ran at `dc7b014` (policy hash `42d33135…`) with two or three flows per fixture. Round 2 ran at `79ee7af` (policy hash `245fdcff…`) after two changes. First, the reviewer fix found in round 1 (the design source, below). Second, four flows per fixture covering `PRODUCT.md`'s main job and first-value path: check off a habit, add the first habit, add one with an empty name, and the first launch or empty first run. Round 1's flows had shown neither a check-off nor a successful add.
- **Cost:** four paid Codex sessions (42 to 81 s each). No Claude task session ran.

## Code checks (identical outcome in both rounds)

| Check | Generic | Good |
|---|---|---|
| `impeccable-source` (engine 0.1.16, `--no-config --no-inline-ignores`) | **fail**: `ai-color-palette`, `icon-tile-stack`, `kicker-above-heading`, `low-contrast`, `marketing-buzzword`, `overused-font`, `skipped-heading` (advisory: `bounce-easing`) | **pass**: no findings |
| `impeccable-url` (`--cdp`, the runner's single-process Chromium, 375 / 768 / 1440) | **fail** at every width: `ai-color-palette`, `icon-tile-stack`, `low-contrast`, `overused-font`, `skipped-heading`, plus `kicker-above-heading` (375) or `hero-eyebrow-chip` (768, 1440) | **pass** at every width |
| `ai-tells` (`lanes/tells.ts`) | **fail**: `apologetic-error`, `bouncy-easing`, `button-arrows`, `default-font`, `emoji-icon`, `eyebrow`, `generic-copy`, `launch-tour`, `multiple-primary`, `purple-gradient`, `submit-copy` | **pass** |
| `token-lint` | **fail**: `off-scale-spacing`, `off-scale-type`, `raw-color`, `unknown-font` | **pass** (`tokens.css` named as the generated token file) |
| `design-md-lint` | pass | pass |
| `design-browser` (named flows × 3 widths, isolated axe) | **fail**: every flow completed (12 pages in round 2); axe `color-contrast` (serious) at every width | **pass**: 12 pages, axe clean |

**Impeccable alone misses the three friction choices.** No Impeccable rule names the launch tour, the two primary buttons or the apologetic validation, in the source scan or at any width of the URL scan. `ai-tells` (`lanes/tells.ts`) catches all three (`launch-tour`, `multiple-primary`, `apologetic-error`). The golden task's "both the detector and the reviewer must flag the friction choices" therefore holds for Jarvis's detectors together, not for Impeccable on its own.

## Reviewer

| Round | Fixture | Recorded verdict | Model's verdict | Quality / originality / craft / functionality | Weighted (pass ≥ 3.5) | Findings (high) | Friction recorded |
|---|---|---|---|---|---|---|---|
| 1 | generic | **fail** | fail | 2 / 2 / 2 / 1 | 1.85 | 12 (6) | all three |
| 1 | good | **fail** | fail | 3 / 4 / 3 / 2 | 3.20 | 5 (2) | none |
| 2 | generic | **fail** | fail | 2 / 1 / 2 / 2 | 1.65 | 17 (8) | all three |
| 2 | good | **fail** | fail | 3 / 4 / 3 / 2 | 3.20 | 5 (3) | none |

**Generic, round 1:** the reviewer flagged the launch tour (high), the two primaries (high), the apologetic error (medium: "frames a missing name as a system failure") and the generic copy. It excused the default theme as inherited: "This finding concerns product content, not the inherited Inter, violet palette or card shapes." The lane's instruction "Existing design systems keep their inherited choices" let a newly picked `DESIGN.md` excuse decision 53's tells. Four of the eight planted choices went unflagged (default theme, purple gradient hero, identical cards, emoji icons). Fixed in round 2: the material says whether `DESIGN.md` is new or existing, and only an existing product's own system is inherited (decision 124).

**Generic, round 2:** all eight planted choices were flagged. Default theme, gradient, cards and emoji came in one high "product-specific-originality" finding: "purple gradient, default Inter throughout, centered hero, three identical rounded feature cards, emoji tiles". The copy got a medium voice finding (the hero's "Welcome to your dashboard" and the tour's "supercharge"). Launch tour and two primaries were high, the apologetic error medium. The reviewer also found two functional defects a code check would miss: rows added at runtime get no check-off handler, and nothing persists.

**Good, both rounds:** fail. Round 2's high findings:
- "The empty account and newly added Drink water habit both report 12 check-offs and a 12-day reading streak." The week summary is static and stays on the empty first run and after the first add.
- The reading row "claims a 12-day streak while showing a missed day within the last seven days"; the date, streaks and marks are hardcoded.
- No persistence ("changes DOM state without saving or restoring habits"), against `PRODUCT.md`'s "works offline; data stays on the device".

The mediums: the empty state appears only with `?empty`, and the stylesheet names two typefaces it never loads. In round 1 the reviewer also asked for evidence of a successful add and a check-off, which round 2's flows supplied. That raised no score. The first two highs are true of what the good fixture shows. The third is true of a static mock and arguably outside a design review (backlog 134).

## The calibration gate, live

`calibrated()` needs a generic entry whose model verdict is fail and which names all three friction rules (met in both rounds), and a good entry that passes (not met). A non-calibration review of the good fixture was asked with round 2's entries as the calibration: the service refused it before starting Codex, in 0.5 s, recording `error` with "design reviewer has no passing negative control for this model and policy". Round 1's entries carry the old policy hash and no longer count either.

## What happens next

The reviewer side of the control passes only once a good fixture passes. Backlog 134 asks to fix the private good fixture: a summary derived from its data, a streak that matches the strip, fonts that load, and local persistence or a recorded decision that the design reviewer doesn't grade storage. Then rerun both fixtures with the current policy and keep the two passing entries' hashes for the service. These results were used to change the reviewer once (the design source), so a pass on these same fixtures is weaker evidence than a pass on a held-out pair would be.
