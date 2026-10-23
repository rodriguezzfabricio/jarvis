# Research notes: Design and UX

Oct 23, 2026. A research agent gathered these sources before it stalled and was stopped. Claude then read the cloned repos directly and wrote these notes; they feed decisions 51–56 in `docs/01-decisions.md`. Strength of evidence is noted per source.

## Lab guidance

**Anthropic, "Harness design for long-running application development"** (Mar 24, 2026), [link](https://www.anthropic.com/engineering/harness-design-long-running-apps). *Strong: a lab's own experiment.*
- The frontend evaluator graded four criteria:
  - design quality: a unified whole with a distinct mood,
  - originality: deliberate custom choices, where template layouts, library defaults and AI patterns score poorly ("purple gradients over white cards" is named),
  - craft: hierarchy, spacing, contrast,
  - functionality.
- Quality and originality were weighted more, because the model already handled craft and functionality.
- The evaluator used Playwright on the live page, was calibrated with few-shot score breakdowns, and needed tuning to be skeptical. A standalone skeptical evaluator was "far more tractable" than self-critique.
- 5–15 iterations per run. Scores plateaued, and the author sometimes preferred a middle iteration. Even the first iteration beat a no-criteria baseline.
- Wording matters. "Is this beautiful?" is hard to grade consistently; "does this follow our principles for good design?" works. A phrase like "museum quality" pushed every design toward one look.

**Anthropic frontend-design skill** (`anthropics/skills`, Apache-2.0; read from the repo). *Strong: a lab's own skill.*
- Ground the design in the subject: its industry, materials, vocabulary and audience.
- Work in two passes. First a compact token plan: 4–6 named hex colors, type roles, a layout concept with ASCII wireframes, principles. Then revise anything that reads like the default for a similar brief, and say what changed. Only then write code.
- Named "AI defaults" clusters:
  - cream with a serif and a terracotta accent,
  - near-black with an acid-green or vermilion accent,
  - broadsheet hairlines with zero radius,
  - the SaaS card kit: identical rounded cards, one radius, `rgba(0,0,0,.1)` shadows, gradient washes,
  - template chrome: all-caps eyebrows, "A · B · C" meta strings, "WORD — fragment" labels, `#111` in place of black, monospace data labels, "→" on buttons.
- Typographic tells: one accented word in a headline, all-caps labels, unneeded labels above content, 01/02/03 numbering when the content isn't a sequence.
- Motion: one orchestrated moment. Fade-and-slide on every section reads as AI.
- Copy: write from the user's side; active verbs ("Save changes", not "Submit"); the same action name through a whole flow; errors don't apologize and aren't vague; an empty screen invites action.

**OpenAI, "Designing delightful frontends with GPT-5.4"** (Mar 20, 2026), [link](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4). *Strong: a lab's own guide.*
- Underspecified prompts produce generic structure and weak hierarchy.
- Rules:
  - one H1, at most six sections, at most two typefaces, one accent color,
  - no default font stacks (Inter, Roboto, Arial, system),
  - no purple-on-white,
  - no cards by default, and never in the hero; cards only as containers for an interaction,
  - the hero holds brand, one headline, one sentence, one CTA group and one dominant image.
- Copy: product language; one short supporting sentence; "if deleting 30% of the copy improves the page, keep deleting"; utility copy inside apps.
- Make a mood board or several visual options before choosing. Use screenshots as guardrails.
- Verify with Playwright across viewports, and compare against references.
- An existing design system takes precedence over all of these rules.
- An older GPT-5 cookbook (Aug 2025, archived) only listed a stack (Next.js, Tailwind, shadcn/ui).
- The `frontend-skill` it mentions wasn't in the cloned `openai/skills` repo, which has no root license file. Treat as ideas only.

**Codex built-in frontend guidance.** *Weak: from a leaked prompt.* A system-prompt leak and a Codex issue (#19720, Apr 2026) show about 1.5k tokens of frontend rules in Codex itself, along the same lines: no slop, expressive fonts, no purple-on-white, CSS variables, a few meaningful animations.

**Claude Design** (Anthropic Labs, Apr 17, 2026), [link](https://www.anthropic.com/news/claude-design-anthropic-labs). It reads a codebase and design files to build a design system, applies it to every project, offers a "wide range of directions", and hands off to Claude Code. It's a product, not a technique Jarvis can copy, but it confirms the "design system first, many directions" approach.

## Formats and tools

**Google Labs DESIGN.md** (Apr 21, 2026), [repo](https://github.com/google-labs-code/design.md) (Apache-2.0; read from the repo).
- YAML front matter tokens (colors, typography, rounded, spacing, components) plus markdown rationale.
- `npx @google/design.md lint DESIGN.md` reports broken token references and WCAG contrast as JSON.

**Impeccable** ([repo](https://github.com/pbakaus/impeccable), Apache-2.0, updated Oct 23, 2026; read from the repo).
- Started from Anthropic's frontend-design skill.
- `/impeccable init` writes `PRODUCT.md` (durable product truth); the visual system goes in `DESIGN.md`.
- 24 commands, including `shape`, `critique`, `audit`, `polish`, `harden`, `onboard`, `distill`, `clarify` and `live`.
- **62 deterministic detector rules:** `npx impeccable detect --json <files|dir|url>`. No AI model is involved, and exit code 2 means findings. It scans HTML and CSS, including CSS-in-JS, and renders URLs in a browser. It can check against the project's design system. It doesn't apply to native apps.
- Installs for Claude Code, Codex, Cursor, Grok Build, the DeepSeek Harness and others. Codex needs hook trust after install or update.

**Vercel web interface guidelines** ([repo](https://github.com/vercel-labs/web-interface-guidelines), MIT). About 150 lines of MUST/SHOULD rules covering keyboard, targets, forms, state and navigation, feedback, touch, animation, layout, content and accessibility, performance, dark mode, hydration and design (nested radii, contrast, hue-tinted borders and shadows).

**taste-skill** ([repo](https://github.com/Leonxlnx/taste-skill), MIT). Infers a design language from the brief and sets three 1–10 dials: design variance, motion intensity and visual density. It includes redesign-audit and mockup-first workflows.

**gstack design-shotgun** (MIT). Generates several design variants, opens a comparison board, collects structured feedback and iterates. In unattended sessions it auto-picks the recommended option.

**ui-ux-pro-max** (MIT). A searchable database of 79 UI styles and 192 reasoning rules. Kept as optional reference only.

**Lovable design systems** ([docs](https://docs.lovable.dev/features/design-systems)). After each generation it automatically checks for raw color literals, one-off values outside the token scale, inline style overrides, and local re-implementations of design-system components, and retries on violations. React-only. This is the pattern Jarvis copies with its own lint (decision 54).

**v0 Design Systems 2.0** ([docs](https://v0.app/docs/design-systems-2)). A design system saved as a skill with a starter app, reviewed before saving. Its legacy docs warn that v0 is trained mostly on default shadcn, so heavy customization can generate unexpectedly.

**shadcn create** (Dec 2025). The shadcn author wrote that "all apps started looking the same" because the defaults were good. `npx shadcn create` offers 5 base styles plus theme, font and icon choices.

**Tailwind v4 `@theme`** ([docs](https://tailwindcss.com/docs/theme)). `--color-*: initial`, or `--*: initial`, removes the default utilities so only custom tokens exist.

**Lint rules:**
- Biome `noTailwindArbitraryValue` (nursery, experimental) flags `w-[400px]` and `text-[#555]`.
- eslint-plugin-tailwindcss has `no-arbitrary-value`, off by default; Tailwind v4 support is unclear.
- eslint-plugin-react-native has `no-color-literals` and `no-inline-styles`, but low maintenance.

**Playwright `toHaveScreenshot`.** Baselines are tied to the OS, browser and machine, so run them in the same environment.

**Cursor Design Mode** (3.7, Jun 2026). Select or draw on elements to direct agents. No token or anti-generic features; it's an editor feature.

## Designers on AI tells

*Medium: several independent practitioners agree, but nothing is measured.*
- **Kosta Canatselis, "Spot the Slop"** (Jul 23, 2026): Inter-only typography; purple-to-blue gradients; generic headlines; uniform padding, radius and card height; missing empty, loading and error states; no motion or identical motion; everything visible at once (use progressive disclosure).
- **Jeff Humble, The Fountain Institute, "7 tells":** neon palettes, dark-mode glow, emoji everywhere, purple gradients, cards on cards, multicolored side tabs, status dots on everything.
- **prg.sh** (Oct 26, 2025): Tailwind UI's demo `bg-indigo-500` became the training-data default (Adam Wathan apologized for it in Aug 2025). Other tells: Inter, a centered hero, three feature boxes, rounded everything, 0.1-opacity shadows, missing validation and error states. Its fixes: reference concrete aesthetics, ban the defaults explicitly, request several directions, and use 3–5 reference examples.

## Research

- **"Interrogating Design Homogenization in Web Vibe Coding"** (Univ. of Washington, arXiv 2603.13036, Mar 2026). *Conceptual, not measured.* Models reproduce dominant, Western-leaning defaults. It proposes "productive friction": contrasting mood boards to choose from, anchoring generation to tokens and brand inputs, and flagging generic conventions during refinement.
- **NN/g, "AI prototyping"** (Oct 2025, reviewed Aug 2026). *Strong: expert evaluation.* Broad prompts gave widely varying, generic output: flat, minimal, interchangeable, with weak hierarchy, separated related items, poor contrast and the wrong pattern for the context ("good from afar, but far from good"). Detailed prompts plus visuals got close to human designs.
- **WiserUI-Bench** (arXiv 2505.05026). *Strong: a benchmark.* On 300 real A/B-tested UI pairs, models picked the winner at near-chance rates with strong position bias. They were better at explaining why a known winner works.
- **"MLLM as a UI Judge"** (arXiv 2510.08783, Oct 2025). Models' average ratings came close to human ratings on several factors. They overestimate ease of use and underestimate "interesting". They supplement human evaluation but don't replace it.
- **AesEval-Bench** (arXiv 2603.01083, Mar 2026). Alignment was a clear weak point; localizing flaws scored IoU ≈ 0.2 even for the best model.
- **"Vision language models are blind"** (arXiv 2407.06581). Models fail simple tasks with overlapping or close shapes, so fine spacing and overlap judgments are unreliable.

## UX sources

- **NN/g:**
  - [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): more than 2 levels usually has low usability.
  - [Onboarding tutorials](https://www.nngroup.com/articles/onboarding-tutorials/): launch tutorials interrupt, get skipped and are forgotten; prefer contextual help.
  - [Empty states](https://www.nngroup.com/articles/empty-state-interface-design/): show status, teach, and provide a direct action.
  - [Error messages](https://www.nngroup.com/articles/error-message-guidelines/): place them near the field, make them specific, give a next step, keep the input.
- **GOV.UK:**
  - [Question pages](https://design-system.service.gov.uk/patterns/question-pages/): one question per page; ask once; "(optional)" instead of asterisks; "Continue"; test without a progress bar first.
  - [Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces): short sentences, one idea each; start with less content; if the interface needs explaining, redesign it; no "sorry" in validation errors; "aim to be boring".
- **Luke Wroblewski, "Inline validation in web forms"** (A List Apart, 2009; 22 participants, so indicative). Validating after the field is left: +22% success, −22% errors, +31% satisfaction, −42% completion time.
- **[Laws of UX](https://lawsofux.com/):** Jakob's law (users expect familiar patterns), Hick's law, Fitts's law, Doherty threshold (about 400 ms), progressive disclosure via cognitive load, and the goal-gradient effect.
