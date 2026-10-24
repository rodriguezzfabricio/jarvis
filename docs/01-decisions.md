# Jarvis: Design Decisions (v2)

Oct 23, 2026 · Fabricio + Claude

Each decision says what Jarvis does, why, and where the evidence comes from.
- **Evidence:** raw research notes are in `docs/research/`. "Oct 22 brief" means `Your Agent Workflow Research Brief.md` on your Desktop.
- **Reviews:** v1 of this doc was reviewed by two models that didn't write it. Claude Fable 5.1's review is in `docs/reviews/review-fable.md` and Codex (Astra)'s in `docs/review-codex.md`. Citations like "Fable F1" and "Codex H3" point into those reviews.
- **Numbering:** decisions 1–36 keep their v1 numbers, so the reviews still line up. New decisions are numbered 37 and up, placed in the section where they belong.
- **Stage 0 findings (Oct 23):** decisions 57–71 record what the stage 0 checks and the first Codex review found on Fabricio's Mac. Each says which earlier decision or doc line it supersedes or tightens. The raw check results are in `docs/stage0-findings.md`.

## What changed in v2

- **Scope.** Fabricio's choice: v1 runs on Claude Code (CLI and desktop app) with every capability he asked for. Codex comes next, then DSH; the cross-harness decisions (20–23) move to that phase.
- **Built in stages.** Nothing is cut. Each stage must work on the job automation, and beat plain Claude Code on the same tasks, before the next stage starts (decisions 36, 47).
- **Safety is structural.** No live credentials inside the workspace and network closed by default. Approved outside actions go through one broker; hooks are only a tripwire (decision 12).
- **Overnight runs survive real life:** usage caps, crashes and laptop sleep (41, 42), mid-run changes of mind (40), and getting stuck (3).
- **Taste is captured up front:** a one-time taste profile, plus a design direction always chosen from mockups (39).
- **Design has its own section (51–56):** three design files per project, a way to pick a direction without your input, a "looks AI-made" ban list, design checks run by code, a UX checklist for less friction and less reading, and clear limits on what AI reviewers can judge.
- **"Done" is harder to fake.** Checks live outside the build folder and run on a fixed revision (15). "Deployed" now needs proof the live app works (44).
- **The test set no longer leaks answers.** It gained brand-new products, a plain-Claude-Code baseline, and your own rating as the main measure (`02-golden-tasks.md`).

## The short version

- **Our own thin core, the best pieces borrowed.** Pieces come from superpowers, Matt Pocock, GSD, gstack, Addy Osmani, Spec Kit and Compound Engineering.
- **Research before asking.** Jarvis studies the code, the project's existing decisions (kept in one register per repo and checked for conflicts with every new request), similar products, and existing tools. Then it asks one round of product questions with recommended defaults, including the design direction with mockups.
- **Autonomous after that.** A crash-safe runner works task by task, waits out usage limits, accepts `jarvis steer` corrections, and never leaves you without a last working version.
- **Outside actions need approval.** Sending, deploying to production and spending can only happen through an approval broker; the credentials don't exist anywhere else.
- **Agents make claims; only the runner makes evidence** (decision 49). **Done is decided from that evidence:** protected tests, interaction tests, screenshots, an accessibility scan, standards checks, and a fresh-context reviewer. "Deployed" also needs a live smoke test and a rollback plan.
- **Design:** you pick from 3 mockups grounded in the product's world. Code bans the "looks AI-made" tells, the tokens are locked, and UX rules keep friction and reading low.
- **Strong models plan and review; cheap models explore.** Scripts run the tests, not models.
- **Memory is small markdown files.** A mistake that repeats becomes a rule.
- **House stack for new projects:** TypeScript, Next.js, Postgres (Neon) with Drizzle, Better Auth, Expo, Tauri, pnpm, Vitest and Playwright, on free tiers. In existing repos, the repo's own stack wins.

```
idea ─► research (code, existing decisions, similar products, tools) ─► questions + 3 design mockups (once, with defaults)
     ─► versioned spec ─► you confirm (or defaults after 15 min)
     ─► task loop: build ─► protected checks ─► review/security/QA/standards ─► commit last-green
            ▲      │ fail (max 2 repairs)           ▲ steer / replan         │ usage cap → sleep, resume
            └──────┘                                └────────────────────────┘
     ─► preview deploy ─► (production only if approved for this project) ─► live smoke test ─► morning report
```

---

## 1. The shape of the system

### 1. Build our own thin core; borrow pieces with credit
Jarvis is a small core (intake, runner, ledger, gates, safety broker, memory, routing) plus about 14 skills, several of them adapted from community packs.
*Why:* no existing framework runs autonomously on Claude Code, Codex and DSH. Each candidate base also fights a single up-front intake:
- superpowers asks one question per message.
- GSD adds hooks on every tool call and more than 100 commands and agents.
- gstack needs Bun, a Chromium daemon, and about 15k tokens per call.

Lab engineers run lean setups. Almost everything worth taking is MIT or Apache-2.0. Both reviewers suggested native Claude Code plus one community pack as an alternative, so that combination becomes the baseline Jarvis has to beat (decision 47).
*From:* research/03; Fable §6; Codex §6.

### 2. One main loop with skills; subagents where context separation pays
Spec, design, architecture and build are phases of one loop that writes files to disk, not separate "PM agent / architect agent" roles. Subagents are used for:
- parallel read-only research,
- independent checking (review, security, QA),
- reading untrusted web content, with no write tools.

When a build splits into independent tasks, 2–4 workers can run in separate worktrees under a planner that has already made every decision. This is a default in skills and config, not hard-coded in the runner, because the main evidence for it is one Oct 22 vendor article and could change.
*Why:* Anthropic found one agent with skills loaded on demand often beat subagent designs. Role agents lose detail at handoffs. Codex's docs warn that parallel writes conflict.
*From:* research/01 (A3), research/02 (#3, #8); Fable F15.

### 3. A small runner drives long runs from outside the model
`jarvis run` works through the plan one task at a time. Each task gets a fresh `claude -p` session and a goal-style exit condition: one measurable end state, the check that proves it, and "or stop after N turns". The runner checks the gates itself and handles four situations the model can't:
- **Usage caps.** When Claude Code reports a usage limit, the runner saves state, sleeps until the window resets, and resumes. Waiting never counts as a failure or uses up a repair attempt (decision 42).
- **Failures.** A task that fails its gates or review twice is marked blocked (GSD's repair budget of 2). If the blocked task is on the critical path, the runner tries the next-best alternative from the decision log once. Either way it always tags the last working commit, so you never wake up to a broken tree.
- **Steering.** Between tasks, the runner reads your `jarvis steer` notes (decision 40).
- **Explicit config.** It passes settings, agents, MCP servers (`--strict-mcp-config`), the skills folder, AGENTS.md and the permission mode on the command line, so a personal or friend's global config can't change behavior. It runs normal (non-bare) `claude -p` on your subscription. Bare mode skips all of that and needs a pay-per-token key, so if Anthropic makes it the default, switching to a key is a money decision for you.

*Why:* a fresh context per task avoids long-session drift (the Ralph idea). "Completed" doesn't mean the work passed (Managed Agents). Claude's own resume only works within one session.
*From:* research/01 (A2, A5, A6a), research/03, research/04; Fable F1, F5, F13.

### 4. Files are the memory; the model is replaceable
- `AGENTS.md` (about 100 lines) is a table of contents.
- `docs/` holds the spec (versioned), design, decisions and research.
- `.jarvis/` holds run state, and the ledger there is the single authority (decision 41).
- `plan.md` and `progress.md` are human-readable views of that ledger.

*Why:* OpenAI keeps AGENTS.md at about 100 lines pointing into `docs/`. Anthropic's long-running harness uses a feature list plus a progress file. Managed Agents keep an append-only log as the only durable state, so the harness and sandbox can be swapped.
*From:* research/01 (A5), research/03.

### 41. A crash-safe ledger (new)
`.jarvis/ledger.jsonl` is append-only and the only source of truth for run state:
- **Every attempt is recorded:** a task ID, an attempt ID, a lease (so two runners can't grab the same task), and the revision it started from.
- **Atomic checkpoints:** a state change is written before the next step begins.
- **Outside actions have three outcomes.** Every action through the broker (decision 12) gets a receipt: *succeeded*, *failed*, or *unknown*. An unknown outcome is never retried automatically; it waits for reconciliation in the morning report. If the runner dies after an email is sent but before that's recorded, a restart must not send it twice.
- **Clean restarts:** child processes, worktrees and browsers from a dead run are cleaned up when the runner starts.

*Why:* Codex showed the gap: "fresh sessions and files" didn't define what happens on a crash, a sleep, or an ambiguous result. Your own FreeHire P4.5 requires the same discipline for email sends.
*From:* Codex H3.

## 2. Intake: the fix for silent assumptions

### 37. Size the task first (new; restores the Oct 22 tiers)
| Tier | When | What runs |
|---|---|---|
| 0 | One sentence, easy to undo, covered by tests | Straight to reproduce → fix → checks |
| 1 | A small change in known code | Assumptions + short spec |
| 2 | New product, new dependency, auth, data, public API, several modules, hard to reverse | Everything in this section |

*Why:* heavy specs took as long to review as writing the code (Böckeler). Task 5 in the test set ("citizenship filter misses jobs") should be tier 0.
*From:* Oct 22 brief; Fable F9.

### 38. The project's existing decisions come before generic defaults (new)
Before research or questions, Jarvis reads what the project has already decided: the backlog and its acceptance criteria, AGENTS.md, decision records, and its money and safety rules. These are fixed constraints; a generic best practice never overrides them. When Jarvis thinks one is wrong, it says so in the report (a Challenge, decision 11) and still follows it.
*Why:* the v1 expected answer for the recruiter test included follow-up emails, which your FreeHire backlog explicitly excludes ("no follow-up campaign"). Jarvis would have been rewarded for expanding scope.
*From:* Codex H1.

### 48. One decision register per project; conflicts are shown, never settled silently (new)
**Where decisions go.** A single `docs/decisions.md` in the code repo itself, not in a separate research repo. It has one line per decision:
- an ID and the date,
- the decision,
- who made it,
- its status (active, or superseded by which decision),
- a link to its source.

It's short enough to read in two minutes. Jarvis writes it automatically from your intake answers, the defaults you accepted, and its own logged calls (decision 11). You never maintain it by hand.

**How firmly each decision holds** depends on who made it:

| Made by | Firmness |
|---|---|
| You, explicitly | Firm. Only you can change it |
| A default you accepted | Firm until you change it |
| Jarvis (Mechanical or Taste calls) | Jarvis may revisit it, with a note |
| Inherited or reconstructed from old files | Confirmed with you once |

**Conflict check at every intake.** Each new request is compared with the active decisions. Three rules settle it:
- **An explicit new request beats an older decision.** The old one is marked superseded, with today's date and your reason.
- **Silence never overrides an old decision.** If the new request doesn't mention something, the old decision stands.
- **Jarvis's own ideas never override yours.**

When there's a real conflict, it becomes one of the intake questions. For example: "On Oct 20 you decided *initial outreach only, no follow-ups* (source). This request implies follow-ups. Keep the old decision, switch, or allow it for this feature only?" The question comes with a default.

**Superseded, never deleted.** The history explains why the code looks the way it does, and changing a decision triggers the targeted replan in decision 40.

**Recovering decisions in old or vibe-coded repos.** During onboarding, Jarvis reconstructs past decisions from the code, commits, backlog, docs and agent notes (e.g., `.depth-engine` runs). Each one is labeled "inferred", with its evidence. You see the 10 most important once; the default is "keep".

**Coming back after a while.** If you haven't touched a project in 7 or more days, Jarvis opens with a 5-line "where we left off": the current state, open items, and the decisions that matter for today's request. `jarvis why <thing>` answers any time, citing the register.

*Why:* the "no follow-ups" decision was your explicit answer on Oct 20. It was saved, but in `OpenSouce Job/.depth-engine/runs/de-0001/work/operator_clarifications_round_1.json`: a different repo from the code, among hundreds of files. Neither you nor an agent working in `freehire-impl` would ever see it, so a generic default nearly overrode it. Decision records (ADRs) are standard practice for this; Jarvis makes them automatic and checks against them.
*From:* Codex H1, H2; the Oct 22 brief (decision records).

### 5. Research before asking
Jarvis reads the codebase and connected tools first and never asks what it can look up. Then it does two kinds of research:
- **Product research (new products, tier 2):** study 3–5 real products that solve the same job. Note what they all do (expected features, flows, words), what users complain about, and where there's room to be better. That feeds the story map and the design directions.
- **A build-vs-buy spike** whenever a feature needs outside data, touches a common problem (auth, email, payments, search, scraping), or acts on other people:
  1. Search the repo, package registries, GitHub, vendor APIs (prices checked live) and MCP servers.
  2. Shortlist 3–5 options, including "do it manually".
  3. Score them on fit, cost, terms of service, maintenance and lock-in.
  4. Quick-test the finalists on a small sample.
  5. Log the decision with its rationale and alternatives.

*Why:* this is the step that failed in your recruiter feature. Fable's "habit tracker" walk-through showed the spike alone covers components, not "what should this product be".
*From:* research/06 (§1, §3); Fable §3.

### 6. Write the "day after launch" story, then map the workflows
1. One job story.
2. A short paragraph about you after launch: what you do, see, and where.
3. The top 3 reasons it could fail.
4. A story map from trigger to outcome.
5. An umbrella test.

Umbrella signals: chained verbs, fallbacks, "for each", missing data, a real person receiving something, or a time dimension. If it's an umbrella, Jarvis builds one complete thin path first (a "walking skeleton").
*Why:* this forces the product thinking the agent skipped. These are practitioner methods; no study has tested them with agents.
*From:* research/06 (§1, §4).

### 7. The product-or-engineering rule
A question is a product question if it changes what you see, do, pay or risk, or causes something irreversible outside your computer. Jarvis asks you those. It decides everything else and logs it.
*From:* research/06.

### 8. One round of questions, ranked, each with a default
Questions are ranked: scope first, then security, privacy and legal, then UX, then technical. There are up to 7, and the design direction is always one of them (decision 39). Each question has:
- one line on why it matters,
- a recommended default with its reason,
- 2–3 alternatives.

Replying "defaults" accepts all. Extras beyond 7 become logged assumptions. Jarvis lists its assumptions with confidence levels first (GSD's assumptions mode).
*Why:* about 3 questions at the start raised success from 22% to 37% in one preprint (CLARITI). Questions past the halfway point did worse than none. You don't mind questions, so the cap is 7.

What's borrowed and what's new:
- The per-question format comes from Spec Kit and Matt Pocock.
- Asking everything in one round with a "defaults" reply is Jarvis's own.

*From:* Oct 22 brief, research/03, research/06.

### 39. Taste: a profile once, a direction from mockups every time (new)
- **Taste profile (once, about 10 minutes, stored in memory):**
  - 3–5 apps or sites you admire, and one you think looks AI-made,
  - serious or playful,
  - colors and fonts you dislike,
  - the platforms you live on.

  Every later design default starts from this profile, not from the model's average taste.
- **The design direction is always asked.** Jarvis attaches 3 quick, static mockups of genuinely different directions. They differ in layout and flow, not just colors. You pick one or reply "defaults".
- **Mockup-first for new products in away mode.** Night one produces the spec, the 3 mockups and the walking skeleton in the default direction. Night two builds the rest in the direction you picked. Changing direction after one night is cheap; changing it after a finished UI means a rebuild.

*Why:* in away mode every product choice becomes the model's guess after 15 minutes, and memory is empty on day one. A morning veto of a finished UI wastes the night.
*From:* Fable F4; Codex M1. How the directions are made and checked is in decisions 51–56.

### 9. A checkable, versioned spec, then one confirmation
The spec contains:
- user stories ranked P1/P2/P3,
- acceptance criteria written as "WHEN … THE SYSTEM SHALL …" (Kiro's EARS format),
- goals and non-goals,
- assumptions, each marked as one of two kinds:
  - **Fixed constraint:** from the project or from you.
  - **Delegated preference:** a choice you left to Jarvis.

The spec is versioned (`spec v1`, `v2`…), and each task records which version and which assumptions it depends on. A fresh-context reader checks the spec for gaps first. Then you get one page, "here's what I'm building, and what I'm not". That's the only up-front approval; later approvals are the hard stops (decision 12) and the vetoes in the morning report.
*From:* research/06, research/01 (A6a), research/03; Codex H2.

### 10. Away mode proceeds on defaults
If you don't answer within 15 minutes (configurable), Jarvis takes the defaults, marks them "unconfirmed", and keeps going. The spec confirmation works the same way, and the unconfirmed spec goes at the top of the morning report. For new products, mockup-first applies (decision 39). Hard stops still apply.

### 40. Changing your mind mid-run (new)
- **`jarvis steer "…"`** leaves a note in the runner-owned inbox that the runner reads between tasks (decision 87).
- **A change to a fixed constraint or a P1 story produces a new spec version.** Jarvis finds the tasks and checks that depended on the old version, marks them stale, and replans only that slice. Finished work that's unaffected stays.
- **A morning veto works the same way.** Vetoing a Taste decision (decision 11) replans what depended on it.
- **Out-of-scope choices get a blocked state.** If Jarvis hits a choice outside what you delegated (e.g., a provider turns out to be unavailable and the only alternative costs money), the task waits for you instead of guessing, and the rest of the plan continues.

*Why:* one intake can't govern a run where things change. v1 turned every new fact into a logged assumption forever.
*From:* Fable F12; Codex H2.

## 3. Autonomy and safety

### 11. A decision log with three classes
Adapted from gstack's autoplan:
- **Mechanical:** decided silently.
- **Taste:** decided, shown first in the morning report. Each Taste entry lists what depends on it, so a veto triggers a targeted replan (decision 40).
- **Challenge:** never decided alone. That covers two cases:
  - Jarvis and its reviewer both think your stated direction or a project rule should change. Jarvis follows what you said and raises the challenge in the report.
  - The hard stops.

Each entry records the choice, why, and the alternatives (gstack's columns), plus how hard it is to reverse (a Jarvis addition).
*From:* research/03.

### 12. Safety is structural: no credentials, closed network, one approval broker
Both reviews showed that hooks and command patterns can't be the main defense:
- "Sending a message" can happen through `curl`, a compiled program, a test fixture, an MCP server or a browser.
- Claude Code's file, web and MCP tools sit outside its shell sandbox.
- Codex silently disables hooks that changed.

So Jarvis has three layers, in this order:

1. **Nothing dangerous exists in the workspace.** The build workspace and the sandbox hold no live credentials for sending, production deploys or payments. Network access is closed by default, with a per-project allowlist (package registries, docs, localhost, the preview host). Policy files and credentials live outside any folder the agent can write to.
2. **One broker for approved outside actions.** `jarvis act <operation>` is the only way to:
   - send a message to a real person,
   - promote to production,
   - spend money,
   - delete data, or force-push.

   The broker holds the credentials. It checks the exact operation and payload against an approval in the ledger (decision 41) and returns a receipt.
3. **Hooks are tripwires, not walls.** A PreToolUse denylist (force-push, `rm -rf`, production deploy flags, schema pushes) and a Stop gate catch mistakes early.

Approvals:
- **Production deploys:** approved once per project at intake (your answer). Preview deploys are automatic, using a preview-only token.
- **Messages to real people:** each exact message is approved before it's sent. Apps Jarvis builds ship their own irreversible outside actions behind a user approval by default.
- **Spending:** any new spend needs your approval, with no "small amount" exception. This includes metered API calls. When DeepSeek arrives in a later phase, a per-run DeepSeek budget you approve up front counts as that approval.

Before overnight runs are trusted, the safety tests try to send, deploy and spend through every channel: shell, file and web tools, MCP, browser, and generated app code. Each attempt must fail without the broker.
*From:* research/01 (A1, A6g), research/02 (#4, #8), research/04, research/06; Fable F3, F5; Codex C1.

### 13. Contain instead of asking permission
Overnight runs use Claude Code's sandbox plus the network allowlist, so Jarvis rarely needs to ask. Agents that read web pages get no write or deploy tools. Secrets go through a pluggable backend: an env file outside the repo by default, with the macOS Keychain optional. A Keychain-only design would break "any OS".
*Why:* in Anthropic's data, 93% of approval prompts were approved, a sandbox cut prompts by 84%, and a planted-prompt credential theft worked 24 times out of 25 until file and network limits stopped it.
*From:* research/01 (A5, A6g); Fable F16.

### 59. The safety config is checked live and fails closed (new; stage 0)
Checked on Claude Code 2.1.309 on macOS:
- **A bad settings file is dropped silently.** One wrong-typed value made `claude -p` ignore the whole `--settings` file, sandbox and deny rules included, with nothing on stderr. So a file that parses is not proof the protections are on.
- **Permanent requirements for every task session.** Each has a test:
  1. `sandbox.failIfUnavailable: true` and `sandbox.allowUnsandboxedCommands: false`. Without the first, a sandbox that can't start means commands run unsandboxed.
  2. `--permission-mode dontAsk --permission-prompts none`. With these, a dropped settings file fails closed: nothing is pre-approved, so every tool is refused. Any other mode would fail open.
  3. ~~`--setting-sources project` (decision 60).~~ Superseded by decision 68: `--restricted` with an explicit tool list.
  4. `autoMemoryEnabled: false` (decision 60).
  5. **`jarvis doctor` runs a live canary probe before every unattended run.** A real `claude -p` with the generated settings must fail to read a planted canary file via Bash and via the Read tool, must fail to reach a non-allowlisted host, and must fail to write outside its worktree. It must also succeed in reaching the broker socket. If any result differs, the run doesn't start.
- **What was verified:** `sandbox.filesystem.denyRead` blocks shell reads, and a `Read(//abs/path/**)` deny rule blocks the Read tool. These are separate layers, because the file tools sit outside the shell sandbox. `sandbox.network.allowedDomains` blocks other hosts. `sandbox.network.allowUnixSockets` allows exactly the listed socket, but only by its **real path**: `/tmp/x.sock` failed and `/private/tmp/x.sock` worked. The broker socket path is always resolved with `realpath` before it's written into settings.
- **Permission-rule paths** use `//` for absolute paths. `/Users/...` is read as relative to the settings file.

Tightens decisions 12 and 13. Resolves the *(verify)* items in architecture §3.6 and §5.
*From:* stage 0 probes, Oct 23 (`docs/stage0-findings.md` §3); Claude Code sandboxing and permissions docs.

### 43. Account setup, once (new)
`jarvis setup` is run once, with you present. It walks through creating and connecting the house-stack accounts: GitHub, Vercel or Netlify, Neon, Cloudflare, Expo, and an OAuth app for sign-in. It stores the tokens through the secrets backend (decision 13). Tokens are scoped to previews wherever the provider allows it. Production tokens go only to the broker.

Until a project's accounts exist, Jarvis develops against local services (SQLite, or Postgres in Docker) and never hand-rolls a replacement, such as its own auth, to get around a missing account.
*Why:* walking through "build me a habit tracker", the run stalls at the first `DATABASE_URL`, or the agent writes its own auth, which Claude Code does 48% of the time when left alone.
*From:* Fable F2; research/05.

### 14. Budgets: reserve before dispatch, pause rather than kill
- **Reserve first.** Before starting a task, the runner reserves its budget in the ledger, including reviewers and tools.
- **Pause, don't kill.** At the cap, Jarvis stops starting new work, lets in-flight work finish or checkpoint, and saves state.
- **On subscriptions** (you're on Max 20x), the real budget is your usage window, and decision 42 covers that.
- **No silent paid fallback.** Jarvis never falls back to pay-per-token credentials on its own.

*From:* research/01 (A2, A5), research/04; Codex H3.

### 42. Subscription reality (new)
Claude Code's headless runs (`claude -p`) draw from the same usage windows as your interactive use. So overnight runs and daytime work share Max 20x's limits.
- The runner logs how much of the window each task uses.
- It sleeps through resets (decision 3).
- It tells you in the report when a run spent most of a window.

Overnight runs are realistic on Max 20x but not unlimited.
*From:* Fable F1 (sources: Claude Code headless docs and usage-limit reporting, checked Oct 23).

### 62. Usage limits are read from `rate_limit_event`, not from the exit code (new; stage 0)
Every `claude -p` run with stream-json emits a `rate_limit_event`: `rate_limit_info.status` (`allowed`, `allowed_warning`, `rejected`), `resetsAt` (Unix **seconds**), `rateLimitType` (`five_hour`, `seven_day`, …) and `unifiedWindows` with each window's `utilization` and reset.
- The runner logs both windows' utilization before and after each task. That is the usage measure for decisions 26 and 42.
- A limit is detected from `status: rejected`, or from an assistant `error` of `rate_limit`. It is never inferred from the `result` message or the exit code: the docs show a limited run can end with `subtype: success`, an empty result and exit 0.
- The sleep lasts until `resetsAt` plus a margin, then the runner re-probes before resuming.
- Not yet observed live: the exact stream a session emits at the moment it is rejected. The fake-`claude` fixture covers it; a real capture is added when one occurs naturally.

Tightens decisions 3 and 42. Resolves architecture §9 item 2.
*From:* stage 0 probe (a live `rate_limit_event` captured); Claude Code headless and errors docs.

### 65. Jarvis runs only Fabricio's own work on his own plan (new; stage 0)
Anthropic's terms say Pro and Max limits "assume ordinary, individual usage of Claude Code and the Agent SDK". They neither ban nor clearly allow long unattended runs. So:
- Jarvis runs only Fabricio's own projects, logged in with his own subscription, with modest concurrency (decision 46, decision 63).
- It never routes anyone else's runs through his login, and it never offers its login to other tools.
- When Jarvis is packaged for friends (stage 7), each person signs in with their own account. There is no shared login, token or relay.

Tightens decision 42.
*From:* Claude Code legal and compliance docs, and the Pro/Max plan support article (checked Oct 23); Fabricio, Oct 23.

### 15. Guard against the agent gaming its own checks
- **Protected checks.** The acceptance tests, test configuration and gate scripts live outside the repo, in `~/.jarvis/projects/<project>/checks/`, owned by the runner. They run against a fixed candidate revision (a commit hash). Jarvis can't pass by changing test discovery, scripts, fixtures or the gate itself. Once a task is accepted, the runner commits its tests into the repo so the project keeps them (decision 49 has the full rules).
- **Legitimate test changes are allowed** but go through a separate review.
- **Reviewers check for fixes copied from elsewhere.**
- **Jarvis's own benchmarks run on sanitized snapshots** with no history and no network (`02-golden-tasks.md`).

*Why:* Cursor found that 63% of one top model's "successful" benchmark solves looked up the answer. Telling models to keep going without stopping made this worse.
*From:* research/02 (#8), Oct 22 brief; Codex H4, H6.

## 4. What "done" means

### 49. Who writes the evidence, and who can change it (new)
The rule: **agents make claims; only the runner makes evidence.** Jarvis doesn't try to make agents never lie. It makes their words count for nothing until the runner has checked them.

| | Who can write it | Who can change it | How tampering is caught |
|---|---|---|---|
| **Code, notes, plans** | Agents | Agents | Not evidence; reviewed like any claim |
| **Check definitions** (acceptance tests, test config, gate scripts) | The runner, from the approved spec | Nobody during a run. Loosening a check needs a reviewer; loosening an acceptance criterion needs you (a Challenge) | They live outside the repo, agents' file tools are denied there, and the runner checks each file's hash against the approved version before running it |
| **Evidence** (exit codes, test logs, screenshots, scan results) | Only the runner, by running the check itself and capturing the raw output straight from the process | Nobody. It's append-only | Each entry carries the hash of the one before it, and the latest hash is kept outside the workspace. Editing history breaks the chain |
| **Ledger** (task states, approvals, receipts) | Only the runner and the broker | Nobody. It's append-only | The same hash chain |
| **Morning report** | The runner builds the status and evidence sections from the ledger; agents may add narrative | — | Narrative is labeled as the agent's words. Any claim without an evidence entry shows as "unverified" |

When and how evidence is made:
- **After the session, on a fresh copy.** The runner makes evidence only after the agent's session has ended, on the committed revision, in a fresh checkout. Nothing the agent did during the session (cached results, edited logs, a hand-typed "all tests pass") can affect it.
- **Agent-reported output never counts.** Text an agent pastes, such as "tests passed", is never copied into evidence.
- **Reviewers start from evidence, not narrative.** A reviewer gets the diff, the spec and the runner's evidence. It doesn't get the builder's account of what it did, so it isn't anchored by that story.
- **We measure it.** The false-done rate (decision 35) tracks how often an agent claimed done when the evidence said otherwise.

Keeping context clean, so agents aren't misled in the first place:
- **A fresh session for every task** (decision 3), so errors don't pile up in one long context.
- **Handoffs are structured.** Between sessions they're the spec version, the plan and the ledger state, not an agent's free-text summary. A summary, when included, is labeled as a claim.
- **Subagent output is a claim until verified.** Anthropic lists over-trusting subagent output as an open problem.
- **Web pages are read by quarantined agents** with no write tools, and what they return is treated as data, never instructions (decision 2).
- **Memory is scanned for planted instructions,** and new memory comes only through the approved-learning path (decisions 27–28).
- **Long tool output goes to files,** not into context (Cursor).

The honest limit: on a Mac, agents run as your user account. These measures make tampering hard and always detectable, not impossible. Running agents in a separate container or user account is the stronger option for later. The fault-injection test in task 10 tampers with a check file on purpose to prove the detection works.
*From:* Codex review (H4 and Fabricio's follow-up with Astra); research/01 (A6g, the open problem of trusting subagent output); research/02 (#8, reward hacking); Depth Engine's hash-chained evidence store (idea only).

### 16. Done is decided outside the model, from evidence tied to a revision
A task is done only when the protected checks pass on the candidate revision:
- build, typecheck, lint, tests and a secrets scan,
- every acceptance criterion maps to a passing check,
- the relevant standards lanes pass (decision 45),
- for UI work:
  - interaction tests that actually click through the flow (a screenshot alone doesn't prove anything works),
  - screenshots at 3 screen sizes,
  - zero serious accessibility issues,
- a reviewer verdict of PASS.

The evidence is stored with the revision it came from. Checks are trusted in this order: rules, then interaction and visual checks, then a fresh-context grader that judges evidence. Graders are calibrated against your own ratings.
*From:* research/01 (A4, A6a, A6f); Codex H4.

### 17. An independent reviewer, then a separate security pass
**Review:** a reviewer in a fresh context checks the diff against the spec and acceptance criteria.
- It gets read-only access to the whole repo, because an unchanged caller can make a change wrong.
- It can run reproductions.
- It reports correctness and requirement gaps with a confidence score.
- Low-confidence findings are dropped, except high-impact ones (security, data loss, money, messages), which go to investigation instead.
- A position changes only on new evidence.

**Security:** Cursor's checklist plus semgrep, gitleaks and osv-scanner. Prompt-injection risks get a hostile-content trial, not just a code read.
*Why:* models favor their own output, and reviewers told to find gaps over-engineer.
*From:* research/01 (A5, A6a), research/02 (#7, #8), research/03, Oct 22 brief; Codex H4, test gap 1.

### 18. QA on every UI change, on the real target
- **Web:** Playwright interaction tests plus screenshots, reading the accessibility tree first. Also tested: empty, loading, error, stale-data and keyboard-only states.
- **Mobile:** a built app on the iOS simulator with Maestro flows (Xcode is on your Mac). Expo web screenshots don't count.
- **Desktop:** a built Tauri app with a native smoke test.
- **When a native test isn't possible,** the report says the release is web-only rather than implying otherwise.

*From:* research/02 (#4, #8), research/03, research/04, research/05; Fable F14; Codex M1, M2.

### 44. Three release states, and proof the live app works (new)
| State | Means |
|---|---|
| **Preview-ready** | Checks pass and a preview deploy is up |
| **Release-ready** | Also: a release manifest (what's deploying, where, which migrations), a migration rehearsal on a copy of the data, a tested backup restore, and written rollback steps |
| **Deployed** | Also: the production deploy went through the broker, a smoke test passed against the live URL, and you have a clear signal if it fails afterward |

The morning report states which of these the work actually reached; it never says "deployed" when only the build passed. Full monitoring and incident automation come later. Recovery instructions don't wait.
*From:* Codex H5; Fable F3.

### 50. Reaching you when you're away: the runner sends it, so it works with any harness or model (new)
Notifications come from the runner, a plain script, not from the model or the harness. So they behave the same whether Claude, GPT or DeepSeek is doing the work. The notifier is a tiny adapter with two jobs, "send a message" and "check for replies".

- **Default: [ntfy](https://docs.ntfy.sh/)** (free, open source).
  - There's no account or password. Jarvis sends a plain web request to a long, random topic name generated by `jarvis setup`, and you subscribe to that topic in the ntfy phone app.
  - Jarvis notifies you when it needs an answer, when a run finishes or gets blocked, and when a hard stop is waiting.
  - You answer with a button such as "Use defaults", "Approve" or "Pause". Each button is an ntfy `http` action that POSTs a fixed answer to a second, reply topic. The runner polls that topic between tasks (`/json?poll=1&since=<last id>`).
  - **There are no typed replies.** ntfy has no text-input action (corrected in stage 0). For a free-text answer, such as a steer note, you open the reply topic in the ntfy app and type into its publish box. The runner reads that as a steer note. Anything longer waits for `jarvis steer` at the computer.
  - Setup checks that buttons and publish-box replies both reach the reply topic on your phone before away mode relies on them.
  - **Every answer gets a confirmation, and repeat taps don't count** (from the stage 0 phone test). On iOS a button tap gives no visible feedback, so in the test 34 taps arrived for one question. So:
    - Each button's body carries the request ID and a one-time nonce (`approve:<request>:<nonce>`).
    - The runner takes the **first** valid answer for a request and ignores the rest.
    - It then posts a confirmation to the main topic: "Got it: Approve (request …)", naming the answer that counted.
    - An answer with an unknown or reused nonce is ignored and logged. Anyone who learns the topic name could post to it, so a bare "approve" counts for nothing.
    - For approvals of outside actions (decision 12), a tap is only the answer. The broker still checks the exact payload hash.
  - Limits on the public server: at most 3 buttons per message, 250 messages a day, and 2 MB per attachment. The docs call the iOS app "a little buggy", so a missed notification must never block a run: the 15-minute default still applies (decision 10).
- **Optional: email, send-only,** through your mail provider's SMTP with an app password. Jarvis can send, but it never reads your inbox; you answer through ntfy or at the computer. Email isn't the default because it needs credentials, and two-way email would mean giving Jarvis access to read your inbox.
- **Privacy:** messages pass through ntfy's public server, and the topic name acts as the password. Messages stay short (questions and status, never code or secrets), and the full details stay in `REPORT.md` on your Mac. Self-hosting ntfy, or using its access tokens, is an option later.
- **Limits:** ntfy messages are capped at about 4 KB of text, and attachments such as mockup screenshots expire after 3 hours.

*Why:* it works for anyone who uses Jarvis, on any harness or model, with almost nothing to set up.
*From:* ntfy publish and subscribe docs (checked Oct 23); Fabricio's requirement that it work everywhere and be easy.

### 19. The morning report
`REPORT.md`, plus a short summary in chat:
- the state reached (decision 44) and how to run or open it,
- the evidence, tied to the revision,
- Taste decisions, unconfirmed defaults and Challenges first,
- tasks that are blocked or waiting for reconciliation (decision 41),
- what's left and why,
- usage-window and token use.

It ends with a one-line "reply here to steer" (decision 40).

## 5. Same behavior across harnesses (later phase: Codex, then DSH)

Decisions 20–23 apply when Codex and DSH are added. v1 already uses AGENTS.md and the standard skill format, so adding Codex later is mostly configuration.

### 20. One source of truth, config generated for each harness
`jarvis sync` generates each harness's files from one source:

| Piece | Generated as |
|---|---|
| Instructions | `AGENTS.md`, plus a one-line `CLAUDE.md` containing `@AGENTS.md` (works on every Claude Code version and on Windows; in existing repos the line is added to the CLAUDE.md that's already there) |
| Skills | `.agents/skills/`, symlinked into `.claude/skills/` |
| Subagent roles | role files for each harness |
| Hooks | hook config for each harness |

rulesync can emit much of this; its Claude Code rules target is turned off. CI fails if the generated files drift from the source.

Constraints: no `@imports` in AGENTS.md, AGENTS.md under 32 KiB, standard skill frontmatter only.
*From:* research/04.

### 21. Checks are commands, so every harness can run them
Every rule that matters is a command (`jarvis gate …`) that exits non-zero with a JSON reason. Hooks enforce them where hooks exist: 33 events in Claude Code, 12 in Codex, and 7 in DSH's experimental bridge. The runner re-checks regardless. Safety never depends on hooks (decision 12).
*From:* research/04.

### 22. "Same behavior" means same process and same checks, measured
The same DeepSeek model scores 65.5–74.2 on one coding benchmark depending only on the harness. So Jarvis promises the same gates and process, not identical code. A conformance suite runs the golden tasks across harnesses and checks:
- gate results,
- whether the hooks fired,
- which skills loaded,
- which model each role actually used.

A preflight probe checks versions and capabilities, and unsupported combinations refuse unattended runs (decision 46).
*From:* research/04; Codex H7.

### 23. Each model family in its home harness
- Claude models run in Claude Code.
- OpenAI models run in Codex.
- DeepSeek runs in DSH. In DeepSeek's own tests its newest model scored best there among the three: 72.6, versus 69.8 in Claude Code and 65.6 in Codex. DSH is a developer preview that warns of breaking changes, which is why it comes last.

Other notes:
- DeepSeek inside Claude Code works through DeepSeek's endpoint, but Anthropic doesn't support it.
- Codex desktop is now the Codex mode of the ChatGPT desktop app.
- Whether Grok Build reads AGENTS.md and skills is unverified.

*From:* research/04, research/02 (#10); Fable F6.

### 46. Version pins and a preflight probe (new)
`jarvis doctor` runs before every unattended run. It checks:
- the exact Claude Code version Jarvis was tested with,
- that the sandbox works,
- that the network allowlist is enforced,
- that the broker is reachable,
- that the protected checks are in place,
- that the desktop app and CLI read the same settings.

It also checks your machine:
- **Sync folders:** it warns if any project folder is inside iCloud Drive or a synced Desktop or Documents folder. Syncing `.git` and `node_modules` corrupts and slows repos.
- **Concurrency:** it sets limits from your memory. On 16 GB the default is 2 writing agents, 1 headless browser, and only the Docker services a task needs.
- **Sleep:** it keeps the Mac awake (`caffeinate`) for the whole run.

If anything fails, the run doesn't start unattended. Your Claude Code is 2.1.270 (Codex checked it locally), and Jarvis needs 2.1.302 or newer, so updating is part of setup. The pin is one exact tested version, not "or newer".
*From:* Codex H7.

### 57. Pin Claude Code 2.1.309, called by absolute path (new; stage 0)
- **The pin is 2.1.309:** `~/.local/share/claude/versions/2.1.309`. It includes a macOS fix (in 2.1.309) for sandboxed Bash running shell startup files *outside* the sandbox, so earlier versions don't qualify.
- **Absolute path, never `PATH`.** Whatever `claude` on `PATH` happens to be (a wrapper until Oct 23, decision 58), Jarvis never relies on it and never changes Fabricio's everyday install.
- **The desktop app is separate.** It bundles its own Claude Code (2.1.308 on Oct 23) and updates on its own, so it can't be pinned. Desktop is used only for interactive intake. Every task session runs the pinned CLI. `dontAsk` mode is CLI-only anyway.
- **Codex** is pinned the same way (decision 66).

Supersedes "Jarvis needs 2.1.302 or newer" in decision 46.
*From:* stage 0 checks, Oct 23 (`docs/stage0-findings.md` §1); Claude Code changelog 2.1.302–2.1.309.

### 58. Every child process gets a clean environment built from an allowlist (new; stage 0)
Two things on Fabricio's Mac showed why inherited environments can't be trusted:
- **A wrapper owns `claude` and `codex`.** `~/.local/bin/claude` and `codex` are "ai-harness" wrappers. They silently remove every `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CODEX_*`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` variable, so settings passed through the environment would vanish.
- **Shell variables reroute Claude Code.** `~/.zshrc` exported `CLAUDE_CODE_USE_OPENAI=1`, a third-party `OPENAI_BASE_URL` and key, and `CLAUDE_CONFIG_DIR`. A Claude Code started from an interactive terminal without the wrapper would have sent work to another provider, with another config folder.

So:
- The runner never inherits its environment. It builds each child's environment from an allowlist: `PATH` (fixed), `HOME`, `USER`, `LANG`, `TMPDIR` and `SHELL`, plus the variables Jarvis sets on purpose.
- `jarvis doctor` refuses an unattended run if any of these would reach the session: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (they would bill the API instead of the plan), `CLAUDE_CODE_USE_*`, `*_BASE_URL`, or `CLAUDE_CONFIG_DIR`.
- `doctor` reports any wrapper in front of a binary Jarvis uses, for information only.

At Fabricio's request on Oct 23, the audn tools were removed. The wrappers, the `.zshrc` block and the audn folders were moved into `~/audn-removed-2026-10-23/`, and his everyday `claude` now links to 2.1.309. The rule stays, because any future tool can do the same thing.

Tightens decision 3 ("explicit config").
*From:* stage 0 checks, Oct 23 (`docs/stage0-findings.md` §1, §5).

### 60. Fabricio's global Claude Code config never reaches a task session (new; stage 0)
`--settings` *adds* to the user config; it doesn't replace it. On this Mac the user config has hooks (PostToolUse, SessionStart, Stop), two plugins and about 100 skills. So every task session runs with:
- ~~`--setting-sources project`, which keeps out user hooks, plugins and skills.~~ Superseded by decision 68. It still loaded the *project's* settings and hooks. `--restricted` keeps out user, project and local settings,
- `--strict-mcp-config` with Jarvis's own MCP file,
- `autoMemoryEnabled: false` in the generated settings, because otherwise each session writes auto-memory under `~/.claude/projects/` (verified: `memory_paths` disappears from `init`). Memory comes only through decisions 27–28,
- `--no-session-persistence`, so task transcripts aren't added to the interactive history.

Each of these is a permanent requirement with a test (decision 59). Tightens decisions 3 and 27.
*From:* stage 0 probes, Oct 23.

### 63. A disk floor (new; stage 0)
The Mac had 29 GB free (94% used) on Oct 23. Worktrees, `node_modules`, Docker and the iOS simulator use space fast.
- **Under 20 GB free:** `jarvis doctor` refuses an unattended run.
- **Under 40 GB free:** concurrency drops to one writing task.
- The runner re-checks between tasks. Falling under the floor mid-run is handled like a budget cap: pause, don't kill (decision 14).

Tightens decision 46's concurrency rule.
*From:* stage 0 checks; Fabricio, Oct 23.

### 64. The Jarvis repo stays at `~/Desktop/jarvis` (new; stage 0)
iCloud's Desktop & Documents sync is off on this Mac (`FXICloudDriveDesktop = 0`), so architecture §10's move to `~/Developer/jarvis` isn't needed. `jarvis doctor` keeps checking: if sync is ever turned on, unattended runs stop until the repo moves.
*From:* stage 0 checks; Fabricio, Oct 23.

### 67. Worktrees live outside the runner-owned folder (new; stage 0)
Architecture §3.4 put task worktrees in `~/.jarvis/worktrees/`, while §3.5 and decision 59 deny all of `~/.jarvis` to sessions. A worktree there would be unreadable to the agent working in it. So:
- Task worktrees and eval workspaces live in `~/.jarvis-work/` (`worktrees/<project>/<task>/`, `evals/<task>/<run>/`). That folder is never denied.
- `~/.jarvis/` keeps only what agents must never touch: the ledger, evidence, protected checks, secrets, memory, eval results and `run/`.
- The broker socket stays at `~/.jarvis/run/broker.sock`. Verified live: a socket inside a `denyRead` folder is still reachable when it is listed in `allowUnixSockets`, and the live probe now uses exactly this layout.

Supersedes the worktree path in architecture §3.4 and §6.
*From:* stage 0, found while building the baseline runner; live probe, Oct 23.

### 68. Task sessions run `--restricted` with an explicit tool list (new; stage 0, after Codex review 1)
**Supersedes** the `--setting-sources project` requirement in decisions 59 and 60.

**The flaw.** Codex's first stage 0 review found it, and a live test confirmed it: `--setting-sources project` still loads the worktree's own `.claude/settings.json`. Hooks defined there run outside the sandbox with full access. An agent could write such a hook and escape on the next session.

**The requirement now.** Every task session runs with:
- `--restricted`. It ignores user, project and local settings files; only `--settings` and managed settings apply. It confines the file tools to the working directories and refuses `bypassPermissions`. It leaves writes to settings, git and tool-config files to a person, which under `dontAsk` means they're refused.
- `--tools Bash,Read,Edit,Write,Glob,Grep` (or a subset). `--restricted` removes Bash unless it's named, and no other tools are allowed.
- `--setting-sources` is refused outright, so there's only one mechanism.

**Verified live on 2.1.309:**
- A malicious project hook doesn't run.
- Jarvis's own plugin hooks (`--plugin-dir`, runner-owned) do run.
- Agent writes to `.git/hooks`, `.git/config` and `.claude/` are blocked.
- The live probe's negative control, started the old way, catches the hook.

**Network proof.** The probe's network check requires the sandbox's own denial record (`deny network-outbound <host>`) as well as curl's `000`. A host that merely failed (DNS, TLS, timeout) gives `000` without that record, and the check fails. A live negative control that allowlists the blocked host fails exactly this check (Codex review 2).

**Loopback is all-or-nothing.** Without `allowLocalBinding`, no local port is reachable from a session, even one on the allowlist. With it, every local port is. It stays off, because a session could otherwise reach any local service. Tests against local dev servers run in the runner's checks (architecture §3.4), not inside sessions. Stages 3–4 must design around this.

**Compound shell commands are refused.** Under `dontAsk`, Claude Code refuses some commands even when sandboxed. A `for` loop was refused in testing; plain commands and `sh script.sh` ran. Stage 3's build skill must account for this, and the runner logs `permission_denied` events, so the cost can be measured.

**What it costs.** Sessions can't `git commit`; the runner commits the candidate revision, as architecture §3.4 already says. The runner's own git never runs hooks or `fsmonitor` (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, no global or system config).
*From:* Codex stage 0 review 1, finding 1 (`docs/reviews/stage0-codex-1.md`); live tests, Oct 23; Fabricio, Oct 23.

### 69. Sessions can't read outside their worktree (new; stage 0, after Codex review 1)
Codex found that sandboxed sessions could read the rest of the disk, including the original FreeHire repo and its history (the golden tasks' answers) and sibling eval runs. Now:
- `permissions.blockReadsOutsideWorkingDirectories: true` blocks reads of `/Users` and similar for sandboxed shells. `--restricted` confines the file tools.
- Each run gets a **private, empty toolchain cache**, reopened for reading and writing (`allowRead`, `allowWrite`) and deleted after the run. Go, npm and pnpm are pointed at it through environment variables. Codex's second review showed that a shared cache lets one run leave notes for the next. A runner-managed, read-only package mirror can come later if download time matters.
- Writes to `.git/hooks`, `.git/config` and `.claude/` inside the worktree are denied as a second layer.
- Snapshots fail closed on credential-looking content anywhere in the tree, unless a person allowlists the file as a fixture (`allowSecretsIn`). They also remove symlinks pointing outside the snapshot, redact quoted multi-line values, and strip user:password from non-local credential URLs.
- Settings are valid only if they're *exactly* what the builder produces for the trusted context (worktree, Jarvis home, cache, socket, allowlist). A swapped protected path or a widened rule is refused before it reaches disk.

- Snapshots parse dotenv quoting, escapes and inline comments properly. An unterminated quote, an oversized file, or credential-looking content in any encoding (UTF-8, UTF-16, raw bytes) or any format (credential URLs included) refuses the snapshot unless a person allowlists the file (Codex review 2).

All of this is verified by the live probe. Tightens decisions 12, 13 and 15.
*From:* Codex stage 0 reviews 1 (findings 2, 5, 7) and 2 (findings 1–3); live tests, Oct 23.

### 70. No live web in evals until recorded research fixtures exist (new; stage 0, after Codex review 1)
Codex found that the baseline's web research allowed `WebFetch` to any URL. `WebFetch` runs outside the shell sandbox, so this was a way to leak data. Decision 15 already said evals use recorded research. So:
- Eval and task sessions get no web tools. `WebSearch` and `WebFetch` aren't in the tool list and are also denied.
- Recorded research fixtures arrive with the research skill in stage 2.
- Live web research belongs only to the quarantined researcher role (decision 2), which has no write tools.

Plain Claude Code made no web calls in task 01's first baseline, so the comparison is unaffected. Reaffirms decision 15.
*From:* Codex stage 0 review 1, finding 3; Fabricio, Oct 23.

### 71. Stage 0 checks that need later stages move to those stages (new; stage 0)
Codex noted that four items in architecture §9 or §8's stage 0 row can't be finished without things later stages build. Each moves to the stage that first needs it, and that stage's proof now includes it:

| Item | Moves to | Why |
|---|---|---|
| The desktop app loads the Jarvis plugin, settings and hooks the same way as the CLI (§9 item 4) | Stage 1 | The Jarvis plugin is built in stage 1 |
| Maestro flows on an Expo development build in the iOS simulator (§9 item 7) | Stage 4 | Task 9 is the first to need it; the dev build needs several GB of disk |
| Impeccable on a real Next.js app (§9 item 7) | Stage 4 | Task 11's app is the first real Next.js app. Stage 0 checked JSX source and rendered HTML |
| `jarvis setup` account creation (GitHub, Vercel, Neon, …) | Stage 5 | Preview deploys are the first use; setup's local parts (folders, ntfy topics, isolated Codex home) exist now |
| ntfy typed replies from the phone (the button half passed: every tap reached the reply topic) | Stage 2 | The iOS ntfy app can't publish. The Safari web app or an iOS Shortcut is the likely route, and intake (stage 2) is the first stage that needs remote answers. Fabricio, Oct 23: "debug the app later" |

**Stage 0's proof is now:**
- every remaining §9 item resolved,
- the Codex review findings fixed and re-reviewed,
- the ntfy button test done (typed replies moved to stage 2),
- baselines recorded for tasks 1, 2 and 11 (at least one run each to start stage 1; the second repeat may finish during stage 1).

Supersedes those parts of architecture §8 and §9.
*From:* Codex stage 0 review 1 ("remaining for stage 0"); Fabricio, Oct 23.

### 72. Stage 1 starts while stage 0's baselines and final review finish (new; Oct 23)
Fabricio, Oct 23: "continue with the main structured code to make the whole flow work." So stage 1 began while two things were still pending:
- Codex's fifth stage 0 review (reviews 1–4 found real issues, all fixed),
- the baselines, which need a passing review before they restart.

This relaxes the "previous stage's proof first" rule in architecture §10 for this one overlap only:
- Stage 1 can't be *declared* done until stage 0's proof has passed.
- Stage 1 gets its own Codex review.
- Every stage 0 fix also applies to stage 1 code.

*From:* Fabricio, Oct 23.

### 73. How stage 1's foundation works (new; stage 1)
- **Ledger** (`packages/cli/src/ledger/`):
  - Hash-chained JSONL. Every entry is fsynced before it's acknowledged; the head hash is kept beside the ledger and replaced atomically.
  - A torn final line, or a head one entry behind, is crash debris and gets repaired. Anything else that fails verification is tampering, and both appends and the broker refuse to act.
  - Writers are serialized by a pid lock file. A lock left by a dead writer is taken over only under a second exclusive lock, after re-reading the holder.
  - Fault tests: 12 SIGKILLs mid-run lose no acknowledged entry, and 4 concurrent writers produce one valid chain.
- **Protected checks** (`checks/store.ts`): `checks.lock` hashes every check file, and the ledger's `checks_approved` entry holds the lock's own hash. So editing a check, or a check and the lock together, is caught before any run.
- **Gates** (`checks/gate.ts`):
  - Each check runs on a fresh clone of the committed revision, with no hooks, no repo config and no worktree edits.
  - It runs inside **Anthropic's sandbox runtime** (`srt`, pinned 0.0.81): no runner folder, no home, no network, writes only inside the checkout. Agent-written tests never run with the runner's access.
  - The raw stdout and stderr are hashed into a `gate_result` entry, so evidence edited afterwards is detected.
  - Unlike Claude Code, `srt` refuses an invalid config loudly.
- **Broker** (`broker/`):
  - Exact-payload approvals or standing grants, all in the ledger. An "executing" intent is written before acting and a receipt after.
  - Succeeded and unknown are final: never re-executed, and unknown is never retried. A definite failure may be retried under the same approval. Interrupted executions are reconciled to unknown on restart.
  - Credentials come only from the owner-only secrets file (`chmod 600` is enforced).
  - Stage 1 adapters write to a local outbox; real adapters arrive in stage 5.
- **`jarvis act`** is the session-side client. Sessions get the Jarvis install folder as **read-only** (`readOnlyDirs`, write-denied at both layers), so they can run it.
- **Plugin** (`plugin/`): a PreToolUse tripwire covering force-push, pushes, production deploy flags, publishing, schema pushes, remote GitHub changes, mail tools, the Keychain and the runner folder, plus a SessionStart run header. These are tripwires, not walls (decision 12).
- **Live stage 1 safety test** (real 2.1.309, with the plugin):
  - `jarvis act email.send` reaches the broker and gets *pending*.
  - The secrets file is unreadable.
  - Gmail SMTP, SendGrid, Vercel and Stripe are blocked, each with a sandbox denial record.
  - The tripwire blocks `npm publish`.
  - After approval the exact message is delivered to the outbox once, and a retry is a *duplicate*.

*From:* stage 1 build, Oct 23.

### 74. Codex reviews gate each stage on critical and high findings only (new; Oct 23)
Each stage still ends with an independent Codex review, run strictly stage by stage. Fabricio, Oct 23: "keep the strict per-stage reviews."
- **Critical and high findings block the stage.** They're fixed, regression-tested, mutation-checked and re-reviewed.
- **Medium and low findings go to `docs/backlog.md`**, with the review that found them. They're fixed later and never silently dropped.

*Why:* stage 0 took five review rounds. The later rounds found progressively narrower cases, mostly in the snapshot credential scanner.
*From:* Fabricio, Oct 23.

### 75. The gate's verified clone is its only object check; no separate fsck (new; Oct 23)
The fix for Codex review 5 finding 3 had two layers: a `--no-local` clone with `transfer.fsckObjects`, then `git fsck --full --strict` on the result. The mutation check showed neither layer could be tested on its own, because each one catches a swapped object by itself. Tested directly: the verified clone refuses a loose blob swapped under its old name ("did not receive expected object"). An unverified local clone checks out the swapped contents, and only `fsck` finds them.
- **The gate keeps the verified clone and drops the `fsck`.** `index-pack --strict` already recomputes every received object's hash and runs the same fsck checks, and the clone checks connectivity. A layer no test can tell apart from its absence is not a safeguard we can keep honest.
- **The swapped-object test now guards the clone directly.** Remove `--no-local` or `transfer.fsckObjects` and the gate passes the tampered candidate, so the test fails.

*Why:* every safeguard needs a test that fails without it (AGENTS.md). The mutation check reported "gate clones without hash verification" and "gate skips fsck" as surviving.
*From:* stage 1 mutation check, Oct 23.

### 76. The runner drives protected checks; assertions never run beside candidate code (new; Oct 23, after Codex reviews 6 and 7)
Codex review 6 showed that a gate trusting exit 0 can be passed by candidate code that exits 0 while it's being imported. Review 7 showed that a protected driver running in the candidate's process can't be trusted to record what happened either: the candidate can write the "observation" itself. So the runner is the driver, and the only thing the candidate can contribute is its own behavior:
- **A check is a list of cases plus a verify phase.** Each case is a command the runner runs in the candidate sandbox, on the verified checkout. The runner records that process's own stdout, stderr and exit code (`signal` if it was killed) in the evidence folder, which no sandbox can write. Nothing the candidate writes to disk counts as an observation.
- **The candidate can't see the expectations.** Its sandbox can read the checkout and `checks/fixtures/` (inputs and drivers), not the rest of the checks folder, the verify folder or the recorded observations. Producing the expected output for inputs it didn't choose, against expectations it can't read, is what passing means.
- **`verify` holds the assertions** in its own sandbox: no candidate code, no checkout, only the checks and a copy of the recorded observations (size-capped).
- **It proves it ran to the end.** Its last line must be `JARVIS-CHECK-COMPLETE <nonce>`, with a nonce written after every case has ended, in a folder no case sandbox can read.
- **A pass needs all of it:** every case finished within its time limit, the observations fit the cap, and `verify` exited 0 with the completion line. Every observation and both verify logs are hashed into the evidence.
- **Writing checks this way:** acceptance checks drive the candidate as a black box: its CLI with fixture inputs, or a protected driver in `fixtures/` that starts the candidate with its stdio redirected away from the case's output and talks to it over HTTP or the CLI. In-process unit tests are the agent's own tests, not protected checks.
- **Known limit:** a daemon that escapes a case's process group keeps that case's sandbox. It can't read the expectations or the nonce, or write the evidence, so it can't forge a pass, but it lives until the runner's next cleanup (backlog #13).

*Why:* only the runner makes evidence (decision 49), and evidence the candidate can write isn't evidence.
*From:* Codex stage 0 review 6, high finding 3; review 7, high finding 1.

### 77. Stage reviews run as parallel Codex lanes on `gpt-6.1-sol` at high effort (new; Oct 24)
Reviews 8–15 each found one or two new credential forms the snapshot scanner missed, one round at a time (about 40 minutes a round). Fabricio, Oct 24: run the review work in parallel, on GPT-6.1-Sol at medium or high effort.
- **Evidence is captured once** per revision, as before. Then four `codex exec` runs, `-m gpt-6.1-sol` with `model_reasoning_effort="high"`, read the same read-only checkout at the same time, each with its own verdict:
  - **A, full review:** the standard prompt (prior findings, new problems, the stage proof).
  - **B, structured configuration:** every config format, nesting and parser feature that can carry a literal credential past the snapshot scan.
  - **C, encodings and other files:** encodings, binaries, base64 and other wrappers, source code, docs and fixtures.
  - **D, safety boundary:** broker, gate, ledger, check store, plugin, `jarvis act`, the sandbox settings.
- **Lanes B–D are told to report every finding they can establish,** not the first one, so one round of fixes covers what used to take several.
- **The stage passes only when every lane passes.** Decision 74's severity policy is unchanged.
- High effort, not medium: these are security reviews, and depth matters more than speed. Each lane uses about as much ChatGPT plan as one earlier review.

*From:* Fabricio, Oct 24.

### 78. One broker socket per project and run; sandboxes trust the bound address only (new; Oct 24, after Codex review 16)
Review 16 (lane D, finding 3) showed that a second `jarvis broker` replaced the first one's socket at the shared default path, so a task's requests reached the wrong project's ledger and grants. Fixing that hit runtime behavior the docs didn't anticipate:
- **Node 24 on macOS unlinks a server's bound pathname on close,** even after another server has replaced it. A shared path can't be owned safely.
- **The sandbox refuses a Unix socket reached through an alias.** A hard link or a symlink to the bound socket both fail with EPERM when only the alias is allowlisted.

So:
- **Each broker binds a unique private address** (`.b-<uuid>.sock`, shortened to fit the Unix path limit) beside its public alias, then publishes the alias with an atomic hard link. It refuses an occupied alias, and on close removes the alias only if its inode is still its own.
- **The default alias is per project and run:** `~/.jarvis/run/<first 24 hex of sha256([project, uuid])>.sock`. An explicit `--socket` overrides `JARVIS_BROKER_SOCKET`, which overrides the default. There is no global default path any more.
- **Task sessions use the bound address,** `startBrokerServer(...).socketPath`, both in `TaskSettingsInput.brokerSocket` (its one allowed Unix socket) and in the task's client. Host clients may use the alias. `writeTaskSettings` still refuses a socket outside `jarvisHome`. The live safety test checks that the socket folder is `0700` and outside work, cache and tmp, and that a task can't write to it.
- **`jarvis act` requires** `--socket` or `JARVIS_BROKER_SOCKET`. `jarvis doctor` takes `--socket`. The broker closes its sockets on SIGINT, SIGTERM and SIGHUP.
- **Upgrade note:** the ledger's reclaim markers changed format at the same time (finding 5, bounded names). Stop running brokers before switching versions; old and new reclaimers running at once aren't covered.

*From:* Codex review 16, lane D findings 3 and 5; Codex's implementation and live test, Oct 24.

### 79. The snapshot credential scanner is best-effort hygiene; the boundary is the sandbox, the network allowlist and the broker (new; Oct 24, after Codex review 16)
Reviews 8–16 each found credential forms the snapshot scanner missed. Review 16's dedicated lanes found 43 more high findings of distinct kinds (archives, compression, hex, base32, byte arrays in source, HCL and HOCON, cookies, serialized objects in strings, …). No pattern scanner can be shown complete for arbitrary repositories, so treating it as a stage-blocking security boundary meant reviews could never pass. Fabricio, Oct 24: make the scanner best-effort hygiene, keep it and its tests, move its findings to the backlog as medium, and rely on the sandbox, the network allowlist and the broker as the boundary, with compensating controls.

**What the scanner is now:**
- **Hygiene, still fail-closed for everything it recognizes.** It keeps every rule and test from reviews 1–15, keeps refusing what it detects, and keeps `allowSecretsIn` for reviewed fixtures.
- **Missed credential forms are medium findings** (backlog), fixed when cheap. The 44 open scanner findings from review 16 are backlog #21–64.

**What the boundary is** for eval snapshots and task sessions:
1. **Provenance:** snapshots come only from Fabricio's own repositories, named in jarvis-evals task files. Their contents are already visible to any Claude session he runs in them.
2. **The sandbox:** no reads outside the worktree and the toolchain cache, no secrets file, no project hooks, and each run's own temp folder (decisions 59, 60, 68, 69; review 16 D1 and D2).
3. **The network allowlist:** a credential is only useful against a host the session can reach. The eval allowlist is `registry.npmjs.org`, `proxy.golang.org`, `sum.golang.org`, Google Fonts and localhost.
4. **The broker:** every outside action (send, deploy, spend) goes through exact-payload approval (decisions 12, 13, 73).

**Compensating controls:**
- **Credentials for an allowlisted host that accepts authenticated writes stay fully covered, at full severity.** Today that host is `registry.npmjs.org`, through `npm publish` with a token. The scanner covers `.npmrc` and Yarn auth (`_auth`, `_authToken`, `npmAuthIdent`), npm access tokens (`npm_…`, added with this decision) and credential URLs. A miss in this class is still high.
- **Adding a write-capable host to any allowlist requires covering its credential forms first,** with tests and mutations. For evals this is enforced in code: `EVAL_ALLOWED_DOMAINS` in `eval/baseline.ts` is the whole list, and a task file naming any other host is refused before a session starts. Widening it is a code change, reviewed like one.
- **Backlog #8,** a read-only package mirror, is the way to remove even that npm write path.

**Reviews:** decision 77's lanes change to:
- **A, full review;**
- **B, credentials usable against the allowlist:** the npm and registry credential forms above, and whether any reachable host accepts a credential a snapshot could hold;
- **D, safety boundary.**

Lane C (encodings and other files) is dropped, since its findings are now medium by definition. The stage still passes only when every lane passes.

*From:* Fabricio, Oct 24; Codex review 16.

### 80. Stage 1's desktop check proves plugin compatibility, not the task-session envelope (new; Oct 24)
Decision 71 moved "the desktop app loads the Jarvis plugin, settings and hooks the same way as the CLI" into stage 1's proof. Decision 57 already says the desktop app bundles its own Claude Code (unpinnable), `dontAsk` is CLI-only, and the desktop app is used only for interactive intake: every task session runs the pinned CLI. So the desktop app can't carry the restricted task envelope, and claiming it does would be false. Codex found this while scoping the check kit.

The stage 1 desktop check is therefore:
- **The Jarvis plugin loads** in a desktop Code tab session, and **both hooks run there:** the tripwire blocks a known-forbidden call, and SessionStart runs.
- **Evidence comes from records Claude Code writes,** such as the session transcript's blocked tool result and hook records, never from the model's own text, which a session could forge.
- **The tripwire probe is a harmless Bash call whose text matches a tripwire rule:** `printf '%s\n' 'npm publish'`. A forbidden `Read` doesn't work as a probe, because Claude Code's built-in permission rules block it before any PreToolUse hook runs (Codex's protocol capture, Oct 24), so it can't show the tripwire ran. The command does nothing if run, and the tripwire blocks it from its text alone.
- **The same check runs through the pinned CLI** with the same plugin, and the two results are compared.
- **The safety envelope** (sandbox, allowlist, `--restricted`, `dontAsk`, the broker) **is proven only on the pinned CLI,** by the live probe and the live safety test, as today.

Fabricio runs the interactive half (opening the folder and typing one prompt), and the kit reads the evidence.

Narrows decision 71's stage 1 item to match decision 57.
*From:* Codex, Oct 24; decisions 57 and 71.

### 81. Stage 2 is built in parallel while stages 0 and 1 close (new; Oct 24)
Fabricio, Oct 24 (in the "Work status check" session, relayed to the integrator): "record decision 81, keep the current queue, then hand out the lanes and the ground rules. I approve the pre-decided thresholds and adding one Claude worker."

This extends decision 72's overlap by one stage:
- **Stage 2 is built on branches now. It can't be declared done** until the stage 0 and stage 1 proofs pass.
- **It gets its own Codex review**, with lanes A, B and D (decision 79).
- **Its final proof still needs Fabricio:** he rates task 1's questions and task 11's intake and mockups (architecture §8).
- **The current queue comes first:** review 17, the baselines and the stage 1 review for the integrator, and the desktop plugin check kit for Codex.

**Pre-decided thresholds (approved):**
- Medium and low findings go to the backlog without asking him (decision 74, unchanged).
- On product and design choices, the builder picks the recommended option and records it here, and he can veto later.
- He's asked only about spending, outside actions, credentials, destructive operations or skipping a stage gate.

**Lanes,** one owner per folder, all folders new:

| Lane | Owner |
|---|---|
| 1. Notifier, `packages/cli/src/notify/`: ntfy send and poll, Approve and Reject buttons, replies as ledger entries, the 15-minute intake-wait timer, the 4 KB limit (§3.7, decisions 10 and 50, backlog #1) | Codex |
| 2. Decision register and `jarvis why`, `packages/cli/src/decisions/` (decisions 11 and 48) | Codex |
| 3. Spec format checker, `packages/cli/src/spec/` (decision 9) | Codex |
| 4. The `research`, `intake` and `spec` skills, `skills/{research,intake,spec}/` and `templates/spec.md` (decisions 5–8, §3.1) | A second Claude worker |
| 5. The `design` skill, `skills/design/` and `templates/{PRODUCT,DESIGN}.md` (decisions 51–56) | The second Claude worker |
| 6. Triage (decision 37) and the `/jarvis` command, `packages/cli/src/triage/` and `plugin/commands/jarvis.md` | Codex, after lanes 1–3 |

**Ground rules:**
1. **Worktrees:** every writer has its own git worktree and branch from the latest main. Only the integrator writes main, by cherry-pick after reading.
2. **Shared files have one writer, the integrator:** `cli.ts`, `package.json`, `pnpm-lock.yaml`, `scripts/mutation-check.mjs`, this file, `docs/backlog.md`, `AGENTS.md`, `plugin/hooks*`, the plugin manifest and `harness/claude/` (apart from new files assigned by name). Lanes send snippets instead. A new command exports `register(program)` from its own module, and the integrator adds one line to `cli.ts`. Mutations arrive as definitions.
3. **Test slots:** while building, a lane runs only its own test files. The full suite, mutation checks and live tests run only in the integrator's quiet slot, because concurrent suites caused timing failures on Oct 24.
4. **No new npm dependencies** without the integrator, since the lockfile is shared.
5. **Each writer gets a queue of three or four tasks,** so nobody idles between heartbeats.
6. **The same completion bar for every lane:** tests that fail first, the lane's own tests plus typecheck, an independent review, mutation definitions, and one commit per unit.

*From:* Fabricio, Oct 24.

### 82. Stage 2's Codex lanes run as CLI workers the integrator launches (new; Oct 24)
Fabricio, Oct 24 (relayed by the "Work status check" session), on whether Codex is called through the CLI or needs his input: "Id prefer the first design", and after the design: "I like this why didn't you start it ?" He wants no manual input from him.

**How a lane worker runs:**
- **One clone per lane, not a git worktree:** `~/.jarvis-work/lanes/<lane>`, a `--no-hardlinks` clone of main with `origin` removed and hooks off. A linked worktree would need write access to main's `.git`, where a worker could plant hooks the integrator's git would then run.
- **The pinned Codex** (`pinnedCodexBin`, decision 66), launched as `codex exec -s workspace-write -C <clone> -m gpt-6.1-sol -c model_reasoning_effort="high" --json -o <run>/final.md -- "<brief>"`. Stdin is `/dev/null`. The environment is decision 66's: `env -i` plus `HOME` (the empty one), `USER`, `PATH` and `CODEX_HOME`. Not `--ephemeral`, so `codex exec resume <id>` can send follow-ups.
- **Checked on Oct 24 with a smoke worker:** writes outside the clone are denied, and so are writes to the clone's own `.git` (Codex protects it). Commands have no network ("Could not resolve host"). So workers can't commit, push or reach a host. They leave changes in the working tree, and the integrator reads the diff and commits it, crediting the worker.
- **Tooling:** dependencies are installed by the integrator before launch. Workers call `node_modules/.bin/vitest` and `node_modules/.bin/tsc` directly, because `pnpm` through corepack would try to download itself into the empty `HOME`.
- **Tests:** workers run only their own test files (decision 81, rule 3). While `~/.jarvis-work/quiet-slot` exists they run no tests at all, and wait. The integrator creates that file for its full suites, mutation runs and review evidence, and removes it afterwards. The Codex app chat and the Claude worker follow the same rule.
- **Independent review:** a worker can't run one, since it has no network. The integrator has each lane's diff reviewed by a fresh reviewer from the other model family (Opus) before integration, then runs the full suite and mutation check in its quiet slot.
- **One writer per lane:** lanes 1–3 move from the Codex app chat to CLI workers. The app chat keeps the desktop kit and lane 6.
- **Plan usage:** three workers at once use Fabricio's ChatGPT plan about three times as fast. He accepted that. A stage review takes priority: if the plan's limit nears, workers pause before review lanes do.

*From:* Fabricio, Oct 24; the integrator's smoke test.

### 83. Stage 2 interface contracts: the spec format, the intake hand-off and register writes (new; Oct 24)
Product choices made by the builders under decision 81's thresholds (recommended option taken; Fabricio can veto).

**The spec format** (`docs/spec/vN.md`, decision 9): a restricted grammar, so it can be checked without a YAML dependency.
- **Front matter, first lines exactly:** `---`, `spec: N`, `date: YYYY-MM-DD`, `status: draft|confirmed|unconfirmed`, `supersedes: none|N-1`, `---`. N matches the file name. v1 supersedes none, and each later version supersedes its immediate predecessor.
- **An optional `# Spec vN`**, then exactly these H2 sections, in this order: Goals, Non-goals, User stories, Acceptance criteria, Assumptions, Open questions.
- **Entries:**
  - stories `- **S1 (P1):** As …`, in priority order;
  - criteria `- **AC1 (S1):** WHEN … THE SYSTEM SHALL …`, at least one per story;
  - assumptions `- **A1 [fixed]:** …` or `[delegated]`.
  - Empty sections say `None.`.
- **The checker validates structure and references only.** A fresh-context reader still checks the content (decision 9).

**The intake hand-off** (the intake skill to the notifier, decision 10):
- The skill writes `.jarvis/intake/round-<n>.json`: the round, the spec path, a summary of at most 5 lines, at most 7 questions, and any mockup paths. Each question has an id, a topic (scope, security, privacy, legal, ux, technical or design), the question, why, a default with its reason, and alternatives.
- The skill then runs `jarvis intake send <file>`.
- Answers come back as ledger entries, which the skill reads with `jarvis intake answers <round>`. The 15-minute timeout and "unconfirmed" marking belong to the runner's timer, not the skill.

**Register writes** (decision 48): one writer for the register's format.
- Skills never edit `docs/decisions.md` directly. They call `jarvis decide --by user|default-accepted|default-unconfirmed|jarvis --class mechanical|taste|challenge --source <path> "<decision>"`, with `--supersedes <id> --reason "…"` to supersede.

*From:* Codex (spec grammar) and the second Claude worker (drafts and both interface proposals), Oct 24.

### 84. One integrator session drives all of v1; stages overlap; one review round per stage (new; Oct 24; supersedes the foreman draft and parts of 72, 81, 82)
Fabricio, Oct 24 (in the "finish Jarvis" session): the finish line is **full v1, stages 0–7**. "Build as many stages as possible, yet do as much testing as possible so everything connects smoothly … Finish stage 0 and 1, while building stage 2 or 3 … my main goal is to get Jarvis V1 working as fast as possible while maximizing my subscriptions." He chose "this session runs it" over building foreman, milestone check-ins only, and "I stop all of them" for the sessions that were running.

**Why:** 17 Codex review rounds on stage 0, each one finding new edge cases in the snapshot scanner, meant no product code landed. The agents were building tools to build Jarvis (review runner, review status, foreman) instead of Jarvis itself.

**What changes:**
- **One integrator, this session.** The earlier integrator and worker sessions were stopped. Foreman (`foreman` branch and its lane clones) is shelved, not merged. Nothing new gets built to manage the workers. They run with what already exists: Codex CLI workers (decision 82) and Claude subagents in their own worktrees.
- **Stages overlap.** Stages 0 and 1 close while 2 and 3 are built. Stage 4 starts once the runner loop passes its end-to-end test. A stage still counts as **done** only when its §8 proof passes, including Fabricio's ratings.
- **One Codex review round per stage** (lanes A, B, D, decision 79). **Blocking findings:** critical ones, and high ones with a concrete path to a credential leak or to an action outside the broker. Everything else goes to the backlog and is assigned to a lane. A fix gets its own tests and mutation entry, and doesn't trigger a new round. A second round runs only when blocking findings were fixed, and it covers only those findings.
- **"Connects smoothly" is tested, not argued.** One end-to-end integration test on the fake `claude` (`tests/integration/`) goes from an intake hand-off file through the runner, checks, ledger, notifier and report. Every stage extends it. It runs in the full suite.
- **Parallelism:** up to 4 Codex CLI workers, 2 Claude workers and the integrator's reviewers at once, on 16 GB. Full suites, mutation checks, live tests and review evidence still run only in the integrator's quiet slot (decision 81, rule 3).
- **Check-ins:** only at the hard stops (money, outside actions, credentials, destructive operations) and at stage proofs Fabricio rates. Everything else is decided under decision 81's thresholds and recorded here.

*From:* Fabricio, Oct 24.

### 85. `jarvis decide` keeps decision 83's spellings and enforces decision 48's firmness on write (new; Oct 24; extends 83)
The register lane's format (decision 11's columns) and decision 83's `jarvis decide` flags didn't match, and an Opus review found that nothing stopped Jarvis from superseding one of Fabricio's decisions. The integrator settled both (decision 81's thresholds, so Fabricio can veto):
- **The CLI keeps decision 83's spellings and maps them to the format:** `--by user` → `fabricio`, `default-accepted` → `accepted-default`, `default-unconfirmed` → a new maker `unconfirmed-default` (decision 10's timeout defaults; firmness confirm-once), `jarvis` → `jarvis`. `inferred` stays in the format but isn't a `--by` value. `--class mechanical|taste|challenge` maps to the capitalized classes.
- **Decision 11's other columns get flags:** `--why` is required. `--reversibility` is one of `easy|moderate|hard|irreversible|reversible` and defaults to `reversible`. `--alternatives` and `--depends-on` default to `-`.
- **Firmness is enforced on every write, not only advised:** superseding a `firm` entry needs `--by user`. Superseding a `confirm-once` or `challenge` entry needs `--by user` too. Jarvis revising its own call needs `--reason`.
- **`--source` is a repo-relative path** (no leading `/`, no `..`, optional `#anchor`) that must exist under the repo's real path. A symlinked `docs/` or `decisions.md` is refused. The lock records pid, host and time.

*From:* the integrator, Oct 24, after the Opus review of the register lane.

### 86. Intake rounds are plain text with a bounded wait; confirmation happens once (new; Oct 24; changes architecture §3.3 and §4)
Settled by the integrator after a Codex review of the stage 2 skills (decision 81's thresholds; Fabricio can veto).
- **Plain text, not the question tool.** The session can't tell whether you're at the computer, and a waiting question tool blocks the hand-off. The round is printed in the session and sent through the notifier at the same time.
- **Bounded waiting, no polling.** The session calls `jarvis intake answers <n> --wait 540` at most twice (each call stays under Claude Code's 10-minute Bash limit). The command blocks on the ledger and returns answered, open, or "defaults (unconfirmed)" after the deadline (decision 10, 15 minutes by default). Then the session continues either way.
- **One submission contract.** `jarvis intake answer <n> <file>` is a complete response: listed ids are overrides, and every unlisted question takes its default as accepted. It closes the round, so a later tap is "Not counted". Phone taps answer only "Use defaults" for the whole round. Free text from the phone is a steer note, never a partial answer. At the deadline, all unanswered questions become "unconfirmed" defaults.
- **Spec confirmation happens once, at the initial hand-off.** Later changes from steer notes or repairs produce new checked spec versions and targeted replanning (decision 40), never another confirmation round. A choice outside what was delegated goes to decision 40's blocked state.
- **`jarvis taste save <file>`** stores the taste profile in the runner-owned memory folder, which sessions can't write (decision 39).
- **Every `jarvis decide` call in a skill carries `--why`** (decision 85).

*From:* the integrator, Oct 24, after the Codex review of the intake, spec and design skills.

### 87. The steer inbox is runner-owned; candidates never carry `.jarvis/`; one run-state model (new; Oct 24; supersedes the inbox wording in 40 and §3.5, settles 3's repair budget)
An Opus review of the runner lanes found a task session could forge a steer note. With Bash it could empty `.gitignore`, write `.jarvis/inbox.md`, pass its gates and get merged into the main checkout. The runner would then record the text as a steer note with user authority. The same review found that the report and status had their own task model, which disagreed with the rebuilt run state. The integrator settled (decision 81's thresholds; Fabricio can veto):
- **The inbox lives in the runner-owned folder:** `~/.jarvis/projects/<id>/inbox/`, one file per note, written atomically by `jarvis steer`. Task sessions can't reach it (decision 69 and the deny rules). `.jarvis/inbox.md` in the repo is no longer read.
- **A candidate revision that adds or changes any path under `.jarvis/` is refused** before checks run. The runner reads the session's notes from the workspace before committing, and the candidate never contains them.
- **One run-state model:** runner core's `rebuildState`. Inbox, repair, report and status all read its `RunState`. Done means a `state_reached passed` with the task's required checks and reviews, each reviewer keyed by name. Evidence is re-verified with `verifyEvidence`.
- **Repairs are counted from the ledger:** attempts that ended `completed` with a failing gate or review. A crash or a usage wait never uses up a repair. Switching to an alternative is a ledger entry.
- **The repair budget is 2 repairs, so a task is blocked after 3 failed attempts** (architecture §3.4). This settles decision 3's "twice".
- **Repair prompts carry a bounded tail of each failing case's output and exit code,** not the gate's JSON. Blocked reasons are one short line.
- **Bad inbox items are skipped and reported, never thrown,** so one bad note can't wedge the loop. Replans match only explicit ids (T#, S#, AC#).

*From:* the integrator, Oct 24, after the Opus review of the runner-inbox lane.

### 88. The stage 3 loop: reviewer, tampered checks, candidate refs (new; Oct 24)
Open questions from the end-to-end harness, settled by the integrator (decision 81's thresholds; Fabricio can veto):
- **The reviewer in stage 3 is a fresh Claude review session** through the Harness. Its role is `review`, and routing picks the model (tier 2 means strong). It gets the diff, the spec's criteria for the task and the gate evidence, never the builder's notes (decision 49). It returns a JSON verdict that the runner records as a `review_result` keyed `reviewer: "code"`. Its tools are read-only (Read, Glob, Grep). The loop takes the reviewer as an injected function, so stage 4 can add Codex as the cross-model reviewer (§3.9) without changing the loop.
- **A `tampered` gate result blocks the task at once,** with no repair attempt. The reason is "protected check changed", the notifier is told, and other tasks continue (decision 15).
- **Candidates live under `refs/heads/jarvis/candidates/<task>/<attempt>`,** so the gate's `clone --no-local` copies them. The runner deletes those branches when the run ends. Found by the harness: under `refs/jarvis/…` every gate run ended in `error`.

*From:* the integrator, Oct 24, after the end-to-end harness.

### 89. Triage overrides need a colon; risk tier and pipeline type are separate (new; Oct 24; changes architecture §2)
Settled by the integrator after a Codex review of the triage lane (decision 81's thresholds; Fabricio can veto):
- **An override is explicit syntax:** the first word followed by a colon (`fix:`, `build:`, `feature:`, `ask:`), or `jarvis triage --override <word>`. A bare first word is prose: "Build fails on CI" and "Feature flags are broken" are bugs, not overrides.
- **The tier comes from risk** (decision 37: auth, money, data, several modules, acting on other people), not from the pipeline type. A bug or refactor can be tier 2. What stays fixed by type is which steps never run: a bug never gets intake, mockups or the design stage, whatever its tier.
- **Mixed requests keep both parts:** onboarding followed by requested edits (golden task 7) runs read-only archaeology first, then a refactor or feature pipeline for the edits. A review request is a review, even when it mentions shipping (golden task 3). A new platform or client gets the design stage even when the repo has a `DESIGN.md` for another platform (golden task 9).
- **Skills chain themselves once:** `/jarvis` starts the first skill of the pipeline, and each skill hands off to the next. The dispatcher never names a skill a previous skill already ran, so intake and confirmation happen once (decisions 8 and 86).

*From:* the integrator, Oct 24, after the Codex review of the triage lane.

### 90. Project ids come from the repo; intake polls the phone while it waits (new; Oct 24; changes §3.3)
An Opus review of the intake commands found that no component defined how a repo maps to its project id, and that nothing read the phone's replies while an intake round was open, so every tap during intake counted as late. The integrator settled (decision 81's thresholds; Fabricio can veto):
- **The project id is derived, not configured:** `<repo folder name>-<first 8 hex of sha256(realpath of the git top level)>`, lowercase, with anything outside `[a-z0-9-]` replaced by `-`. Every command uses it when neither `--project` nor `JARVIS_PROJECT` is given: intake, steer, status, run, decide's register lookup. One function in `packages/cli/src/config/project.ts` computes it.
- **`jarvis intake answers --wait` polls the reply topic itself.** It runs in the interactive session, which may use the runner-owned home (§3.3). It routes each round button through the round's handler, sends free text on as steer notes, and keeps its poll cursor in the project folder. Between waits ntfy keeps the messages, so the next poll picks them up.
- **Lateness is judged by ntfy's message time, not the time Jarvis polled it.** A tap made before the deadline counts even if it's read after it.
- **The phone message carries the questions:** after the summary, one line per question with its default, as far as the 4 KB limit allows, so "Use defaults" isn't a blind tap.
- **A failed notification never blocks** (decision 50): the round is recorded and the session is told to answer in the session.
- **`intake answer` on a closed round says "Not counted" and exits non-zero,** so the skill knows to record a supersession instead.
- **The taste profile fields** (decision 39): `admired` (3–5 names or links), `aiMade` (the look to avoid), `tone` (`serious|playful`), `dislikedColors`, `dislikedFonts`, `platforms`. Labels are at most 500 characters, and lists hold at most 20 entries. Schema errors name the field.

*From:* the integrator, Oct 24, after the Opus review of the intake commands.

### 91. Stage 3 integration details (new; Oct 24; the integrator under decision 81's thresholds; Fabricio can veto)
Settled while merging the runner inbox, planning and intake lanes:
- **Inbox limits:** a steer note is at most 16 KiB and an inbox file at most 128 KiB. A skipped item is recorded as a runner `reconciled` entry with `type: "inbox_skipped"` and archived. An explicit id that matches no task replans nothing; it never widens to all pending work.
- **Plans are judged against the runner's copy:** `readPlan` takes the approved spec and the installed checks from the runner. It never reads the spec or checks in the workspace, because the planner session can write them (planning review, medium 1).
- **Task definitions keep the planner's intent:** `goal`, `exitCondition` and an optional `mayTouch` (plain repo-relative paths, never `.git` or `.jarvis` in any letter case). Nothing enforces `mayTouch` yet; the loop passes it to the prompt.
- **Planning artifacts:** at most 256 KiB per file, 4 MiB per check bundle and 256 files. Each install reviews the complete merged bundle (backlog 65 adds the diff).
- **Intake taps:** the generic reply inbox refuses any `intake-*` button before writing an intent, and those taps go to the round's handler only. A tap whose ntfy time is before the deadline counts even when it is read later. If the deadline already produced unconfirmed defaults, the tap upgrades the round to accepted defaults, recorded with `supersedesAnswerSeq`. Register entries already written as `unconfirmed-default` stay as they are (the register is append-only); confirm-once reads the round's state and skips anything the tap confirmed.
- **A broken notifier config never blocks a round:** the round is recorded, the command prints that the notification wasn't delivered, and a warning names the config without its contents (decision 90).
- **Project ids use the filesystem's own spelling** (`realpathSync.native`), so a path typed in the wrong letter case gives the same id.

### 92. The mutation check has a fast mode for iterating and a confirm mode that is the gate (new; Oct 24; tightens the AGENTS.md rule)
Running every mutation on the full suite took about 6 hours at the old pace, so the check now has two modes:
- **Fast (the default):** each mutation runs first on the test files that can observe the mutated file (relative imports, file mentions and Vitest's module graph; a file with a computed `import(`/`require(` argument links to everything). A per-set control must collect exactly the full control's test ids. Survived, error, no related test or an unusable control falls back to the full suite. Subset catches are reported as "not confirmed" and the run exits 3, never 0. `JARVIS_MUTATION_JOBS=n` runs n clones at once, capped at cpus−1.
- **Confirm (`--confirm`, the gate):** every verdict comes from the full suite with the unchanged classifier, so it can't differ from the old script. Exit 0 means every mutation was caught and confirmed. `scripts/review-run.mjs` runs this mode, and the full-check-before-review rule means this mode.
- **Why not keep only fast mode:** a Codex review showed a subset catch can hide a full-suite error (a test file that loads the module through a computed path errors under the mutation; neither graph sees it).
- **Cost:** confirm mode takes about 29 s per mutation, set by the longest test files; splitting them is the lever.
*From:* Codex mutation-check review, round 1 (FAIL, critical) and round 2 (RESOLVED), Oct 24.

### 93. More Claude workers: up to 6 Claude and 5 Codex at once (new; Oct 24; Fabricio; changes decision 84's limits)
Fabricio asked for more parallelism, with more of it on Claude Code. Agents mostly wait on the network; local CPU goes to test runs, which stay limited to each worker's own files, with full suites and mutation runs going through the quiet slot. The real ceiling is the shared Claude usage window (this session and every Claude worker draw from it): if a worker reports a usage limit, the integrator drops back to 2 Claude workers until the window resets.

### 94. Each stage review confirms its own stage's mutations; the v1 close confirms all (new; Oct 24; the integrator; tightens 92's cost, not its rule)
A full confirm run is mutations × suite time: 575 × about 53 s, roughly 8.5 hours, and growing with every lane. So:
- **A stage review's evidence** runs `--confirm-stage <s>`: that stage's mutations (and any definition file not mapped to a stage) run on the full suite. Every other mutation still runs, in fast mode, and must be caught. A survivor or an error anywhere fails the run.
- **The stage of a mutation** comes from where it is defined: the inline list and the probe file are stages 0–1, lane files map by folder. One map, with a test that every definition file is mapped.
- **Stage 7's close** runs `--confirm` over everything, once, overnight.
*Why:* stage reviews judge that stage's code. Every safeguard is still exercised at every review; only the "confirmed on the full suite" step is scoped.

### 95. Sessions read no system temp folder; each session gets a short private temp folder (new; Oct 24; tightens 69)
The live probe found sandboxed shells could read files in `/private/tmp` outside their worktree. `blockReadsOutsideWorkingDirectories` covers `/Users` and similar, not the temp folders, so a session could read other processes' scratch files, including other Claude Code sessions' files in `/tmp/claude-<uid>`. Now:
- `sandbox.filesystem.denyRead` lists `/private/tmp`, `/tmp`, `/private/var/folders`, `/var/folders`, and the runner's own `$TMPDIR` (real path) when it lies outside those. The worktree is reopened with `allowRead` only when it lives under one of them; the toolchain cache stays reopened. The runner-owned folder may not sit inside the worktree or the cache, because `allowRead` outranks `denyRead`.
- Each session gets a short private temp folder, `mkdtemp /private/tmp/jt-XXXXXX` (0700), passed as `CLAUDE_CODE_TMPDIR`, reopened with `allowRead` and `allowWrite` for exactly that path, and removed after the session. Claude Code 2.1.309 gives sandboxed commands `TMPDIR=<CLAUDE_CODE_TMPDIR>/claude-<uid>` only when that path is at most 44 bytes (an AF_UNIX socket limit); otherwise it falls back to the shared `/tmp/claude-<uid>`, so a folder in the cache is too long. `TMPDIR` for Claude Code itself and its hooks is `<cache>/tmp`.
- The live probe runs from `~/.jarvis-work/probe-<nonce>`, where production worktrees live. It plants a file in `/private/tmp` and in the runner's `$TMPDIR` and requires both unreadable (`system_temp_not_readable`), judged from what the shell left in the worktree, not from its output. It also requires the sandboxed `TMPDIR` to be the session's own folder (`positive_session_tmpdir_usable`). A live negative control with the temp denials stripped fails exactly that check.
*From:* the live probe, Oct 24 (2 live runs on 2.1.309).

## 6. Models, effort and cost

### 24. A small routing table, not the model's choice
**Routing is set by the task's size (decision 37) and the step's role:**
- **Deciding and judging on big tasks (tier 2):** intake, spec, architecture, planning and the final review always use a strong model at high effort. Mistakes there compound through everything built afterward, and the reviewer is the last line before "done".
- **Everything else is routed by difficulty:** building, debugging, searching, and all of tier 0 and tier 1. Each starts on the cheapest model expected to manage it and moves up to a stronger model or higher effort on its first failure. That includes planning and review for small tasks.

Anything deterministic is done by scripts, not models: running tests, linting, building, formatting. On a subscription the cost signal is usage-window consumption, so the table gets tuned from measured use and your corrections. Cursor's router learns from whether the user had to correct the agent.

Effort levels map across harnesses:

| Harness | Effort levels |
|---|---|
| Claude | low to max |
| Codex | minimal to ultra |
| DeepSeek | low, high, max |

*Why:*
- Cursor's router uses a stronger model only when it's confidently better than a cheap one, which supports routing by difficulty.
- Cursor's swarms keep every design decision with frontier-model planners and give the cheap models to workers.
- Cursor's long-running agents post says "small wrong assumptions" early compound into a wrong solution.
- Cursor also found "lower-reasoning models were not always faster", so the table gets tuned by measurement.

Codex (Astra) proposed routing purely by difficulty. Jarvis adopts that for everything except tier-2 deciding and judging.
*From:* research/02 (#3, #7, #8), research/03, research/04; Fable F11; Codex M3.

### 61. The routing table names full model IDs, never aliases (new; stage 0)
Aliases change meaning with the Claude Code version: on 2.1.270, `haiku` resolved to Claude Haiku 4.5, and on 2.1.309 it resolves to Claude Haiku 5.5. So `routing.yaml` uses full IDs, verified on the pinned version:

| Tier | Model ID |
|---|---|
| strong | `claude-opus-5-5` |
| fast | `claude-sonnet-5-5` |
| cheap | `claude-haiku-5-5` |

`jarvis doctor` checks that each ID is accepted and that the `init` message reports the same ID back.

Supersedes the aliases in architecture §3.9.
*From:* stage 0 probe, Oct 23.

### 66. How the Codex reviewer runs (new; stage 0)
- **By absolute path:** `~/.npm-global/bin/codex`, pinned at codex-cli 0.164.0 (moved from 0.163.0 on Oct 23, Fabricio). Never through `PATH`, because a wrapper owns `codex` there (decision 58).
- **Isolated in two places:**
  - A Jarvis-owned `CODEX_HOME` (`~/.jarvis/codex-home`) that contains only a symlink to the login file `~/.codex/auth.json`, so the credential isn't copied.
  - An empty `HOME` (`~/.jarvis/codex-home/home`). Codex also reads the cross-tool skills folder `~/.agents/skills` (4,193 skills on this Mac, including gstack) from the real home, whatever `CODEX_HOME` says.
  - With both, none of Fabricio's skills, config, rules, memories or plugins load. A trivial call used about 15.8k input tokens, against about 25.5k with only `CODEX_HOME` isolated and about 53k with neither. `--ignore-user-config` and `--ignore-rules` alone still loaded the skills.
  - Stdin is `/dev/null`, because `codex exec` otherwise waits for more input.
  - The environment is `env -i` plus exactly four keys: `HOME` (the empty one), `USER`, `PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` and `CODEX_HOME` (decision 77's runner, `scripts/review-run.mjs`). macOS itself adds `__CF_USER_TEXT_ENCODING` (a text-encoding id such as `0x1F5:0x0:0x0`, not a secret) to the started process; `env -i` alone reproduces it. The runner's tests allow that one runtime-added key and nothing else (Codex, Oct 24).
- **Read-only:** `codex exec --sandbox read-only --ephemeral --json --output-schema <verdict schema> -o <file>`.
- **It reads evidence, not narrative:** the repo at the candidate revision, the docs, and the runner's evidence files. It never gets the builder's summary (decision 49).
- **Its verdict is kept:** each review is saved to `docs/reviews/` with the revision it reviewed.
- **Fallback:** on a usage-limit error (`You've hit your usage limit`, then `turn.failed` and exit 1) or a missing binary, the strong Claude reviewer takes over, and the report says so.

Tightens decisions 17 and 24.
*From:* stage 0 probes, Oct 23; Codex non-interactive docs and source.

### 25. Switch models only at subagent boundaries
Jarvis never changes the model or tool set mid-session, and the start of every prompt stays identical.
*Why:* prompt caches are per model. Cached tokens cost about 10% of normal on Anthropic and about 2–3% on DeepSeek.
*From:* research/01 (A1), research/04.

### 26. Measured per task
For every task, Jarvis logs:
- tokens (new, cached, output) and usage-window share,
- wall time,
- retries and gate failures,
- peak memory and disk use (browsers, builds and worktrees, not just Jarvis),
- whether the result was accepted, plus cost per accepted result,
- how much Jarvis-written code survives your edits over 7 days (Cursor's "keep rate").

*From:* research/02, Oct 22 brief; Codex M3.

## 7. Memory and self-improvement

### 27. Small memory: an index plus typed notes
`MEMORY.md` is an index capped at about 200 lines, with short notes of four types: `user` (your taste profile lives here), `feedback`, `project` and `reference`. It holds curated learnings only. It's plain markdown with no database or daemon, and every run's memory is scanned for planted instructions at startup.
*From:* research/01 (A1, A6e, A6g).

### 28. The second time a mistake happens, it becomes a rule
1. First correction: a `feedback` note.
2. Same mistake again: Jarvis proposes an AGENTS.md line, a lint rule or a skill edit, for you to approve in the morning report.

After each finished task, Jarvis keeps one learning, only if losing it would mean rediscovering it. A weekly pass prunes stale notes.
*From:* research/02, research/03, research/01 (A6g).

### 29. Every piece of scaffolding gets an expiry check
`docs/harness-assumptions.md` lists each piece of scaffolding and the weakness it covers. When a new model ships, Jarvis runs the golden tasks with and without each piece and deletes what no longer helps.
*From:* research/01 (A1, A3).

## 8. Skills, standards and borrowed pieces

### 30. About 14 small skills, built stage by stage
| Skill | Covers |
|---|---|
| research | product research, build-vs-buy spikes |
| intake | questions, assumptions, taste |
| spec | stories, acceptance criteria, versions |
| design | product, UX, mockups, tokens |
| architect | decision records |
| build | implementation |
| debug | reproduce, isolate, fix |
| review | independent code review |
| security | the security pass |
| qa | interaction, accessibility, performance, native |
| ship | git workflow, preview, release, production through the broker, changelog |
| onboard | mapping an existing repo |
| compound | learning from corrections |
| sweep | scheduled cleanup and docs |

Rules for every skill:
- Under 500 lines and 20KB.
- About 1.5k tokens of descriptions in total.
- Skills name actions, not specific tools.
- Each has a "gotchas" section and at least 3 evals.

Commands come before skills: one `jarvis` CLI with `--help` on every subcommand. superpowers' build, debugging, test-first and verification skills are used close to as-is (MIT, credited), with its brainstorming replaced by Jarvis's intake.
*Why:* a skill can hurt a weaker model (Hugging Face: success fell from 67% to 43%), and Cursor found skills only help "on the margins" when the underlying commands are error-prone.
*From:* research/01 (A6b), research/02 (#5, #8, #9), research/03; Fable §6.

### 45. Senior-engineer standards lanes (new; from the Oct 22 brief)
Each lane pairs a published standard with an automatic check. Lanes run only when a change touches their area.

| Lane | Standard | Automatic check |
|---|---|---|
| Architecture | Decision records for choices two parts could make differently; C4 diagrams; no layers "for the future" | dependency-cruiser (no cycles, no forbidden imports) |
| API design | OpenAPI contract written first; one error format (RFC 9457); pagination from day one (Google AIP-158); only additive changes | Spectral lint, oasdiff breaking-change check |
| Data | Migrations reversible and rehearsed on a copy; backups restorable | Migration up/down test; restore test (decision 44) |
| UX/UI | Nielsen's 10 heuristics; WCAG 2.2 AA; the AI-tells list and UX checklist (decisions 53, 55) | Impeccable detector, token lint, DESIGN.md lint, axe-core, Playwright and Maestro interaction tests (decision 54) |
| Security | OWASP Top 10:2025; the "lethal trifecta" for apps with AI agents | semgrep, gitleaks, osv-scanner |
| QA | Watch each new test fail first; prefer real code to mocks; flag deleted or disabled tests | Protected checks (decision 15); optional mutation testing |
| Performance | Measure before changing; Core Web Vitals (LCP ≤ 2.5 s, INP ≤ 200 ms) | Lighthouse CI budgets, bundle-size limits, k6 for APIs |

*Why:* this is where "knowing design patterns" becomes something enforced instead of hoped for. The model knows these standards; the lanes make sure they're applied and checked.
*From:* Oct 22 brief ("Specialist reviewers").

### 31. What we borrow
| From | What | License |
|---|---|---|
| superpowers | Fresh-implementer build loop with spec and quality review, systematic debugging, test-first, verify-before-done, skill size test | MIT |
| Matt Pocock's skills | Question format, spec template, session handoff | MIT |
| GSD Core | Assumptions mode, model-profile table, 2-attempt repair budget, pause before the context fills | MIT |
| Spec Kit | Clarify format, project "constitution", cross-document consistency check | MIT |
| gstack | Decision classes and audit trail; QA scoped to changed routes; security review structure | MIT |
| Addy Osmani's agent-skills | Security, accessibility, performance and observability checklists; definition of done; decision records | MIT |
| Compound Engineering | Durable-learning test, hands-off autonomy policy | MIT |
| Anthropic plugins | Review confidence scoring, silent-failure hunter, security patterns, skill evals | Apache-2.0 (keep license and attribution) |
| Ideas only | Ralph loop (no license), 12-factor agents (share-alike text), Depth Engine (UNLICENSED; `package.json` lists Endegena Assefa) | — |

*From:* research/03; `depth-engine-v3/package.json`.

### 32. Teach-me mode
`jarvis mode explain` adds short "why I did this" notes as Jarvis works. In away mode they go into a "What I decided and why" section of the morning report. The stricter Learning style, which stops and asks you to write key pieces, is used only when you're present.
*From:* research/01 (A6d).

## 9. Design and UX

The goal: UI that doesn't look AI-made, that you never have to describe color by color, and that people can use without reading much. Sources are in `docs/research/07-design-ux.md`.

### 51. Three design files per project (new)
| File | Holds | Who fills it |
|---|---|---|
| `PRODUCT.md` | Product facts that don't change with the visual style: who it's for, the main job, where it's used, the voice, constraints | Intake (decisions 5–9), seeded from your taste profile (decision 39) |
| `DESIGN.md` | The visual system in Google's open DESIGN.md format: color, type, spacing and corner tokens in YAML, plus a short rationale for each | The design stage, after you pick a direction |
| Theme code | The same tokens wired into Tailwind v4's `@theme`, starting with `--*: initial` so the default palette no longer exists. For mobile, NativeWind reads the same token file | Generated from `DESIGN.md`, never edited by hand |

In an existing repo, Jarvis first writes `DESIGN.md` from the code and design system that already exist, then follows it. Changes to an existing design system are Taste decisions (decision 11).
*From:* Impeccable (its PRODUCT.md/DESIGN.md split); Google Labs DESIGN.md spec; Tailwind v4 theme docs; Fable review (one token file for web and mobile).

### 52. Picking a direction without you specifying anything (new)
1. **Ground it in the subject.** Distinctive choices come from the product's world: its industry, materials, vocabulary and audience. A toy for kids and a finance dashboard should look nothing alike (Anthropic's frontend-design skill).
2. **Study 3–5 real products in the domain** (from decision 5's product research). Note which conventions to keep, because users expect familiar patterns (Jakob's law), and where there's room to stand out.
3. **Draft 3 genuinely different directions.** Each is a compact plan:
   - 4–6 named colors,
   - typefaces and their roles,
   - a layout concept with a rough wireframe,
   - 2–3 principles.

   They must differ in layout, flow and information hierarchy, not just color. Each sets three dials differently: layout variance, motion and density (taste-skill).
4. **Self-check against defaults before building.** If any part of a direction reads like what Jarvis would produce for any similar app, it gets revised, with a note on what changed (Anthropic's two-pass method). Each direction is also checked against the tells list (decision 53) and your taste profile.
5. **You pick from 3 throwaway mockups** of the main screens, using real wording, opened side by side (decision 39). Your pick becomes `DESIGN.md`. In away mode, the default direction is built first and the mockups wait in the report.

*Why:*
- Nielsen Norman Group found that broad prompts produce flat, interchangeable designs, while specific direction and visual references get much closer to what human designers make.
- University of Washington researchers recommend showing contrasting mood boards and anchoring to design tokens, to stop AI design from all converging on one look.
- OpenAI's frontend guide also says to generate several visual options before choosing.

*From:* research/07.

### 53. The "looks AI-made" list: banned unless the brief asks for it (new)
These tells show up consistently in Anthropic's and OpenAI's own design guidance, in the Impeccable design skill, and in designers' write-ups (2025–2026). No study has measured them yet, but every source agrees on them.

| Tell | What Jarvis does instead |
|---|---|
| Inter, Roboto, Arial or system fonts everywhere | 1–2 deliberately chosen typefaces with clear roles |
| Purple or indigo gradients, purple on white | One accent color tied to a function (primary action, warning) |
| The "SaaS card kit": identical rounded cards, one radius and one soft shadow on everything, cards inside cards | Hierarchy through size, spacing and grouping; cards only when they contain an action |
| Centered hero + three feature boxes with icons + CTA, whatever the product | Open with the most characteristic thing in the product's world |
| Emoji as icons; a rounded icon tile above every heading | A real icon set, used only where it adds meaning |
| Everything uniform, so nothing leads the eye | Intentional variation: primary things bigger, heavier, closer |
| Template chrome: ALL-CAPS eyebrow labels, "A · B · C" meta lines, "→" on every button, 01/02/03 numbering on things that aren't steps, one word in a headline set in a different color | Structure appears only when it carries information |
| Generic copy ("Scale without limits", "Welcome to your dashboard") | The product's own words; short utility copy inside apps |
| The same fade-up animation on every section; bouncy easing | One deliberate moment, plus motion that answers what the user did |
| Gray text on colored backgrounds; flat #000 or #111 | Contrast-checked, tinted neutrals |
| Glow or aurora backgrounds, neon palettes, status dots on everything | Decoration only with a purpose |
| Only the happy path designed | Empty, loading, error and offline states designed on purpose |

Anthropic's skill also warns about the newer "tasteful AI" defaults: cream background with a serif and a terracotta accent, near-black with one acid-green accent, and newspaper-style hairline layouts. They're fine when chosen on purpose, not as a fallback.
*From:* research/07 (Anthropic frontend-design skill; OpenAI, "Designing delightful frontends with GPT-5.4", Mar 2026; Anthropic harness-design post; Impeccable; Canatselis, Jul 2026; Fountain Institute; the history of Tailwind's indigo default).

### 54. Design checks that code runs, not opinions (new)
These run as part of the QA lane (decision 45) on every UI change:

| Check | Tool | Catches |
|---|---|---|
| AI-tells scan | `npx impeccable detect --json` (62 rules, no AI model involved; exit code 2 means findings; Apache-2.0) | Most of the table in decision 53, on web pages and local files |
| Off-palette values | Tailwind `@theme` reset, plus Biome's `noTailwindArbitraryValue` or eslint-plugin-tailwindcss `no-arbitrary-value`; for React Native, `no-color-literals` and `no-inline-styles` | Raw colors and one-off sizes that bypass the tokens |
| Token sanity | `npx @google/design.md lint` | Broken token references and failing contrast ratios |
| Accessibility | axe-core: zero serious issues; keyboard and focus checks | WCAG 2.2 AA problems |
| Behavior | Playwright (web) and Maestro (mobile) interaction tests | Flows that look right but don't work |
| Regressions | Playwright screenshot baselines on the same machine | Unintended visual changes |
| Copy | A small Jarvis script | Banned phrases, buttons that say "Submit" instead of the action, validation errors that apologize, more than one primary button on a screen |

*Why:* alignment, spacing and overlap are exactly what vision models judge worst (decision 56), so code checks them.
*From:* research/07.

### 55. Less friction, less reading: the UX checklist (new)
Each item becomes a check where it can (decision 54) or a reviewer question where it can't.
- **One primary action per screen.** A secondary action never looks like the primary one.
- **A first-value budget.** The spec sets the maximum taps or clicks from first launch to the core result (for example, a habit tracker: first habit added in 3 taps or fewer), and the interaction test fails if it's exceeded. Fewer taps only counts when the person still sees what they need to decide, such as the recipient and the exact message before approving an email.
- **No tours on launch.** Teach through empty states that say what goes here and offer the button to start. NN/g found launch tutorials are skipped and forgotten.
- **Progressive disclosure:** frequent things up front, rare ones one step away, never more than two levels deep (NN/g).
- **Forms:**
  - ask only what's needed, and ask it once (GOV.UK),
  - one question per step for multi-step flows,
  - mark optional fields "(optional)" instead of using asterisks,
  - validate when the person leaves a field, not while they type. In Luke Wroblewski's form study, inline validation raised success by 22% and cut completion time by 42%,
  - put errors next to the field, say exactly what's wrong and how to fix it, and keep what was typed.
- **Copy:**
  - short sentences with one idea each,
  - buttons say what happens, and the same word follows through the flow ("Publish" → "Published"),
  - if the interface needs explaining, redesign it (GOV.UK),
  - if cutting 30% of the copy makes it better, keep cutting (OpenAI).
- **Familiar patterns, distinctive look.** Be original in visual identity, not in where things are (Jakob's law).
- **Responsiveness:** show progress for anything slower than about 400 ms (the Doherty threshold).
- **Accessibility always:** WCAG 2.2 AA, a visible keyboard focus, and reduced-motion support. Vercel's web interface guidelines (MIT) are the detailed checklist for interactions, forms, layout and content.

*From:* research/07; Codex review M1.

### 56. Who judges design, and what AI can't be trusted to judge (new)
- **Code first.** The checks in decision 54 run before any model looks at the design.
- **A skeptical design reviewer:**
  - It runs in a fresh context, preferably a different model (Codex).
  - It uses the live app through Playwright, not static screenshots.
  - It grades against a written rubric adapted from Anthropic's harness experiment: design quality, originality, craft and functionality, with quality and originality weighted most.
  - It asks "does this follow our principles?" rather than "is this beautiful?", because Anthropic found the second can't be answered consistently.
  - It's calibrated with examples you've rated, and tuned to be skeptical: Anthropic found tuning a separate evaluator to be skeptical works far better than asking the builder to criticize itself.
- **What models can't be trusted with:**
  - *Picking the better of two designs.* On real A/B-tested interfaces, models scored near chance and favored whichever came first. So you pick the direction, and the reviewer finds and explains problems instead of picking winners.
  - *Fine alignment, spacing and overlap* are among their weakest judgments, so code checks those.
  - *Ease of use:* models tend to overrate it, so the friction checks (decision 55) stay mechanical.
- **Iterations are capped.** At most 3 design revision rounds per screen. Every round's screenshots are kept, and the report shows the best-rated round, not just the last; Anthropic saw quality plateau, and a middle iteration was sometimes better.
- **A negative control first.** Before the reviewer's verdicts count, it has to fail a deliberately generic UI (see `02-golden-tasks.md`).

*From:* research/07 (Anthropic harness-design post; WiserUI-Bench, arXiv 2505.05026; AesEval-Bench, arXiv 2603.01083; "VLMs are blind", arXiv 2407.06581; MLLM-as-UI-judge, arXiv 2510.08783).

### What we borrow for design
| From | What | License |
|---|---|---|
| Anthropic frontend-design skill | Subject grounding, two-pass plan → self-check, the "tasteful AI default" clusters, copy guidance | Apache-2.0 |
| Impeccable | The detector CLI as a gate; the PRODUCT.md/DESIGN.md split; ideas from its critique, harden and onboard commands. It already supports Claude Code, Codex and DSH | Apache-2.0 |
| Google DESIGN.md | The file format and its linter | Apache-2.0 |
| Vercel web interface guidelines | Interaction, form, layout, content and dark-mode rules | MIT |
| taste-skill | The variance, motion and density dials for making directions genuinely different | MIT |
| gstack design-shotgun | Several variants on a comparison board with structured feedback | MIT |
| OpenAI's GPT-5.4 frontend guide | Rules on hero content, cards only for actions, cutting copy, two typefaces, one accent | Ideas only (no license found in openai/skills) |
| Skip | v0 and Lovable design systems (tied to those products, React-only); Cursor Design Mode (an editor feature); ui-ux-pro-max as a source of styles (big style catalogs risk steering every app toward the same few looks) | — |

## 10. House stack

### 33. TypeScript everywhere, React for every UI, free tiers by default
| Category | Default | Deploy (free) |
|---|---|---|
| All JS/TS work | TypeScript (strict), Node 24 LTS, pnpm, Biome, Vitest, Playwright, Zod | — |
| Web app | Next.js 16, React, Tailwind v4, shadcn/ui (always re-themed, never its default look); Postgres on Neon via Drizzle; Better Auth | Vercel Hobby (personal) or Netlify Free (commercial) |
| API | Hono, Drizzle, Postgres | Cloudflare Workers Free |
| Mobile | Expo (React Native), Expo Router; Maestro for tests | Expo EAS free builds |
| Desktop (Mac + Windows) | Tauri 2 with React; SQLite | GitHub Releases |
| CLI | TypeScript with commander | npm |
| AI apps | Vercel AI SDK; Postgres + pgvector; local development on Ollama or free keys | as the web app |
| Second language | Python with uv, FastAPI, Ruff, pytest | Render Free |

*Why:*
- TypeScript became #1 on GitHub in Aug 2025.
- Agents passed 53% of Next.js tasks with no docs and 100% with Next's AGENTS.md docs index.
- Claude Code wrote its own auth 48% of the time when left alone.
- Tauri installers are 3–15 MB versus 50–150 MB for Electron, with free update signing. App-store and macOS notarization costs remain (decision 34).

**In an existing repo, the repo's stack and design system win.** The house stack is only for new projects. Your job automation (Go + SvelteKit) is the first test of this.
*From:* research/05.

### 34. Stack guardrails
- **Pin versions.** Several traps are live now: Prisma's CLI vs client versions, the Drizzle 1.0 release candidate, TypeScript 7, and Tailwind v4's new config.
- **Ask first** (through the broker) for:
  - commercial use on Vercel Hobby,
  - app-store accounts (Apple $99/year, Google $25 once),
  - code signing and macOS notarization,
  - custom domains,
  - metered LLM API calls.

  A native release that would need any of these is reported as "built, not distributed" until you approve.
- **Watch:** Next.js churn and security patches; TanStack Start (revisit mid-2027).

*From:* research/05; Codex M2.

## 11. What we leave out (or postpone)

| Skip or postpone | Why |
|---|---|
| "Act as a senior engineer" personas | No reliable gain in studies |
| One agent per role (PM, architect, …) | Loses detail at handoffs (decision 2) |
| Big swarms and 1,000-agent flows | Far more tokens; too heavy for a laptop |
| Multi-agent debate | Rarely beats repeated attempts at the same cost |
| Claude agent teams | Experimental, interactive-only, can't resume |
| Codex App Server, OpenAI Agents API or Claude Managed Agents as the core | Each ties Jarvis to one vendor; optional add-ons later |
| One long session looping all night | Context piles up; fresh session per task instead |
| GSD, superpowers or gstack as dependencies | Pieces are vendored instead (decisions 1, 30) |
| Vector database or semantic code search in v1 | Plain text search first; revisit later (Cursor reported +12.5% when combined) |
| AI judges scoring prose | Judge evidence instead (decision 16) |
| Learning-style pauses during away runs | They would block overnight work |
| Postponed to the Codex/DSH phase | `jarvis sync`, conformance suite, DSH hook bridge (decisions 20–23) |
| Postponed until v1 works | Full post-deploy monitoring and incident automation; parallel builders beyond 2–4 |

## 12. Building and testing Jarvis itself

### 35. Evals first, on sanitized snapshots
The 12 golden tasks are in `docs/02-golden-tasks.md`, mostly from your job automation, plus two brand-new products. Each task runs:
- in a sanitized snapshot: a fresh repo with no history, no remotes, no sibling folders and empty memory,
- with hidden checks kept outside the snapshot,
- with recorded research fixtures for reproducibility, plus a separate live-freshness check,
- at least twice.

The main measures are:
- your 1–5 rating ("would I use this?"),
- your veto count,
- the false-done rate (reported done but actually broken),
- blocked-but-correct stops,
- your actual corrections,
- usage per accepted result.

You also grade task 1's questions yourself, since the expected answer was written by an AI. The fault-injection tests (killing the runner, hitting usage limits, disabling hooks, hostile pages, tampered checks) must pass before overnight runs are trusted.
*From:* research/01 (A3); Fable F7, F8, §5; Codex H1, H6, §5.

### 47. Jarvis must beat plain Claude Code (new)
Every golden task also runs with plain Claude Code on the same budget, with no Jarvis. Optionally it also runs with Claude Code plus Compound Engineering, the strongest ready-made alternative. A Jarvis stage counts as done only when it beats the baseline on your rating and the false-done rate. If it doesn't, we change Jarvis, not the measurement.
*Why:* both reviewers' strongest alternative was "native harness plus one community pack". Your goal is faster development on your real projects, and this measures exactly that.
*From:* Fable §6; Codex §6, test gap 5.

### 36. Build order: the full system, in proven stages
| Stage | Builds | Must pass before moving on |
|---|---|---|
| 0. Setup | Update Claude Code to the pinned version; `jarvis setup` accounts; sanitized snapshots; baseline runs of plain Claude Code | Baselines recorded for tasks 1, 2 and 11 |
| 1. Foundation | Repo, AGENTS.md, `jarvis` CLI, ledger (decision 41), protected checks (15), safety layer and broker (12, 13), `jarvis doctor` (46) | Fault-injection safety tests: every send, deploy and spend attempt outside the broker fails |
| 2. Intake | Research, taste profile, story map, questions with mockups, versioned spec (decisions 5–10, 37–40) | You rate task 1's questions; task 11's intake and mockups |
| 3. Build loop | Runner with usage-cap sleep, steering, stuck handling; build and debug skills (superpowers-based) | Tasks 2, 4 and 5 beat baseline |
| 4. Verify | Review, security, QA (web and native), standards lanes (decisions 16–18, 45), design checks | Tasks 3 and 6, plus the design negative control |
| 5. Ship | Preview, release and deployed states, broker-gated production, smoke tests, rollback (decision 44) | Task 11 reaches preview-ready; task 12 is a built desktop app |
| 6. Memory and polish | Compound, sweeps, teach-me mode, routing tuning, cost and footprint logs (decisions 24–32) | Task 7, and task 10 overnight with a forced crash and a usage-cap pause |
| 7. Package | README, installer, license; a clean install on a second machine or fresh user account | A friend-style install works from the README alone |
| Later | Codex adapter, then DSH (decisions 20–23) | Conformance suite green on both |

Rule: add a rule or gate only after a mistake repeats (Lee Robinson; Mitchell Hashimoto works the same way).

The Jarvis repo stays private until stage 7, for three reasons:
- Before then, the safety layer isn't proven on other people's machines.
- The full git history must pass a secrets scan before it's published.
- A half-working public tool collects installs and bug reports before it works.

The golden tasks and their snapshots of your job automation live in a separate private repo permanently, because they contain your personal project.
*From:* research/03; Fable §4, §7; Codex §4, §7.

---

## Answered questions

- **Oct 23, first round:** defaults for all seven:
  - hard stops for money, messages, production deploys, deleting data or force-pushing, and paid services,
  - a 15-minute away timeout,
  - MIT license,
  - Depth Engine ideas only,
  - Claude Code first,
  - "Jarvis" as the repo name.

  The test project is the job automation.
- **Oct 23, after the reviews:**
  - v1 runs on Claude Code CLI plus the desktop app,
  - Max 20x plan,
  - production approved once per project,
  - build the full system, not a smaller version.
- **Oct 23, setup round:**
  - notifications must work on any harness and model, and be easy (decision 50),
  - MacBook Air with 16 GB, with Docker and Xcode installed,
  - keeps the Mac awake with `caffeinate`,
  - nothing goes to iCloud,
  - Jarvis stays private until stage 7,
  - Codex is the cross-model reviewer, with a Claude fallback,
  - overnight usage windows may be spent on test runs.
- **Oct 23, stage 0 round:**
  - pin Claude Code 2.1.309, called by absolute path (decision 57),
  - remove the audn tools: moved, not deleted, into `~/audn-removed-2026-10-23/`; everyday `claude` now runs 2.1.309 (decision 58),
  - full model IDs in the routing table (decision 61),
  - keep the repo at `~/Desktop/jarvis` (decision 64),
  - a 20 GB disk floor, and one writing task below 40 GB (decision 63),
  - ntfy: buttons plus the publish box, no typed replies (decision 50),
  - read-only Documents access for the FreeHire scan; install Maestro,
  - Codex reviews run on the Mac, read-only, without the gstack skills, with verdicts in `docs/reviews/` (decision 66),
  - `failIfUnavailable`, `--setting-sources project`, auto-memory off and the doctor canary probe are permanent, each with a test (decisions 59, 60),
  - Jarvis runs only Fabricio's own work on his own plan (decision 65).
- **Oct 23, after Codex's first stage 0 review:**
  - `--restricted` with an explicit tool list replaces `--setting-sources project` as a permanent requirement (decision 68),
  - stage-dependent checks move to the stages that need them (decision 71),
  - no live web in evals until fixtures exist (decision 70).

## Key sources

- **Anthropic:**
  - [3 harness patterns](https://claude.com/blog/harnessing-claudes-intelligence)
  - [Dynamic workflows](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
  - [When to fold subagents](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)
  - [Agent SDK](https://claude.com/resources/articles/building-agents-with-the-claude-agent-sdk)
  - [Long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  - [Containing Claude](https://www.anthropic.com/engineering/how-we-contain-claude)
  - [Evals for agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
  - Claude Code docs: [best practices](https://code.claude.com/docs/en/best-practices), [memory](https://code.claude.com/docs/en/memory), [sandboxing](https://code.claude.com/docs/en/sandboxing), [headless](https://code.claude.com/docs/en/headless)
  - [Why One AI Agent Isn't Enough (workshop)](https://www.youtube.com/watch?v=kiClTcJUnhc)
- **OpenAI:**
  - [Harness engineering](https://openai.com/index/harness-engineering/)
  - [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
  - [Agents API](https://openai.com/index/introducing-the-agents-api/)
  - Codex docs: [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [skills](https://learn.chatgpt.com/docs/build-skills), [hooks](https://learn.chatgpt.com/docs/hooks)
- **Cursor (SpaceX):**
  - [Agent harness](https://cursor.com/blog/continually-improving-agent-harness)
  - [Projects](https://cursor.com/blog/projects)
  - [Long-running agents](https://cursor.com/blog/long-running-agents)
  - [Scaling agents](https://cursor.com/blog/scaling-agents)
  - Posts on agent swarms, auto-review, reward hacking, security review and cloud environments are summarized in research/02.
- **Hugging Face:** [Is it agentic enough?](https://huggingface.co/blog/is-it-agentic-enough)
- **DSH and DeepSeek:**
  - [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  - [DeepSeek in Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)
  - [DeepSeek in Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
- **Standards and tools:**
  - [Agent Skills spec](https://agentskills.io/specification)
  - [AGENTS.md](https://agents.md)
  - [rulesync](https://github.com/dyoshikawa/rulesync)
  - [Git worktrees share repository data](https://git-scm.com/docs/git-worktree)
  - [Expo E2E on built apps](https://docs.expo.dev/eas/workflows/examples/e2e-tests/)
- **Community workflows:**
  - [GSD Core](https://github.com/open-gsd/gsd-core)
  - [superpowers](https://github.com/obra/superpowers)
  - [gstack](https://github.com/garrytan/gstack)
  - [mattpocock/skills](https://github.com/mattpocock/skills)
  - [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
  - [Spec Kit](https://github.com/github/spec-kit)
  - [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin)
- **Stack:**
  - [Stack Overflow 2026](https://survey.stackoverflow.co/2026/technology)
  - [Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)
  - [Vercel AGENTS.md eval](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
  - [Claude Code's default picks](https://amplifying.ai/research/claude-code-picks)
