# Research notes: Community workflows (GSD, superpowers, gstack, …)

Raw findings from a research agent, Oct 23, 2026. These fed `docs/01-decisions.md`. Claims marked secondary or unverified in the text should be checked before relying on them.

---

JARVIS BASE-WORKFLOW EVALUATION (as of 2026-10-23)

How I checked: I shallow-cloned every repo today and read the READMEs, skill files, hook configs and licenses directly. The DSH claims were checked against the local deepseek-ai/deepseek-harness checkout and spec-kit's DSH integration source. The engineer workflows come from web sources.
- Star counts are not re-verified. The GitHub API and shields.io were blocked in this session, so use yesterday's numbers.
- "Last commit" is the date of the default branch's latest commit on today's clone.
- Token estimates are characters ÷ 4 of the always-loaded skill/command descriptions.

KEY PORTABILITY FACTS (these drive the recommendation)
- **One shared format works on all three targets: `SKILL.md` folders (the agentskills.io layout) plus `AGENTS.md`.**
  - Codex finds skills in `.agents/skills` (repo, up to the repo root) and `~/.agents/skills`.
  - DSH finds skills in `.dsh/skills` and `.agents/skills`, auto-loads `AGENTS.md`, and has a one-shot mode: `dsh --profile headless "<task>"`.
  - DSH does NOT read `.claude-plugin/plugin.json`. It does ship experimental bridges that run Claude Code `hooks.json` and Codex `hooks.json` command hooks (`dsh-hooks-claude-code`, `dsh-hooks-codex`), plus an experimental fresh-agent ralph tool that ships switched off.
- **Codex limits how many skills it can advertise.** The initial skill list is capped at 2% of the context window (8,000 characters if the window size is unknown). Past that, descriptions are shortened and some skills are dropped with a warning. Frameworks with 50 to 100+ skills or commands degrade on Codex.
- **Claude Code truncates skills after compaction.** Re-attached skills are cut at 20,000 characters (superpowers' release notes report this). Keep each `SKILL.md` under 20KB.
- **Superpowers bootstraps differently per harness.** On Codex it relies on native skill discovery with no session-start hook, and subagents need `[features] multi_agent = true`. Codex's `spawn_agent` accepts `model` and `reasoning_effort` overrides, so per-subtask model routing is feasible there.
- **Only spec-kit supports DSH natively** (its `dsh` integration). None of the other frameworks mention DSH.

1. COMPARISON TABLE

| Workflow | Core mechanism | Best at | Harnesses | License | Last commit | Weight | Known criticisms |
|---|---|---|---|---|---|---|---|
| obra/superpowers v7.0.1 | A SessionStart hook injects the using-superpowers skill, which says to invoke any skill with even a 1% chance of applying. 14 skills: brainstorming → worktree → writing-plans → subagent-driven-development (fresh implementer per task, then spec review and quality review) → TDD → code review → finish branch. Also systematic-debugging, verification-before-completion and diagnosing-superpowers. A separate evals repo backs it. | Disciplined build and debug once a design exists | 16 harnesses: Claude Code, Codex CLI and app (official marketplaces), Cursor, OpenCode, Gemini, Copilot, Pi, Kimi, Qwen, Droid, Devin, Grok, Antigravity, Hermes, Muse. Not DSH. | MIT | 2026-10-21 | About 1.3k tokens always loaded; all skill bodies together about 27k tokens. Optional local visual-companion server. Its logo fetch acts as opt-out telemetry. | Token-heavy ceremony, partly redundant with native plan mode. Brainstorming asks one question per message and requires approval of a design doc. Enforcement is prompt-only. No API, security, a11y or perf content. Maintainers don't accept new skills. |
| GSD Core (open-gsd/gsd-core; gsd-build/get-shit-done is archived and redirects) | A thin orchestrator hands work to fresh-context subagents. State lives in `.planning/` (PROJECT, REQUIREMENTS, ROADMAP, STATE, CONTEXT, PLAN, SUMMARY). Loop: discuss → plan → execute in waves → verify → ship. Has `/gsd-autonomous`, an assumptions discuss-mode, and model-tier profiles that map to a per-runtime model and reasoning_effort. | Long multi-phase builds across sessions | Claude Code, Codex, OpenCode, Copilot, Cursor, Windsurf, Antigravity, Kimi, Kilo, Qwen via its installer. "GSD Pi" (open-gsd/gsd-pi) is its own standalone harness. Not DSH. | MIT | 2026-10-23 | 72 commands and about 33 agents, about 3.4k tokens of descriptions. 4,178 files. Needs Node. About 12 hook registrations, including Node hooks on every tool call, a statusline and an update check. | Token cost; planning ceremony. A New Stack test saw it create a roadmap after the user declined one. Moved repos twice. Heavy for something that calls itself lightweight. |
| garrytan/gstack | 23 role skills as slash commands: office-hours, plan-ceo/eng/design/devex-review, autoplan, review, investigate, qa / qa-only, cso, ship, land-and-deploy, canary, retro, learn. autoplan auto-decides using 6 principles and writes a Decision Audit Trail. Uses another model (Codex) as an outside reviewer. | Product critique and real-browser QA | Claude Code is "full". Codex, OpenCode, Cursor, Droid, Kiro, Copilot and Antigravity are "experimental", and there the safety hooks only advise. Not DSH. | MIT | 2026-10-23 | 78MB checkout. Needs Bun, a ~58MB compiled browse binary and Chromium. Runs a persistent headless Chromium daemon on localhost that stops after 30 minutes idle. Optional Docker images for `/cso`. Update check every session, throttled to hourly. Skills run 7–13k words each (office-hours is about 17k tokens). | Huge prompts per call. Claude-centric. Its lines-of-code productivity claims are publicly disputed (its own docs address this). Fast churn. |
| mattpocock/skills | Small composable skills. `grilling` maps decisions as a design tree and asks in rounds: every question that can be asked now, numbered, each with a recommended answer that "yes" accepts. Facts are looked up by subagents, never asked of the user. Also to-spec, to-tickets, wayfinder, research, tdd, diagnosing-bugs, handoff, and loop-me ("push right" checkpoints with a decision-ready "brief"). | Intake and product-thinking primitives | Claude Code, Codex, Copilot, Gemini; skills.sh | MIT | 2026-10-19 | About 27 core skills, about 1k tokens of descriptions. Many are user-invoked only. grilling is 324 words. | Deliberately not a framework: no orchestration, QA or security. Some skills assume an issue tracker is set up. |
| addyosmani/agent-skills | 25 skills, 9 commands (/spec /plan /build /test /review /ship /webperf …) and 4 agents (code-reviewer, security-auditor, test-engineer, web-performance-auditor). Reference checklists for security, accessibility, performance and observability, plus a definition of done. Also interview-me, idea-refine and doubt-driven-development. | The senior-engineer quality gates the others lack | Claude Code plugin; `npx skills` covers 70+ agents | MIT | 2026-10-13 | About 2.4k tokens of descriptions; skills run 1.4–3.5k words. Session-start hooks. | interview-me asks one question at a time and refuses to run non-interactively. Long skills. |
| github/spec-kit | The `specify` CLI sets up a constitution, then spec/plan/tasks per feature. Commands include clarify (at most 5 questions, recommended option shown, "yes" accepts), analyze, checklist, implement and converge. Has extensions, presets, workflows and bundles. | Portable spec artifacts; installing into any agent | 43 integrations, including Claude, Codex, DSH, OpenCode, Pi and a generic one | MIT | 2026-10-22 | Needs Python 3.11+ and uv. About 300 tokens of descriptions. | A human runs and reviews each step. Heavy on documents. Growing platform surface. |
| BMAD-METHOD v7 (alpha) | Persona agents (analyst, PM, architect, UX, PO, dev) with workflows: product-brief, PRD, PRFAQ, forge-idea, advanced-elicitation (pre-mortem, red team), party-mode, build / build-auto, code-review, retrospective. | Depth of product discovery | Claude Code and Codex plugins; skills CLI | MIT for code; the BMad names are trademarks and not licensed | 2026-10-18 | 32 skills, about 2k tokens of descriptions. Skills are rendered at run time via `uv run render_skill.py`, so it needs Node plus Python/uv. | Breaking changes in the alpha; persona theatre; brand restrictions. |
| EveryInc compound-engineering | Loop: brainstorm → plan → work → review → compound. `ce-compound` writes one durable learning per solved problem to `docs/solutions/`, but only if it passes a "would its loss cause rediscovery?" test. `ce-compound-refresh` prunes drift. `lfg` runs hands-off end to end: it asks only via brainstorm, does reversible work and shows it afterward, and stops only for irreversible actions it wasn't granted. Also `mode:non-interactive`, ce-sweep, ce-dogfood (browser QA) and ce-pov (multi-model panel). | Self-improvement loop plus an autonomy policy | 14 hosts, including Claude Code, Codex CLI and app, Cursor, OpenCode, Pi, Copilot, Droid. Not DSH. | MIT | 2026-10-22 | 36 skills, about 2k tokens of descriptions. 23MB repo with about 489k words of reference markdown loaded on demand. | Large, fast-moving corpus. The learning store can rot, which is why the refresh skill exists. |
| Ralph (Huntley's post; Clayton Farr's playbook in ghuntley/how-to-ralph-wiggum) | `while :; do cat PROMPT.md \| agent; done` with a fresh context each iteration. Uses specs/*.md, IMPLEMENTATION_PLAN.md and AGENTS.md, one task per loop, tests as backpressure, and separate plan and build prompts. | Overnight greenfield grind | Any CLI agent | No LICENSE file | 2026-01-10 | 5 files, no runtime | Huntley himself warns you may wake to code that doesn't compile, expect placeholder implementations, aim for about 90% done, and not use it on existing codebases. |
| Anthropic ralph-loop plugin | A Stop hook blocks exit and feeds the same prompt back until a completion promise appears or max iterations is reached | Simple iterate-until-green | Claude Code | Apache-2.0 | 2026-10-22 | One hook | Runs in one session, so context piles up; this is not Huntley's fresh-context loop. |
| ruvnet/claude-flow (Ruflo) | Meta-harness: MCP server with 314 tools, 98 agents, swarms, vector memory, a daemon, federation and a console | Swarm experiments | Claude Code; Codex and other MCP clients | MIT | 2026-10-23 | 8,086 files / 166MB, plus a daemon and the MCP server | Very heavy and marketing-heavy (the README has an "illustrative" download counter). |
| wshobson/agents | Catalog of 94 plugins, 202 agents, 185 skills and 105 commands | Library of specialist prompts | Claude Code, Codex, Cursor, OpenCode, Antigravity, Copilot, Pi | MIT | 2026-10-17 | About 28k tokens of descriptions if everything is installed | No workflow backbone. |
| SuperClaude v4.3 | 30 /sc commands, behaviour modes and personas, plus an MCP installer | Claude power users | Claude Code only; Gemini and Qwen have separate forks | MIT | 2026-09-27 | pipx Python package; optional MCP servers | Claude-only; sprawling personas and flags. |
| Agent OS (Builder Methods) | 5 commands: discover-standards, index-standards, inject-standards, plan-product, shape-spec | Turning codebase conventions into written standards | Any agent (it's markdown) | MIT | 2026-10-07 | 22 files; the lightest of all | Narrow scope; its docs live off the repo. |
| OmO (code-yeongyu/oh-my-opencode) | Now its own harness (a fork of pi): an "ultrawork" keyword, agent graphs, and a small "Kibitzer" model that watches memory | — | Itself only | Sustainable Use License: not open source; distribution only free and non-commercial | 2026-10-24 (UTC) | Native binary; 11k files | The license blocks reuse; it's no longer an OpenCode add-on. |
| AWS Kiro specs | requirements.md in EARS form ("WHEN … THE SYSTEM SHALL …"), design.md, and tasks.md with live status | Testable acceptance criteria | Kiro only, though the format is portable | Proprietary product | n/a | n/a | Only the format is reusable. |
| Taskmaster AI | Turns a PRD into tasks.json using its own LLM calls; runs as an MCP server | — | Any MCP client | MIT plus Commons Clause | 2026-04-23 | Node MCP server; needs its own provider API keys | Stale for 6 months; not open source; its API calls cost money. |
| HumanLayer RPI skills | create-research-questions → create-research (the researcher may never read the ticket and only documents) → design discussion → structure outline → plan → implement, with iterate-* variants | Unbiased research on existing codebases | Claude Code plugin | Apache-2.0 | 2026-10-22 | Small plugin. The wider HumanLayer product is a daemon plus cloud. | Many human review gates; built around Linear tickets. |
| humanlayer/12-factor-agents | Principles: own your prompts, context and control flow; launch/pause/resume; contact humans via a tool; small focused agents | Designing Jarvis's orchestrator | n/a | Code Apache-2.0; text CC BY-SA 4.0 | 2025-09-21 | Essays | Stale; written for custom agents, not harness workflows. |
| Anthropic official plugins | feature-dev: 7 phases with explorer, architect and reviewer agents; asks clarifying questions before design. code-review: Haiku eligibility checks, 5 parallel Sonnet reviewers, a confidence score per issue, drops anything under 80. pr-review-toolkit: 6 specialists, including silent-failure-hunter. security-guidance: regex warnings on edits, an LLM review of the diff at Stop, and an agentic review on commit. Also frontend-design and hookify. | Review and security gates | Claude Code (the markdown is portable) | Apache-2.0, except claude-security, which is all rights reserved | 2026-10-22 | security-guidance needs Python and makes extra LLM calls | Claude-specific tool and model names. |
| anthropics/skills | Reference skills (skill-creator with evals, webapp-testing with Playwright, mcp-builder) plus the Agent Skills spec | The skill format | Any | Apache-2.0, except docx/pdf/pptx/xlsx, which are source-available | 2026-10-09 | Small | Not a workflow. |

2. BORROW LIST (all MIT or Apache-2.0 unless noted; keep the upstream LICENSE/NOTICE files and add per-file attribution headers)

- **mattpocock/skills (MIT): the core of Jarvis's intake.**
  - `grilling`: numbered rounds of every question that can be asked now, each with a recommended answer that "yes" accepts, and facts gathered by subagents rather than asked.
  - loop-me's "push right" checkpoints and decision-ready "brief".
  - `research`: a background agent that uses primary sources and writes a cited markdown file.
  - `to-spec` template: problem, solution, user stories, implementation decisions, testing decisions, out of scope.
  - `handoff`, for passing work between sessions.
- **GSD Core (MIT):**
  - Assumptions mode: read the code, list assumptions with confidence levels, ask only for corrections. Run it before grilling to shrink the question list.
  - `STATE.md` as the backbone, with a thin orchestrator and fresh-context subagents.
  - The plan-checker agent.
  - The model-profile schema (tier → per-runtime `{model, reasoning_effort}`), as Jarvis's routing table.
  - The context-pressure guard (pause before the window runs out) and a repair budget of 2 attempts per failed task.
- **spec-kit (MIT):**
  - The clarify rules: at most 5 questions, a recommended option for each, and "yes" means accept.
  - The constitution file, and `analyze` for checking consistency across documents.
  - Its `dsh` integration source as the reference for installing on DSH.
- **gstack (MIT):**
  - autoplan's decision classes: Mechanical (decide silently), Taste (decide, then surface at the final gate) and User Challenge (never auto-decide). Plus its Decision Audit Trail table. Together these become Jarvis's decisions log.
  - A condensed version of the 6 decision principles.
  - cso's OWASP + STRIDE structure, and qa's approach of testing only the routes the diff touches.
  - Using a different model or harness as the outside reviewer.
- **superpowers (MIT):**
  - subagent-driven-development (fresh implementer, spec-compliance review, quality review, at most 5 fix rounds).
  - systematic-debugging, TDD and verification-before-completion.
  - The "builder check": a fresh subagent reads the design as its builder and lists open questions.
  - writing-skills' practice of pressure-testing skills with evals; diagnosing-superpowers' transcript forensics as input to self-improvement.
  - The porting guide's rules: skills name actions, never specific tools; keep tool mappings per harness; a test that fails any `SKILL.md` at 20KB or more.
- **addyosmani (MIT):** the security, accessibility, performance and observability checklists; definition of done; api-and-interface-design; the security-auditor and web-performance-auditor agents; doubt-driven-development; browser-testing-with-devtools; the ADR skill.
- **Compound Engineering (MIT):**
  - The durable-learning test and one learning per run; the compound-refresh pruning pass.
  - lfg's interaction policy: ask only at intake, do reversible work, stop at irreversible actions beyond the grant. This is close to Jarvis's money hard stop.
  - The `mode:non-interactive` convention; ce-sweep's pattern for scheduled sweeps.
- **Anthropic plugins (Apache-2.0; NOTICE required):** code-review's confidence scoring and drop-below-80 filter; silent-failure-hunter; feature-dev's explorer/architect split; the security-guidance regex pattern list; skill-creator's evals.
- **Ideas only, no text (no license or a share-alike license):**
  - Ralph: a fresh-context outer loop, one task per iteration, a plan regenerated often, tests as backpressure.
  - Anthropic's "effective harnesses for long-running agents" post: an initializer agent, a feature list in JSON where only the `passes` field may change, a progress file, and an `init.sh` smoke test at every session start.
  - OpenAI's "harness engineering" post: an `AGENTS.md` of about 100 lines used as a table of contents, `docs/` as the system of record, golden principles, recurring cleanup agents.
  - Cursor: write long tool outputs to files.
  - HumanLayer (Apache-2.0, so text is fine too): decouple writing research questions from doing the research.
  - 12-factor: paraphrase only, because the text is CC BY-SA.
  - Kiro: EARS-style acceptance criteria.

3. AVOID LIST

- **Superpowers as the base or as a dependency.** Its bootstrap would compete with Jarvis's orchestrator. Its brainstorming asks one question per message and gates on approvals, which contradicts a single front-loaded intake. Upstream doesn't accept new skills, so Jarvis would end up maintaining a fork. Vendor the individual skills instead.
- **gstack as the base.** It needs Bun, a Chromium daemon, a 58MB binary and optional Docker; its skills cost about 15k tokens per call; and its enforcement only works on Claude Code. Detect it and use it if the user has it installed, but never require it.
- **GSD as the base.** Hooks on every tool call, 105 commands and agents that blow through Codex's skill-list budget, and two repo moves this year.
- **Ruflo, SuperClaude, wshobson wholesale.** Daemons and MCP sprawl, Claude-only, or about 28k tokens of descriptions with no workflow backbone.
- **BMAD as the base.** Skills are rendered at run time via uv/Python, v7 is still alpha, and the names are trademarked.
- **Licenses that block reuse.**
  - Taskmaster: Commons Clause, stale, and its own paid API calls conflict with the money hard stop.
  - OmO: Sustainable Use License, and it's a harness rather than a workflow.
  - claude-security: all rights reserved.
  - Ralph playbook text: no license file.
  - 12-factor text: copying it would put Jarvis's docs under share-alike.
- **ralph-loop as the overnight engine.** It keeps one growing context; use a fresh-context outer loop instead.
- **The full HumanLayer app** (daemon plus cloud).
- **LLM-review hooks running unconditionally on DSH.** Every extra pass draws down the prepaid key, so Jarvis's cost tracking has to meter them.
- **Too many skills.** The Codex budget drops extras, and Claude Code truncates re-attached skills at 20KB.

4. WHAT THE LAB ENGINEERS ACTUALLY DO

- **Boris Cherny (Anthropic):**
  - January 2026: 5 local sessions plus 5–10 web sessions at once; almost no customization; Opus with thinking for everything. He starts in plan mode, then switches to auto-accept. His team keeps a CLAUDE.md of about 2.5k tokens in git, updated from PR reviews. Slash commands for commit/PR use inline bash; a format hook runs after edits; permissions are pre-approved rather than skipped. He calls verification (Claude testing the UI in Chrome) the top tip, worth 2–3x in quality.
  - June 2026, with Cat Wu: mostly auto mode with a safety classifier instead of plan mode. He designs loops (/loop, /goal, routines) that prompt Claude; routines watch issues and draft fixes. Each session gets its own worktree. About half his engineering happens from his phone. When Claude repeats a mistake, he has it write the lesson into CLAUDE.md or a skill.
- **OpenAI Codex team (Ryan Lopopolo, February 2026):** 3 to 7 engineers, about 1M lines and about 1,500 PRs with no hand-written code. `AGENTS.md` is about 100 lines and acts as a table of contents; `docs/` holds plans, specs and quality grades, checked by linters. Each worktree gets a bootable app; agents drive it through CDP and query a local observability stack. Runs last up to 6 hours overnight, and review is mostly agent-to-agent. Golden principles plus recurring cleanup and doc-gardening agents open small PRs. When an agent fails, they build the missing capability. A December 2025 post describes 12-hour Codex runs working from a continuously updated plan.
- **Cursor (a SpaceX subsidiary since 2026-08-14):**
  - Lee Robinson: plan mode first, plans saved. If the result is wrong, revert and fix the plan rather than patch. Rules stay short and are added only after a repeated mistake. Tests get committed before the code. He uses worktrees and runs the same prompt on several models.
  - Jediah Katz: his "dynamic context discovery" post covers writing tool output, terminal output and chat history to files, and lazy-loading skills and MCP tools (46.9% fewer tokens in runs that called an MCP tool). I found no personal day-to-day workflow write-up from him.
- **Karpathy (April 2026):** he calls agents "fallible and stochastic". He writes a detailed spec first, which agents draft and he structures. He reviews diffs closely and often finds bloat. He keeps taste, system boundaries and security decisions for himself.
- **Simon Willison:** code is cheap now; red/green TDD; run the existing tests first; manual testing by agents with browser automation; hoard working techniques; never share agent code you haven't reviewed.
- **Mitchell Hashimoto:** starts agents at the end of the day on research and triage, then reads their reports the next morning. He hands off the "slam dunks", runs one deliberate agent at a time, and turns every mistake into an AGENTS.md line or a script.
- **Armin Ronacher:** uses Pi almost exclusively (4 tools); no MCP; hand-made skills that he prunes; one CDP browser skill; reviews in a fresh context; avoids plan mode and downloaded community skills.
- **The common thread:** none of them use a big community framework. They rely on a short instruction file that records corrections, a spec or plan first, real verification (browser, tests), review in a fresh context, parallel worktrees, background or overnight loops, and recurring cleanup.

5. RECOMMENDATION: build a thin Jarvis core of your own and vendor pieces from the others with attribution. Don't adopt one framework as the base.

Reasons, tied to your requirements:
1. **Cross-harness behaviour.**
   - No framework runs autonomously on all three targets. spec-kit is the only one with native DSH support, and it expects a human at every step. Superpowers has the widest reach but no DSH support, and its Codex path doesn't use a bootstrap hook.
   - The portable layer is `.agents/skills/*/SKILL.md` plus `AGENTS.md` plus plain shell hook scripts. Those hooks run natively on Claude Code and Codex, and on DSH through its experimental bridges. Jarvis must own that adapter layer either way.
2. **The core problem.** Jarvis's flow is: research → one batched intake with recommended defaults → autonomy across sessions with a decision log → money hard stop. It exists only in pieces: grilling, GSD's assumptions mode and spec-kit's clarify for intake; CE's lfg policy for autonomy; gstack's audit trail for decisions; Anthropic's long-running harness for sessions. Every candidate base has an interaction model that would fight it.
3. **Lightweight.** Target about 12 skills under 20KB each and about 1.5k always-loaded tokens. No daemons. Use one portable fresh-context loop script that calls `claude -p`, `codex exec` or `dsh --profile headless`, with round and budget caps. A small hooks set: session bootstrap, a stop gate that requires verification, and a money guard on shell commands. Browser QA uses whatever the harness provides (or Playwright on demand), with gstack optional.
4. **Model and effort routing.** Codex's `spawn_agent` takes `model` and `reasoning_effort`. Claude Code subagents take a `model` setting in frontmatter, and GSD uses an `effort` setting in command frontmatter. Use GSD's tier-mapping table as the schema. For DSH I verified that it has subagent presets, but not whether you can override the model per subagent.
5. **Licensing allows all of this** for the MIT/Apache sources.

Suggested core:
- **Skills:** jarvis-research, jarvis-intake (assumptions → grilling rounds → at most a few must-ask questions), jarvis-spec (to-spec plus EARS criteria plus a features.json with only `passes` editable), jarvis-design, jarvis-architect (ADRs plus decisions.md classed Mechanical/Taste/Challenge), jarvis-build (subagent-driven development plus TDD), jarvis-debug, jarvis-review (confidence filter plus doubt-driven review, ideally on a different model), jarvis-security, jarvis-qa (browser, a11y, perf), jarvis-ship (git plus deploy behind the money gate), jarvis-compound (turn corrections into AGENTS.md lines or skill edits), jarvis-sweep (scheduled cleanup).
- **Docs:** a 100-line `AGENTS.md` as a table of contents, a `CLAUDE.md` that imports it, and `docs/jarvis/` as the system of record.

Key sources: [Codex skills docs](https://learn.chatgpt.com/docs/build-skills), [OpenAI harness engineering](https://www.openai.com/index/harness-engineering), [Anthropic long-running harnesses](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents), [InfoQ on Boris Cherny](https://infoq.com/news/2026/01/claude-code-creator-workflow/), [The Neuron, Cherny and Wu](https://theneuron.ai/explainer-articles/claude-code-creators-boris-cherny-and-cat-wu-explain-how-to-use-agent-loops/), [Cursor agent best practices](https://cursor.com/blog/agent-best-practices), [Cursor dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery), [Karpathy, Sequoia Ascent 2026](https://karpathy.bearblog.dev/sequoia-ascent-2026/), [Hashimoto](https://mitchellh.com/writing/my-ai-adoption-journey), [Ronacher](https://lucumr.pocoo.org/2026/1/31/pi/), [Willison's guide](https://simonwillison.net/guides/agentic-engineering-patterns/), [Huntley's Ralph post](https://ghuntley.com/ralph/), [Kiro specs](https://kiro.dev/docs/specs/concepts), [SpaceX closes Cursor deal](https://driveteslacanada.ca/spacex/spacex-closes-cursor-acquisition-60-billion/), [criticism of superpowers](https://mcp.directory/blog/superpowers-skill-worth-it-2026), [New Stack on GSD](https://thenewstack.io/beating-the-rot-and-getting-stuff-done/), [ralph loop vs the plugin](https://chaseai.io/blog/ralph-loop-vs-claude-code-plugin), [OpenAI forum on 12-hour Codex runs](https://forum.openai.com/home/blogs/how-openai-engineers-use-codex-to-tackle-big-projects-with-rigor-2025-12-04).

The repo clones used for this are in /tmp/claude-0/-home-claude/70c2b512-4ce0-598d-88fc-8f71a0984189/scratchpad/repos/; the DSH facts come from /home/claude/deepseek-ai/deepseek-harness.