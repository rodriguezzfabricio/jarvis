# Jarvis: Project Brief (v1)

Oct 23, 2026 · Fabricio

## In one line

Jarvis is an open-source workflow that makes any coding agent work like a senior software engineer. You describe an idea once, it researches the options, asks the few questions that matter, then designs, builds, tests and ships a working product on its own, for hours or overnight.

## The problem

Agents silently fill the gaps in a prompt with generic assumptions. The recruiter-finder feature in `job-application-automation` showed the two failures to fix:

1. **No solution research.** The agent didn't look for existing open-source tools (e.g., contact and email finders) before building. Fabricio had to tell it to.
2. **No product thinking.** It expected Fabricio to explain how the feature should work and how he'd use it. One feature was really an umbrella of several workflows and choices, and the agent never mapped them.

Fabricio shouldn't need to know what to specify. Jarvis supplies the senior-engineer judgment, including product direction when he doesn't have one.

## Who it's for

- **First:** Fabricio, who builds many kinds of software and is early in his career.
- **Then:** friends and coworkers. It ships as a public GitHub repo, so it must work on other people's hardware, models and harnesses.

## How it's used

- **Away mode (default):** one prompt, a short intake, then Jarvis runs autonomously for hours or overnight across sessions. You come back to a working, verified result.
- **Watch mode:** the same pipeline, but Jarvis explains its reasoning in plain language as it goes, so you learn.

## Decision policy

- **Product questions** (what it does, who it's for, how it should feel) are asked at intake, each with a recommended default. "Use defaults" is always a valid answer.
- **Engineering questions** are decided by Jarvis, logged with reasons, and can be vetoed afterwards.
- **Questions are front-loaded.** Research first, then one batch of questions, then autonomous work. Anything that comes up later is decided and logged, not blocking.
- **Hard stop:** anything that spends real money. Other stops are proposed under Open decisions.

## Scope

**Version 1**

- Intake interview (idea to spec)
- Product and UX design
- Architecture plan
- Build: new apps and features in existing code
- Debugging
- Independent code review
- Security review
- Browser QA
- Deployment
- Project memory (lightweight)
- Onboarding to existing repos
- Recurring cleanup sweeps
- Docs and changelogs
- Performance and accessibility checks
- Research spikes
- Git workflow
- Self-improvement (learns from corrections)
- Cost tracking

**Later**

- Dependency and framework upgrades
- Post-deploy monitoring and incident response

**What it builds:** web apps, mobile apps, APIs, AI apps, CLI tools, and desktop apps for macOS and Windows. Fabricio's work is about half new projects and half existing codebases.

## Requirements

- **Harnesses:** Claude Code (CLI and desktop), Codex (CLI and desktop), and DSH (a DeepSeek harness with a localhost web interface and a prepaid API key). Behavior should not depend on which one is used.
- **Models:** Claude Pro/Max, ChatGPT Plus (sometimes Pro), DeepSeek API. Jarvis chooses the model and reasoning effort for subagents and cross-checks on its own.
- **Machine:** runs on Fabricio's Mac. Others must be able to use it on any OS.
- **Weight:** low CPU, memory and disk overhead. This must not shrink the engineering ambition.
- **House stack:** an opinionated default that most developers know.
- **Distribution:** a public GitHub repo with an open license.

## Inputs we already have

- **`Your Agent Workflow Research Brief.md`** (Oct 22) covers hooks as enforcement, the DECISION.md thinking step, research on clarifying questions and reviewers, skill packs (superpowers, Matt Pocock, Addy Osmani, Spec Kit, BMAD), costs, and a version 1 plan.
- **Depth Engine (`depth-engine-v3`)** is a Markdown methodology plus a small Node CLI. Its author is Endegena Assefa and it is UNLICENSED, so Jarvis can learn from its ideas but can't copy its code or text into a public repo without permission. Note: `Depth-Engine-Codebase.md` describes a much larger system than the code in the folder.

## How we build Jarvis

- Claude researches published work from Anthropic, OpenAI, Cursor/SpaceX, Hugging Face and beyond, including community workflows (GSD, superpowers, gstack and others).
- Claude recommends what to include or skip as short decisions with reasons, then builds.
- **Evaluation:** 3 to 5 real app ideas as a test set, measuring how close the first attempt gets. Test case 1 is the recruiter and hiring-manager finder.

## Open decisions

Update Oct 23: most of these are now settled in `01-decisions.md` (defaults accepted). The test project is the job automation in `~/Documents/ChatGPT/freehire-impl`; see `02-golden-tasks.md`. The design section is still to come.

- [ ] Definition of done and the proof Jarvis shows you (Claude to propose)
- [ ] Hard stops beyond money (proposed: messaging real people, deploying where real users are, deleting data, force-pushing, adding paid services)
- [ ] House stack (after research)
- [ ] How "same behavior across harnesses" is enforced, and its honest limits (after research)
- [ ] Which community workflows to borrow from (after research)
- [ ] Two or more test-set app ideas from Fabricio

## Sources Fabricio provided

**Anthropic**
- [Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Agent harness design: 3 patterns](https://claude.com/blog/harnessing-claudes-intelligence)
- [A harness for every task: dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
- [When to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)
- [Building agents with the Claude Agent SDK](https://claude.com/resources/articles/building-agents-with-the-claude-agent-sdk)
- Workshop by CJ Avilla and Harrison Stall (AI Engineer channel)

**OpenAI**
- [Harness engineering](https://openai.com/index/harness-engineering/)
- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [Introducing the Agents API](https://openai.com/index/introducing-the-agents-api/)
- Codex multi-agent docs
- "Building on the Codex Harness" (Dominik Kundel, AI Engineer)

**Cursor (now part of SpaceX)**
- [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness)
- [Introducing Projects](https://cursor.com/blog/projects)
- [Long-running agents](https://cursor.com/blog/long-running-agents)
- [Scaling agents](https://cursor.com/blog/scaling-agents)
