---
name: design
description: Product and UX design that doesn't look AI-made. Grounds three genuinely different directions in the product's world, makes static mockups for the user to pick from, writes DESIGN.md and its tokens from the pick (or from an existing design system), and sets up the code checks, UX checklist and skeptical review that judge the result. Use for a new product or a new kind of screen; never for backend-only work.
---

# Design

Give the user a real choice of direction without asking them to describe colors or layouts, then hold the build to that choice with tokens and checks that code runs. The user picks; models make, check and explain, but never pick winners (decision 56).

## When to use

Three entry points, each called by another step:

| Called by | When | What runs here |
|---|---|---|
| Intake, before the round | A new product, or a new kind of screen while the project has neither `DESIGN.md` nor a design system in its code | Draft three directions and make the mockups. Return the mockup paths and the default direction to intake |
| The pipeline, after the answers | A direction was picked, or defaulted | After the pick: write `DESIGN.md` and the theme plan |
| Intake or the pipeline | A design system exists in the code but `DESIGN.md` doesn't | An existing design system: write `DESIGN.md` from it |

Backend-only work never gets this skill. A feature that fits the existing screens follows `DESIGN.md` and runs only the checks. A UI bug (a misaligned button) runs the checks on that one screen and never asks about direction or makes mockups (architecture §2).

## Inputs

Read before drafting anything:
1. **`PRODUCT.md`** (decision 51): who it's for, the main job, where it's used, the voice, the words, the constraints. The intake skill drafts it before calling you.
2. **The taste profile** (decision 39), from `PRODUCT.md`'s Taste section: apps the user admires, one that looks AI-made to them, serious or playful, colors and fonts they dislike, their platforms. If there's none, say so in each direction and lean on the domain instead of on your own average taste.
3. **The product research** in `docs/research/` (decision 52 step 2): the 3–5 real products studied, their conventions and where there's room to stand out.
4. **The intake record:** the first-value budget, the story map and the walking skeleton, which decide the main screens.
5. **Any existing design system:** component library, theme files, tokens, and the screens already built.

## An existing design system

When the project already has one, there are no directions and no mockups. Write `DESIGN.md` from the code (decision 51): read the theme and token files, the component library and the most-used screens, and record the colors, type, spacing, corners and components that are actually in use, citing the file each came from. Where the code is inconsistent (three grays that mean the same thing), record what's there and list the inconsistency under Do's and Don'ts; don't fix it here.

Then follow it. Any change to an existing design system is a Taste decision (decision 11): record it with `jarvis decide --by jarvis --class taste --source DESIGN.md`, with what depends on it, so the user can veto it in the morning.

## Draft three directions

Decision 52, in order:
1. **Ground it in the subject.** Distinctive choices come from the product's world: its industry, materials, vocabulary and audience. Write down five concrete things from that world (objects, places, rituals, words) before any color or font. A toy for kids and a finance dashboard should look nothing alike.
2. **Use the 3–5 real products** from research. Note the conventions to keep, because people expect familiar patterns (Jakob's law): where navigation lives, what a list row shows, the words for things. Be original in identity, not in where things are.
3. **Draft three directions as compact plans.** Each one has:
   - a name drawn from the product's world,
   - 4–6 named colors with hex values and their jobs (one accent, tied to the primary action or a warning),
   - 1–2 typefaces and their roles,
   - a layout concept with a rough text wireframe of the main screen,
   - 2–3 principles that decide close calls,
   - its settings on three dials: layout variance, motion and density, each low, medium or high.

   The three must differ in layout, flow and information hierarchy, not just color: a different first screen, a different way into the core task, a different thing that leads the eye. No two directions share all three dial settings.
4. **Self-check against defaults before building anything.** Ask of every part of each direction: would I produce this for any similar app? If yes, revise it, and write what changed and why in the direction's plan (two passes). Check each direction against the AI-tells list below and against the taste profile's dislikes.

Write each plan to `.jarvis/mockups/<direction>/direction.md`.

## Make the mockups

Make **throwaway static mockups** of the main screens for each direction (decision 39): the screen where first value happens, the main list or dashboard, and one empty state. Everything goes under `.jarvis/mockups/`, which is gitignored (architecture §3.5): `<direction>/<screen>.html`, one self-contained page each, at the width of the platform the user lives on.

- **Use real wording:** the product's own words from `PRODUCT.md`, real labels and real button text. No lorem ipsum: it hides the hierarchy problems the user is choosing between.
- **Use made-up sample data**, never real names, emails, addresses or companies. Mockups can reach the phone through a public notification server.
- **No scripts that call out, no tracking, no real data**, and nothing the build will reuse: the real UI is built from `DESIGN.md` later, not from these files.
- **Screenshot each screen** at that width and save `<screen>.png` beside its page. If no browser is available, keep the HTML paths and say so; intake attaches paths instead.
- **One comparison page,** `.jarvis/mockups/index.html`, shows the three directions side by side, screen by screen, each with its name, dials and principles in a line or two (a comparison board, gstack's design-shotgun).

Then name **a default for intake's question.** The default is chosen by fit, not by looks: the direction closest to the taste profile, the product's constraints and the domain conventions research found, with the reason stated in those terms ("closest to the calm, dense apps you admire; keeps the list-first layout habit apps share"). Never claim one is more beautiful (decision 56).

Return to intake: the three direction names, the screenshot paths, the comparison page and the default with its reason.

In away mode, the default direction is built first (the walking skeleton) and the mockups wait in the report (decisions 39 and 52). If the user picks another direction in the morning, `DESIGN.md` is rewritten from it and the UI tasks that depended on the default are replanned (decision 40).

## The AI-tells list

Decision 53. These are banned unless the brief asks for it, in which case the exception is written under `DESIGN.md`'s Do's and Don'ts with the brief's words:

| Tell | Do instead |
|---|---|
| Inter, Roboto, Arial or system fonts everywhere | 1–2 deliberately chosen typefaces with clear roles |
| Purple or indigo gradients, purple on white | One accent color tied to a function |
| The SaaS card kit: identical rounded cards, one radius and one soft shadow on everything, cards inside cards | Hierarchy through size, spacing and grouping; cards only when they contain an action |
| Centered hero + three feature boxes with icons + CTA, whatever the product | Open with the most characteristic thing in the product's world |
| Emoji as icons; a rounded icon tile above every heading | A real icon set, only where it adds meaning |
| Everything uniform, so nothing leads the eye | Primary things bigger, heavier, closer |
| Template chrome: ALL-CAPS eyebrow labels, "A · B · C" meta lines, "→" on every button, 01/02/03 on things that aren't steps, one headline word in another color | Structure only when it carries information |
| Generic copy ("Scale without limits", "Welcome to your dashboard") | The product's own words; short utility copy inside apps |
| The same fade-up on every section; bouncy easing | One deliberate moment, plus motion that answers what the user did |
| Gray text on colored backgrounds; flat #000 or #111 | Contrast-checked, tinted neutrals |
| Glow or aurora backgrounds, neon palettes, status dots on everything | Decoration only with a purpose |
| Only the happy path designed | Empty, loading, error and offline states designed on purpose |

Also the newer "tasteful AI" defaults: a cream background with a serif and a terracotta accent, near-black with one acid-green accent, and newspaper-style hairline layouts. They're fine when chosen for a reason from the product's world, never as a fallback.

## After the pick

Intake records the pick once, like every other answer; it's already recorded by intake, so don't record it again.

1. **Write `DESIGN.md`** at the repo root from `templates/DESIGN.md`, in Google's DESIGN.md format: the tokens in the YAML front matter (colors, typography, rounded, spacing, components, with components referring to tokens like `{colors.primary}`), then a short rationale per section. Copy the picked direction's colors, type and principles; fill spacing and corners on one consistent scale. The Overview records the direction, its dials and who picked it (user, default accepted or default unconfirmed).
2. **Plan the theme code** (decision 51): the same tokens wired into the web theme, starting with `--*: initial` so the framework's default palette no longer exists, and for mobile, the styling layer reading the same token file, so web and mobile can't drift. The theme is generated from `DESIGN.md` and never edited by hand. If the code doesn't exist yet, write the plan as a build task; the build loop generates it.
3. **Bring `PRODUCT.md` up to date** if the pick changed a product fact (rare; the voice usually stays).
4. Any design choice you make beyond the picked direction (a spacing scale, a radius) is a Taste decision: record it with `jarvis decide --by jarvis --class taste --source DESIGN.md "<decision>"`. Never edit `docs/decisions.md` directly.

## Checks that code runs

Decision 54: these run before any model looks at the design, on every UI change, as the design gate, `jarvis gate design`. Only the run the runner launches after a session ends is recorded; a run from inside a session is fast feedback and never counts as evidence (decision 49). Build so they pass:

| Check | Catches |
|---|---|
| AI-tells scan (a deterministic detector, no model) | Most of the tells list, on pages and source files |
| Off-palette values: the theme reset plus a lint against arbitrary values and color literals (web and mobile) | Raw colors and one-off sizes that bypass the tokens |
| Token lint on `DESIGN.md` | Broken token references and failing contrast ratios |
| Accessibility: zero serious issues, plus keyboard and focus checks | WCAG 2.2 AA problems |
| Interaction tests on the real target (a browser for web, a simulator for mobile) | Flows that look right but don't work, and a blown first-value budget |
| Screenshot baselines on the same machine | Unintended visual changes |
| Copy check | Banned phrases, buttons that say "Submit" instead of the action, validation errors that apologize, more than one primary button on a screen |

Alignment, spacing and overlap are what vision models judge worst, which is why code checks them.

## The UX checklist

Decision 55. Each item becomes a check where it can, or a reviewer question where it can't:
- **One primary action per screen.** A secondary action never looks like the primary one.
- **The first-value budget** from the spec: the most taps or clicks from first launch to the core result. The interaction test fails past it. Fewer taps only counts when the person still sees what they need to decide (the recipient and the exact message before approving an email).
- **No tours on launch.** Empty states say what goes here and offer the button to start.
- **Progressive disclosure:** frequent things up front, rare ones one step away, never more than two levels deep.
- **Forms:** ask only what's needed, once; one question per step in multi-step flows; mark optional fields "(optional)" instead of asterisks; validate when the person leaves a field, not while they type; put errors next to the field, saying what's wrong and how to fix it, and keep what was typed.
- **Copy:** short sentences, one idea each; buttons say what happens, and the same word follows through the flow ("Publish" → "Published"); if the interface needs explaining, redesign it; if cutting 30% of the copy makes it better, keep cutting.
- **Familiar patterns, distinctive look** (Jakob's law).
- **Responsiveness:** show progress for anything slower than about 400 ms.
- **Accessibility always:** WCAG 2.2 AA, a visible keyboard focus, and reduced-motion support.

## Who judges design

Decision 56:
- **Code first.** The checks above run before any model looks at the design.
- **Then a skeptical design reviewer** (the `design-reviewer` role) in a fresh context, preferably a different model family. It uses the live app in a real browser, not static screenshots, and grades against a written rubric: design quality, originality, craft and functionality, with quality and originality weighted most. It asks "does this follow our principles?" (the direction's principles and this skill's lists), never "is this beautiful?". It's calibrated with examples the user has rated.
- **The user picks; the reviewer finds and explains problems.** A model never picks the better of two designs: on real A/B-tested interfaces models scored near chance and favored whichever came first. Fine alignment and ease of use stay with the code checks for the same reason.
- **At most 3 design revision rounds per screen.** Keep every round's screenshots. The report shows the best-rated round, not just the last: quality plateaus, and a middle round is sometimes better.
- **A negative control first.** The reviewer's verdicts count only after it fails a deliberately generic UI (golden tasks: the design negative control) and passes a good one.

Don't grade your own design as finished. Your self-check is the two-pass revision above; the verdict is the reviewer's and the user's.

## Gotchas

- **Three palettes on one layout aren't three directions.** If the first screens have the same structure, the design question is fake. Change the layout, the flow and what leads the eye.
- **The "tasteful" fallback is still a default.** Cream, serif and terracotta for a brief that never mentions print or craft is the model's average, not a choice.
- **No taste profile means leaning on the domain,** not on your own preferences. Say so in each direction, so the user knows what they're reacting to.
- **Don't argue for a favorite.** Describe each direction's trade-offs evenly, and give the default's reason as fit. A pitch for one direction is the model picking the winner by another route.
- **Lorem ipsum and perfect data lie.** Long names, empty lists and errors are where directions differ. Show at least one empty state.
- **Mockups leave the Mac.** Screenshots can go through a public notification server: made-up data only, no code, no secrets.
- **Hand-edited theme code drifts.** Change `DESIGN.md`, then regenerate. A raw hex value in a component is a failing check, not a shortcut.
- **An existing design system isn't yours to redesign.** Follow it; propose changes as Taste decisions with what depends on them.
- **Mockups are throwaway.** Don't build the app inside `.jarvis/mockups/` or copy its markup into production code.
