# Research notes: Anthropic sources

Raw findings from a research agent, Oct 23, 2026. These fed `docs/01-decisions.md`. Claims marked secondary or unverified in the text should be checked before relying on them.

---

PART A: SOURCES

A1. Agent Harness Design: 3 Patterns for Harnessing Claude's Intelligence (Lance Martin, Claude Platform)
https://claude.com/blog/harnessing-claudes-intelligence · Apr 2, 2026 · READ
- Pattern 1, lean on tools the model already knows. Bash plus a text editor got Claude 3.5 Sonnet to 49% on SWE-bench Verified. Skills, programmatic tool calling and the memory tool are all built from those two tools.
- Pattern 2a, let the model orchestrate. Give it a code-execution tool so it writes code that calls tools and filters their results; only the code's output enters context. Hard-coded filters in tools are an anti-pattern (the harness is making a decision the model should make). Letting Opus 4.6 filter its own tool output raised BrowseComp from 45.3% to 61.6%.
- Pattern 2b, let the model manage its context: skills (frontmatter preloaded, body read on demand), context editing (pruning stale tool results and thinking), and model-chosen subagents (only +2.8% on BrowseComp).
- Pattern 2c, let the model persist its context: compaction plus a memory folder (Sonnet 4.5 went from 60.4% to 67.2%). In a Pokémon test, Opus 4.6 kept 10 organized files and a distilled `/gameplay/learnings.md`. Sonnet 3.5 wrote transcript-style notes: 31 near-duplicate files, and it was still stuck in the second town.
- Pattern 3, cache-aware boundaries. Put static content first and dynamic content last. Send updates as `<system-reminder>` messages instead of editing the prompt. Don't switch models mid-session (caches are per model; use a subagent for a cheaper model). Don't add or remove tools mid-session (use tool search). Cached tokens cost 10% of normal.
- Use declarative (typed) tools where you need gating, rendering or an audit trail. The gating rule is reversibility: confirm hard-to-reverse actions. Edit tools can refuse to write a file that changed since it was last read.
- Prune scaffolding. Context resets were added for Sonnet 4.5's "context anxiety" and became "dead weight" with Opus 4.5. The guiding question is "what can I stop doing?"
For Jarvis: TAKE all of it. It is the design philosophy, and Pattern 3 (cache rules) directly constrains how per-subtask model routing can work.

A2. A harness for every task: dynamic workflows in Claude Code (Thariq Shihipar; Sid Bidasaria credited)
https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code · Jun 2, 2026 · READ (the page names no functions, so I filled in mechanics from the official docs at https://code.claude.com/docs/en/workflows, READ)
- Mechanism: Claude writes a JavaScript file with top-level await. The runtime runs it in the background, isolated from the conversation. Globals: `agent(prompt, {schema, label, model, worktree, stallMs})`, `parallel()`, `pipeline(items, fn)`, `phase(title)`, `log()`, `args`. A saved file starts with `export const meta = {name, description, phases}`.
- Intermediate results stay in script variables, so Claude's context only receives the final answer. The script itself has no filesystem, shell or `import()`; agents do all the work.
- Determinism: `Date.now()`, `Math.random()` and `new Date()` throw. That makes runs resumable by replay: completed agents return cached results, and the first agent whose prompt diverged, plus everything started after it, runs again. Results are saved under `~/.claude/projects/<session>/`. Resume only works within the same session (or after `claude --resume`).
- `schema` gives validated JSON output with 5 retries (`MAX_STRUCTURED_OUTPUT_RETRIES`). An agent that fails or is stopped returns null inside `parallel`/`pipeline`. A stalled agent auto-restarts up to 5 times.
- Limits: 16 concurrent agents by default (lower when CPUs are limited; configurable 1–256), at most 4,096 items per `parallel`/`pipeline` call, 1,000 agents per run, no mid-run user input (approve stages by running them as separate workflows). A "Large workflow" warning shows above 25 agents or 1.5M projected tokens. Size guideline settings: small (<5 agents), medium (<10, the default), large (<50).
- Triggers: the `ultracode` keyword, "use a workflow", or `/effort ultracode`. The keyword is ignored in `-p`, scheduled-task and webhook prompts (since v2.1.210). Headless runs need a `Workflow` or `Workflow(<name>)` allow rule. Saved workflows live in `.claude/workflows/` or `~/.claude/workflows/`, or ship in plugins; `/deep-research` is bundled.
- Patterns: classify-and-act, fan-out-and-synthesize (a barrier), adversarial verification against a rubric, generate-and-filter, tournament (for ranking 1000+ items), loop-until-done. Also quarantine (agents that read untrusted content get no high-privilege tools), a classifier that routes each task to Sonnet or Opus, and one verifier per rule plus a skeptic.
- Don't: use workflows for routine coding ("a panel of 5 reviewers" is overkill). They cost more tokens. Tell agents to avoid resource-heavy commands when running in parallel. The post says best practices are still developing.
- Portability: yes. The runtime is small: a deterministic JS sandbox, an agent() adapter, a result cache keyed by start order plus prompt, and a concurrency semaphore. agent() can shell out to any headless CLI or HTTP API. Native worktree isolation and prompt-cache staggering (sibling agents held about 5 s so they share a cached prefix) are the only Claude-specific extras.
For Jarvis: TAKE. Use the native feature on Claude Code and ship a port of the same API for Codex and DSH.

A3. Building agents: When to fold subagents into your main agent loop (Diane Sarkis, Applied AI)
https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop · Oct 22, 2026 · READ
- Thesis: across enterprise deployments, one agent with progressively disclosed skills often beat both the one-prompt design and the subagent design. One customer saw about 2x faster runtime.
- Keep subagents only when: (1) context bloat measurably degrades the single loop; (2) work is parallel and its context can be discarded; (3) tool choice or instructions conflict. They also fit verification and modular permissions. Split by context, not by problem type.
- Fold signals: subagents mirror the org chart (Conway's law); specialists chain on each other's output or touch the same data; lossy handoffs (a "telephone game"); nested loops adding latency.
- The single loop: turn and cost budgets plus write gates live in the harness. Parallel tool batches. The model writes its own plan and revises it. Skills for procedures. Deferred tool loading. Hard limits and approvals implemented as tools. Per-user permission checks inside tools.
- Numbers: tool choice degrades past 30–50 tool definitions. Claude Code's system prompt was cut by over 80% for advanced models. Start an eval with 10 golden examples. Run each task more than once (one regression showed up in only 1 of 2 runs).
- Migration: evals first, then convert subagents to tools, then fold one at a time, comparing evals and inspecting flipped tasks. A failure they saw: after a merge, the agent answered from an order-lookup tool and skipped asking the shipping specialist.
- Tooling: `/claude-api build-eval`, `prompt-audit`, `hillclimb` and `cost-optimize`, plus `/skill-doctor`.
For Jarvis: TAKE. A "role agent per pipeline phase" design is exactly the org-chart anti-pattern described here.

A4. Building agents with the Claude Agent SDK (Thariq Shihipar)
https://claude.com/resources/articles/building-agents-with-the-claude-agent-sdk · Sep 29, 2025 · READ
- The loop: gather context, take action, verify work, repeat. The principle is "give your agents a computer."
- Prefer agentic search (grep/tail over the filesystem) to semantic search, which is "less accurate, more difficult to maintain, and less transparent." Folder structure counts as context engineering.
- Subagents for parallel work and isolated context; compaction comes from `/compact`. Code generation for actions that must be reusable and precise.
- Verification in order of preference: rules (lint; TypeScript over JS for the extra feedback), then visual checks (Playwright across several viewports, since one screenshot isn't enough), then LLM-as-judge, which it calls "generally not a very robust method" and slow.
- Debugging an agent: is it missing information? Add rules to the tools. Give it better tools. Build an eval set from real usage.
For Jarvis: TAKE the verification ordering. The rest is mostly superseded by A1 and A3.

A5. Why One AI Agent Isn't Enough (And How to Run 1,000) (CJ Avilla & Harrison Stall, Anthropic). This is the scheduled "Orchestrating Claude Managed Agents" workshop at AI Engineer NYC.
https://www.youtube.com/watch?v=kiClTcJUnhc · talk Oct 12, 2026, video Oct 16, 2026 (1:41:43) · PARTIAL. I read the description and chapters but no transcript is available. Written report: https://www.latent.space/p/claude-dynamic-workflows (Oct 12, READ). I filled in mechanics from the official docs, all READ: platform.claude.com/docs/en/managed-agents/workflow-runs, /budgets, /vaults.
- Talk structure: "Flows" in Managed Agents means Claude writes and runs its own topology of up to 1,000 agents from a goal. Single agents fail through laziness, self-preference bias and goal drift (Stall: a single agent "keels over much, much earlier"). Demos: a stock-watchlist scanner and the Bug Hunter (multi-agent PR review) and Explainer Studio templates. The safety section covers budgets, interrupts, auto mode, "declare, contain, detect", separating brain from hands, and credential vaults. Chapter titles only; I couldn't verify the content of the "declare, contain, detect" section.
- From the written report: the model does NOT know its budget. Subagents share a filesystem and can't message each other via the API. The Console graph view shows the payload passed to each agent. Ambitious tasks need explicit encouragement to parallelize. Flows cost "much more." Reviewing many agent PRs becomes the human bottleneck. Dreaming and hill-climbing are the suggested ways to self-improve.
- Workflow-run docs: run, then phases, then threads. Events are `workflow_run.created/phase_started/status_ended`. A `completed` result does NOT mean the work passed. Threads can be retried, so tools must be idempotent. Default lifetime 24 h. 64 concurrent threads. 10 open runs per session. Runs can't be nested.
- Budget docs: the only cap is a dollar list cost (`max_list_cost`, whole cents as a string, USD). Hitting it pauses the session (`budget_reached`) without killing it, overshooting by at most one request per thread. One budget is shared by all threads. It can be raised but not re-added once removed.
- Interrupts: `user.interrupt` stops the turn but doesn't end runs. Stop or continue runs by sending a message.
- Vault docs: secrets are write-only. The sandbox only sees a placeholder, which is replaced at egress, and only for `allowed_hosts`. Tokens returned by an exchange are NOT redacted. Max 20 credentials per vault.
- Parts 1–4 of a separate Managed Agents workshop (Phatak/Semach, Oct 11): the only durable state is an append-only session log, separate from the harness (brain) and sandbox (hands). Either can be replaced and resumed from the log, and time-to-first-token fell about 90%.
For Jarvis: TAKE the pause-don't-kill budget, egress-substituted secrets, the append-only log as the only durable state, and "completed is not passed."

A6. Other 2026 primary sources

a) Claude Code best practices (https://code.claude.com/docs/en/best-practices, READ) and /goal (https://code.claude.com/docs/en/goal, READ)
- Intake recipe: a minimal prompt, then "interview me in detail using the AskUserQuestion tool… write a complete spec to SPEC.md," then a FRESH session to execute. A good spec names files and interfaces, states what's out of scope, and ends with an end-to-end verification step.
- Four strengths of verification gate: in the prompt, a `/goal` condition, a deterministic Stop hook, or a refuting subagent or workflow. Require evidence, not claims of success.
- Reviewers prompted to find gaps always find some, and chasing them all causes over-engineering. Restrict them to correctness and requirement gaps.
- `/goal` is a prompt-based Stop hook. After each turn a small fast model reads the transcript (it can't run tools or read files) and returns not met, met or impossible. Conditions are up to 4,000 characters; add "or stop after 20 turns". It stops when there's no tool use for several turns. Check-ins come at 30 min and then back off.
- After two failed corrections, `/clear` and rewrite the prompt. `/batch` fans a change out to 5–30 worktree agents.
For Jarvis: TAKE the intake recipe (adding recommended defaults) and the /goal-style exit conditions.

b) Skills: https://code.claude.com/docs/en/skills (READ, first ~100k characters); https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices (READ, undated); Thariq, "Lessons from Building Claude Code: How We Use Skills", Mar 17, 2026, an X article read via a gist mirror and claude.dev (PARTIAL; the original on X is unreachable)
- Size limits: SKILL.md under 500 lines; references one level deep; a table of contents for reference files over 100 lines. Descriptions are written as triggers: 1,536 characters in Claude Code, 1,024 for `description` in the API spec.
- Portable frontmatter outside Claude Code is limited to name, description, license, compatibility, metadata and allowed-tools; other keys are a hard error.
- Thariq's highest-signal content is a gotchas section built from real failures. Product-verification skills had the most measurable impact. Don't railroad the model (give goals and constraints). Keep state in a stable data directory (`${CLAUDE_PLUGIN_DATA}`), since the skill folder can be wiped on upgrade. Use on-demand hooks (`/careful`, `/freeze`). Log skill usage with a PreToolUse hook to catch skills that under-trigger.
- Platform guide: write at least 3 evals before writing docs. Test with Haiku, Sonnet and Opus. Use plan, validate, execute with a `changes.json` for destructive batches. Give a default with an escape hatch rather than a menu of options.
For Jarvis: TAKE. Skills are the portable unit.

c) Agent teams (https://code.claude.com/docs/en/agent-teams, READ)
- Experimental: requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, interactive only (not available with `-p` or the SDK), and in-process teammates aren't restored on `/resume`. One team per session, no nesting.
- Mailboxes are JSON at `~/.claude/teams/{team}/inboxes/`. The task list uses file locks. `TeammateIdle`/`TaskCompleted` hooks can exit 2 to keep work going. Recommended size is 3–5 teammates with 5–6 tasks each.
- The "competing hypotheses" debugging pattern (5 teammates trying to disprove each other) counters anchoring.
For Jarvis: SKIP as infrastructure, since it isn't headless or resumable. Reimplement the debate pattern as a workflow.

d) Output styles (https://code.claude.com/docs/en/output-styles, READ)
- Built-in styles: Proactive, Concise, Explanatory (`★ Insight` blocks of 2–3 points in the chat, not in code) and Learning (Insight blocks plus `TODO(human)` at real design decisions, then it stops and waits).
- Custom styles are Markdown files in `.claude/output-styles/` with `keep-coding-instructions: true`; plugins can set `force-for-plugin`. Styles don't apply to non-fork subagents.
For Jarvis: TAKE Explanatory as the "teach me" mode. Learning mode's blocking wait conflicts with overnight runs.

e) Memory (https://code.claude.com/docs/en/memory, READ)
- Auto memory lives at `~/.claude/projects/<repo>/memory/`. The `MEMORY.md` index loads its first 200 lines or 25KB. Topic files are typed (user, feedback, project, reference) and stamped with a `modified` time. Claude skips anything it can derive from the code.
- Keep CLAUDE.md under 200 lines. Claude Code reads `AGENTS.md` natively (v2.1.277+) when no CLAUDE.md exists. Prefer `@AGENTS.md` imports over symlinks because of Windows. Use `/doctor prompt-audit`.
For Jarvis: TAKE the format wholesale.

f) Boris Cherny threads via Thread Reader (Jan 2 and Mar 30, 2026; READ via mirror, X itself is unreachable)
- He runs 5 terminal plus 5–10 web sessions on Opus with thinking. CLAUDE.md is updated whenever Claude errs. Most sessions start in plan mode.
- Subagents: verify-app and code-simplifier. A PostToolUse formatter hook. Pre-approved permissions instead of skipping them.
- Loops: `/loop 5m /babysit`, `/loop 1h /pr-pruner`. A Stop hook to continue. `claude -w` worktrees.
- `--bare` for up to 10x faster headless startup. Top tip: verification can 2–3x quality.
For Jarvis: TAKE loops for sweeps and `--bare` for subagent calls.

g) Found beyond the brief
- "How we contain Claude across products" (anthropic.com/engineering/how-we-contain-claude, May 25, 2026, READ). 93% of approval prompts were approved (fatigue). The OS sandbox (Seatbelt/bubblewrap, open source, network denied by default) cut prompts 84%. The auto-mode classifier catches about 83% of overeager actions, so it's one layer, not a full defense. A phished-prompt credential exfiltration succeeded 24 of 25 times; only egress and filesystem limits stopped it. Open problems: persistent memory and CLAUDE.md poisoning, and over-trusting subagent output. It doesn't name "declare, contain, detect."
- "New in Managed Agents: dreaming, outcomes, multiagent" (claude.com/blog/new-in-claude-managed-agents, May 19, 2026, READ). Dreaming is scheduled memory consolidation with optional review before changes apply. Outcomes pair a rubric with a grader in a separate context that retries until the work passes (up to +10 points, per Anthropic's internal benchmarks).

PART B: RECOMMENDATIONS FOR JARVIS

1. Default to one main loop with skills. Use subagents only for parallel independent fan-out, independent verification (review, security, QA) and quarantine of untrusted content. Don't make spec, design, architecture and build into separate role agents; run them as phases of one loop with artifacts on disk. Reason: lossy handoffs and Conway's law; about 2x latency. Sources: A3, A1.
   DISAGREEMENT: A2 and A5 argue single contexts fail through laziness, self-bias and drift. The two views reconcile on "split by context, not role": fan out over independent items and verification, and keep coupled sequential work in one loop.

2. Ship "jarvis-flow", a portable workflow runtime that mirrors Claude's API: agent, parallel, pipeline, phase, log, args, schema. Adapters call native Workflows on Claude Code and headless CLI or HTTP calls on Codex and DSH. Keep the same rules: deterministic scripts (no clock or random), a replay cache in `.jarvis/runs/<id>/`, 16-way concurrency, a 1,000-agent cap, schema retries 5, null on failure. Reason: this is the only multi-agent mechanism that is also headless and resumable. Source: A2.

3. Make an append-only event log (`.jarvis/log.jsonl`) the only durable state. Harness, model and sandbox should all be replaceable mid-run, with overnight resume rebuilt from the log. Claude's workflow resume is session-scoped, so Jarvis needs its own. Sources: A5 (brain/hands/session), A2.

4. Intake: run the documented interview-then-SPEC.md recipe, with a recommended default on every question, and front-load everything because workflows can't take mid-run input. Then execute in a fresh session. The spec must list out-of-scope items and an end-to-end verification step. Sources: A6a, A2.

5. Give every phase a /goal-style exit condition: one measurable end state, a stated check, constraints, and a turn or time clause. A separate cheap evaluator judges it from transcript evidence, backed by deterministic Stop hooks where possible. Sources: A6a.

6. Verification: build product-verification skills (browser, TTY) first. Require evidence. Order checks as rules, then visual, then a separate-context grader. Instruct reviewers to report only correctness and requirement gaps.
   DISAGREEMENT: A4 calls LLM-as-judge unreliable, while A6a, A6g and A2 rely on separate-context graders. Resolution: graders should judge evidence (test output, screenshots), not prose.

7. Money hard stop: (a) spending actions only via declarative, gated tools, never via bash (the reversibility rule); (b) an external budget enforced by the harness that pauses rather than kills, since the model doesn't know its budget; (c) advisory token budgets in prompts; (d) warn above 25 agents or 1.5M projected tokens, and try a small slice first. Sources: A1, A5, A2.
   DISAGREEMENT: in-prompt budgets (A2, /goal) versus hidden external caps (A5). Use both.

8. Secrets: never put them in agent context. Locally, emulate vaults with a small egress proxy or keychain-backed CLI wrappers that are scoped to host allowlists. Note that tokens returned by an exchange leak. Sources: A5, A6g.

9. Contain rather than approve for overnight runs: an OS sandbox with network denied by default and an allowlist, plus quarantine (agents that read the web get no write or deploy tools). Treat an auto-mode classifier as one layer only. Sources: A6g, A2.

10. Self-improvement: use the auto-memory format (a capped MEMORY.md index plus typed topic files; corrections go in `feedback`). Store curated learnings, not transcripts. Run a nightly "dream" consolidation sweep with review before it applies, and scan memory at startup for injection. Sources: A6e, A1, A6g.

11. Instructions: one AGENTS.md (under 200 lines) as the cross-harness source of truth, with a `CLAUDE.md` that just imports `@AGENTS.md`. Put procedures in skills that use only the portable frontmatter fields. Each skill gets 3 or more evals run on every harness and model tier, a gotchas section, and usage logging. Sources: A6e, A6b.

12. Teach-me mode: Explanatory-style Insight blocks in chat during unattended runs. Use the Learning-style `TODO(human)` only in attended sessions; otherwise queue those items into a morning digest. Ship it as a plugin output style on Claude Code (`keep-coding-instructions: true`) and as an AGENTS.md toggle elsewhere. Source: A6d.
    DISAGREEMENT: Claude Code's "Proactive" style codifies assuming instead of asking. That's the right behavior for engineering decisions and the wrong one for product decisions.

13. Model and effort routing: a classifier picks the model per subtask, but only at subagent or workflow-agent boundaries. Never switch models or change the tool set mid-session (cache rules); use deferred tool loading. Sources: A1, A2.

14. Keep a "harness assumptions" register: each piece of scaffolding is tied to the model weakness it covers. Re-test with a golden eval set (at least 10 tasks, each run at least twice, inspecting flipped tasks) on every model release, and delete what has become dead weight. Sources: A1, A3, A5.

15. Recurring sweeps: implement them as skills driven by `/loop` or scheduled tasks on Claude Code and by cron plus headless calls elsewhere. In headless runs, allow `Workflow(<name>)` explicitly, because the `ultracode` keyword doesn't trigger there. Sources: A6f, A2.

Unreachable or limited: the workshop transcript (chapters plus the Latent Space report only); the original Boris and Thariq posts on X (read via mirrors); the last ~14k characters of the Claude Code skills doc.