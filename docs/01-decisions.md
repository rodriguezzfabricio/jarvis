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

### 161. A provider CLI never sees candidate files where it looks for configuration, and never sees more than one token (new; Oct 31; the Codex s5-adapters lane and its Opus cross-family review; answers the stage 5 pre-review's blocking high and its findings 7 and 8; extends 12 and 44; Fabricio can veto)
The pre-review found the Vercel adapter running the provider CLI in a copy of candidate files with `VERCEL_TOKEN`, and the CLI executes configuration (`vercel.ts` and its kin, build hooks) before it handles prebuilt output, with the inherited environment. Netlify's CLI has the same kind of entry points: `netlify.toml` plugins, `netlify/functions` and `netlify/edge-functions` (bundled at deploy, Go and Rust functions compiled, and edge functions likely loaded to read their config), and `.netlify/`.
- **The artifact is a static publish directory, and the runner builds the deploy tree.** `copyDeploymentArtifacts` copies only that directory, into `.vercel/output/static/` or `public/` of a fresh private folder. It writes everything at the tree's root itself: Vercel's `vercel.json` (no framework, build or install command), `.vercel/output/config.json` (`{"version":3}`) and `.vercel/project.json` (setup's site and organization); Netlify's `netlify.toml` (`publish = "public"`, no command, no plugins). So candidate bytes never sit where either CLI reads configuration. The CLI's process cwd is a separate empty folder.
- **The copy refuses anything either CLI could run, as a second wall.** Before any provider process or credential read, and naming the file: symlinks and special files, dot files other than `.well-known`, `vercel.*` and `now.*` configuration, `netlify.toml`, `netlify/`, `node_modules/`, any `package.json` or `*config.{js,ts,json,toml,yaml}`, Netlify's `_redirects` and `_headers` (configuration it reads from the publish folder), and files whose extension is outside a static list. Extensionless files (`/health`, `CNAME`) are static: the release-wiring e2e and ordinary smoke paths need them, and neither CLI reads them. Names are checked case-insensitively, at every depth, with the same stat the copy uses (the review moved the file rule after the no-follow open). Files lose their execute bits. The copy is hashed against the approved digest before the release marker is stamped. Functions, middleware, redirects and headers need their own reviewed contract. A refused path reaches receipts and notifications as printable ASCII of at most 200 characters.
- **Every provider process is pinned and private.** `ProviderConfig` gains a required exact `version` and an optional absolute `interpreter`. The pins are one table shared with the release wiring (decision 157): `PROVIDER_CLI_PINS` and `pinnedProviderBin` in `config/pins.ts`, empty until Fabricio installs one exact version (the lane recommends Vercel CLI 48.0.0 or Netlify CLI 23.0.0), never PATH. The npm CLIs start as `<pinnedProviderNode()> <bin> <args>`, the runner's own Node by absolute path, since their `#!/usr/bin/env node` finds no node under the adapters' PATH. The release step's own CLI check (`release/provider-cli.ts`, decision 157) starts it the same way through `providerLaunch` and hands the adapters the checked bin, version and interpreter; the tests' fake CLIs are npm-style `env node` launchers, so a check that started the bin directly would fail them. Before any credential read the adapter runs `--version` with no token and refuses anything but the pinned version (Vercel prints the bare version, Netlify `netlify-cli/x.y.z <os>-<arch> node-v<n>`; the lane matched `netlify/x.y.z`, which would have refused every Netlify call). Each process, the probe included, gets fresh HOME and cwd folders inside the project folder, removed afterwards, and exactly `PATH=/usr/bin:/bin`, `HOME`, `CI=1` and its own variables: `VERCEL_TOKEN` with the project and org IDs, or `NETLIFY_AUTH_TOKEN`. `jarvis doctor` checks `deploy.vercel` and `deploy.netlify` the same way: no pin, a missing CLI or a wrong version warns (fails when required) and says deploys stay refused.
- **Providers come from one registry.** The adapters, the version readers and doctor reach a provider only through `PROVIDERS` (`broker/adapters/providers.ts`); the deploy tree is a table in `release/artifacts.ts`. Both are typed `Record<Provider, …>`, so another provider (Render was mentioned) doesn't compile until it has a module and a tree; none is built here.
- **Rollback success is read back.** After the rollback command exits 0, the adapter reads production again (`vercel inspect`, Netlify `getSite`) and succeeds only on exactly the recorded deployment ID and URL. A mismatch, a malformed or failed readback, or any nonzero exit is `unknown`, never success and never retried.
- **Tests catch weakening.** Hostile configuration with a dummy canary token, for each provider, must be refused before any process or credential read; the tests assert `--prebuilt`, `--no-build`, the exact child environment, the fresh private folders and the readback. Stage 5 mutations in `release/mutations.json` drop `--prebuilt` or `--no-build`, accept a candidate config file or folder, drop the extension allowlist or the `_redirects`/`_headers` refusal, accept a relative interpreter, pass the full environment, skip the probe or the exact version, use public HOME or cwd roots, trust a rollback's exit 0, or keep the candidate's file modes.
- **Still unproven.** The versions were chosen offline; no flag, `--version` format or JSON shape has met a real install, and no SHA-256 is recorded yet (backlog 195, 196). A provider token in a child's environment may be readable by a concurrently running task session (backlog 197). The CLIs also look above the private roots (backlog 198). Setup's token names and the release grant UI (the pre-review's finding 3) belong to the release-wiring work.

*Why:* a deploy token is a production credential, and both CLIs are programs that run project code by design. Making the runner the only author of the tree's root is simpler to check than a list of everything a CLI might load, and the list stays as a second wall.
*From:* the Codex `gpt-6-astra` s5-adapters lane; the Opus integrator's cross-family review (the Netlify version format, the check-then-copy stat, the unsanitized refused path, the optional pin); reconciled with the release-wiring branch's pins table, Node launch and static build output (its backlog 186 and 187); backlog 195–199.

### 163. Render is the preview host, and a Render deploy is a git push of the verified tree to a per-tier deploy repo (new; Oct 31; Fabricio chose Render; the Codex render-adapter lane and its Opus cross-family review; adds a provider to 33's free tiers; extends 161 and 157; Render's deploy credentials are deploy keys, not 159's tokens; Fabricio can veto)
Decision 161 and the release wiring assumed a provider CLI that uploads a folder. Render has none: a static site deploys only from a Git repository, there is no upload API, and its pull-request previews are Git-backed too (community.render.com/t/static-site-without-using-a-repository/13506; render.com/docs/service-previews). So the docs and the provider disagreed, and the adapter is a git push instead.
- **Two deploy repositories, one per tier.** A GitHub deploy key can't be limited to a branch, so one repo would let the preview key push production. Preview pushes to a private preview repo with its own write deploy key, `RENDER_PREVIEW_DEPLOY_KEY`; promotion and rollback push to a separate private production repo with `RENDER_PRODUCTION_DEPLOY_KEY`. Both are broker-only, read by the action (`deploy.preview` the preview key, `deploy.promote` the production one), with no fallback. Each repo feeds one free Render static site with no build command and the repo root as its publish folder. `jarvis release configure --provider render` records both repos (one canonical lowercase `git@github.com:<owner>/<repo>.git` spelling, so an alias can't make them "different"), branches and `*.onrender.com` origins, and refuses one repo or one site for both tiers.
- **The push.** In a runner-only copy, the broker commits exactly decision 161's verified static tree plus a runner-written `/.jarvis-build.json` naming the manifest hash, on top of the branch's current head, and pushes it with the pinned Git (`RENDER_TOOL_PINS`: Xcode's Git, never the `/usr/bin/git` shim) and `/usr/bin/ssh`. Git runs with eval/git.ts's rules (no hooks, no fsmonitor, no global or system config, `protocol.file.allow=never`, `GIT_ALLOW_PROTOCOL=ssh`) and an exact environment holding no secret. SSH runs with `-F /dev/null`, the one key (`IdentitiesOnly`, no agent), `StrictHostKeyChecking=yes`, `ssh-ed25519` only, and a runner-written known_hosts holding GitHub's published Ed25519 key, pinned in code with its fingerprint `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` (docs.github.com's fingerprint page; checked with `ssh-keygen -lf` in the review). The key file is written 0600 into a fresh runner-only folder for that one push and removed afterwards, however it ends. Never a force push: a moved remote makes the push fail, and a rollback is a new commit whose tree is the earlier verified tree.
- **Readiness without a Render API key.** After the push, the broker polls `https://<site>.onrender.com/.jarvis-build.json`: HTTPS only, no redirects, 4 KiB and 10 s per request, at most 180 s in all (600 s cap). It succeeds only when the marker names the pushed manifest; a push that can't be confirmed is `unknown`, never success and never retried. The existing smoke test then checks the same marker. Before promoting, the production site must already serve an accepted manifest's marker, which becomes the rollback target; when it serves none, the promotion is `failed` with nothing pushed (the review moved this from `unknown`).
- **The registry.** `render` joins `Provider` and `PROVIDERS` with a native `deploy`, `verify` (the two tool version lines, before any key read), `validateSetup` and `tools`; doctor's `deploy.render` checks Git and SSH as the adapter runs them. Render's free plan is the only one accepted, as for the others.
- **Setup.** `jarvis setup` offers Render at `accounts.deploy`, generates both ed25519 key pairs with `/usr/bin/ssh-keygen` in an owner-only folder it removes, stores the private keys broker-only (base64 in the accounts file) and prints only the public keys and Fabricio's steps: create the two private repos, add each public key as a write deploy key to its own repo, create the two free static sites. It never calls GitHub or Render.
- **Still unproven.** No push has reached GitHub and no Render site has served the marker; whether Render serves a dot file at the site root is unchecked (backlog 205). A new production site can't be promoted to yet, because nothing it serves names a previous manifest (backlog 206). Rollback rebuilds the earlier tree from the runner's build area (backlog 207). The host key and tool versions are pinned in code (backlog 208).

*Why:* Render static sites are free and Git is the only way in. Keeping the pushed commit runner-built from the same verified tree keeps decision 161's guarantees; two repos keep 159's tier split where a deploy key can't.
*From:* Fabricio's choice of Render (Oct 31); the Codex `gpt-6-astra` render-adapter lane; the Opus integrator's cross-family review (the failed-not-unknown promotion, the typed tool pins, the setup and configure wiring); backlog 205–209.

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
- **Spec confirmation happens once, at the initial hand-off.** Later changes from steer notes or repairs produce new checked spec versions and targeted replanning (decision 40), never another confirmation round. A choice outside what was delegated goes to decision 40's blocked state. (Decision 155: at the initial hand-off a "changes" answer is now confirmed again with the revised artifacts; mid-run versions still never are.)
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

### 94. Each stage review confirms its own stage's mutations; the v1 close confirms all (new; Oct 24; the integrator; tightens 92's cost, not its rule; superseded in part by 129: a stage review no longer runs the other stages' mutations)
A full confirm run is mutations × suite time: 575 × about 53 s, roughly 8.5 hours, and growing with every lane. So:
- **A stage review's evidence** runs `--confirm-stage <s>`: that stage's mutations (and any definition file not mapped to a stage) run on the full suite. Every other mutation still runs, in fast mode, and must be caught. A survivor or an error anywhere fails the run.
- **The stage of a mutation** comes from where it is defined: the inline list and the probe file are stages 0–1, lane files map by folder. One map, with a test that every definition file is mapped.
- **Stage 7's close** runs `--confirm` over everything, once, overnight.
*Why:* stage reviews judge that stage's code. Every safeguard is still exercised at every review; only the "confirmed on the full suite" step is scoped.

### 95. Sessions read no system temp folder; each session gets a short private temp folder (new; Oct 24; tightens 69)
The live probe found sandboxed shells could read files in `/private/tmp` outside their worktree. `blockReadsOutsideWorkingDirectories` covers `/Users` and similar, not the temp folders, so a session could read other processes' scratch files, including other Claude Code sessions' files in `/tmp/claude-<uid>`. Now:
- `sandbox.filesystem.denyRead` lists `/private/tmp`, `/tmp`, `/private/var/tmp`, `/var/tmp`, `/private/var/folders`, `/var/folders`, and the runner's own `$TMPDIR` (real path) when it lies outside those. The worktree is reopened with `allowRead` only when it lives under one of them; the toolchain cache stays reopened. The runner-owned folder may not sit inside the worktree or the cache, because `allowRead` outranks `denyRead`.
- Each session gets a short private temp folder, `mkdtemp /private/tmp/jt-XXXXXX` (0700), passed as `CLAUDE_CODE_TMPDIR`, reopened with `allowRead` and `allowWrite` for exactly that path, and removed after the session. Claude Code 2.1.309 gives sandboxed commands `TMPDIR=<CLAUDE_CODE_TMPDIR>/claude-<uid>` only when that path is at most 44 bytes (an AF_UNIX socket limit); otherwise it falls back to the shared `/tmp/claude-<uid>`, so a folder in the cache is too long. `TMPDIR` for Claude Code itself and its hooks is `<cache>/tmp`.
- The live probe runs from `~/.jarvis-work/probe-<nonce>`, where production worktrees live. It plants a file in `/private/tmp` and in the runner's `$TMPDIR` and requires both unreadable (`system_temp_not_readable`), judged from what the shell left in the worktree, not from its output. It also requires the sandboxed `TMPDIR` to be the session's own folder (`positive_session_tmpdir_usable`). A live negative control with the temp denials stripped fails exactly that check.
*From:* the live probe, Oct 24 (2 live runs on 2.1.309).

### 96. The tripwire enforces only in Jarvis sessions; the runner home stays off limits everywhere (new; Oct 24; the integrator; Fabricio can veto)
The plugin installs at user scope, so its PreToolUse tripwire ran in every Claude Code session Fabricio opened, blocking `git push`, publishing and `--prod` deploys in unrelated projects. A session is now a Jarvis session when `JARVIS_SESSION=1` (the harness sets it for task, review and probe sessions), or when the hook's cwd, or a folder between it and its git toplevel (found by walking up for `.git`, as `config/project.ts` does, without running git), holds `.jarvis` or `.jarvis-routing.json`. Outside a git repo only the cwd counts, so the runner home's own `.jarvis/` doesn't mark every folder under it. It fails toward blocking: symlinked or unreadable markers, and an unreadable cwd, count as Jarvis. Outside Jarvis sessions the hard-stop rules don't apply, but file tools and Bash stay out of `~/.jarvis/` in every session, because it holds the ledger, evidence and secrets. The desktop check's workspace carries a `.jarvis/` folder, because a desktop chat has no env. In Jarvis sessions, file tools may write exactly the session-owned `.jarvis/` files the skills name (notes, scratch, intake rounds, mockups, the architect's plan and checks, onboard and sweep notes and plans); every other `.jarvis/` path stays refused. The tripwire is still a tripwire (decision 12, layer 3): the sandbox, the deny rules and the broker are the walls, and task sessions keep all of them. Limit: a git repo whose toplevel is the home folder (a dotfiles repo) makes every session under it Jarvis, because `~/.jarvis/` sits there; that fails toward blocking.

### 97. How the Jarvis arm of an eval is run and scored (new; Oct 24; the integrator under decision 81's thresholds; Fabricio can veto; tightens 35, 47)
- **Beats the baseline**, for a stage proof:
  - Each arm has at least 2 counted runs, and every counted run is graded and rated.
  - Jarvis's mean rating is strictly higher than the baseline's.
  - Jarvis's false-done rate is no higher, and its hidden-check pass rate is no lower.
  - A run is counted when it started a session and wasn't usage-limited. Claimed done means exit 0 with a success result for the baseline, and loop status `complete` for Jarvis. False done means claimed done while the hidden checks fail. `jarvis eval compare` prints the verdict and labels it with this rule.
- **The loop gates on the project's own suite; the hidden checks only grade.** `hidden/<id>/gate/` holds the checks the loop may run, and `hidden/<id>/checks/` grades both arms' final revisions. If the loop gated on the grader, Jarvis would get repair feedback the baseline never gets.
- **Budget:** the baseline gets one session within the task's turns and minutes. Jarvis gets those limits per session. Wall time and usage waits are reported side by side; a total loop deadline can come later.
- **Offline checks:** the gate sandbox has no network and no sockets. A Go task's check judges `go test -json` results for the named tests against a vendored or read-only module cache. A Docker/compose task's check is static: it parses the files and diffs against the snapshot's root commit.
- **Evals use the Claude reviewer only, for now.** Codex's `--sandbox read-only` doesn't confine reads, so a Codex reviewer could read the private evals repo or the installed grading checks (eval-arm Codex review, high 2). The Claude reviewer runs under the task-session sandbox with reads blocked outside its checkout. Codex can return to evals once its reads are confined to the review checkout.

### 98. `jarvis gate` is feedback on the caller's own working tree; its copy trusts the caller's own reads (new; Oct 24; the integrator; Fabricio can veto)
`jarvis gate <name>` runs the installed check of that name (`test` falls back to `unit`, `done` runs all) on a copy of the working tree, records nothing, and shows only case output, never verify output (decisions 49, 76). The copy is staged through a private git index and object store, validated after `write-tree` and materialized with `checkout-index`, so a symlink swapped in after staging can't pull outside files in. A race during `git add` itself (git checks metadata, then opens the path) remains, and is accepted: `jarvis gate` runs only from the terminal or the interactive session, which can already read those files, and task sessions can't reach it (their sandbox can't read the runner folder, decision 69). A task-session `jarvis gate` needs a runner-side feedback service over a session-scoped socket, like the broker; until then it isn't offered there. A gate with no installed check exits non-zero, and a Stop hook treats that as "not run".

### 99. Task allowlists never include local services; the public Go proxy is an accepted residual risk (new; Oct 24; the integrator after Codex review 18B; Fabricio can veto; tightens 68, 79)
- **No local services.** Turning off local binding doesn't stop a proxied request from reaching a service already listening on this Mac, which is a path to an action outside the broker (review 18B, high). Task allowlists, in task.json and in written settings, refuse wildcards, `localhost`, loopback addresses in any spelling and local `host:port` entries. A task that needs a local service waits until the runner can start, own and stop that named service inside the run; a declaration alone proves nothing.
- **The Go proxy stays for now.** `proxy.golang.org` and `sum.golang.org` remain allowed until a runner-owned, read-only module mirror exists. Task 02's pinned revision has 481 `go.sum` entries and no vendor folder, and each run starts with an empty module cache (decision 69), so `GOPROXY=off` would break the build. Module discovery can forward task-chosen data to an unlisted origin. Sessions can't read runner credentials, so the exposure is what the snapshot holds (Fabricio's own code). Because the snapshot scanner is best-effort (decision 79), a missed credential already in a snapshot could also leave. The proxy is not an exfiltration barrier, and a mirror replaces it when one is built.

### 100. The stage 3 loop promotes only revisions it gated and reviewed (new; Oct 24; the integrator under decision 81's thresholds; Fabricio can veto; settles the Opus review of loop.ts)
The Opus review of the runner loop found that two tasks started from the same head could both pass, and the second was then promoted with `git merge --ff` as a merge commit no gate or reviewer had seen: the run reported complete over code that failed its own checks. Settled:
- **Promotion is a fast-forward only,** to a revision whose every required check passed and every named review passed at exactly that revision. Every revision the run branch moves to, and last-green, is gated and reviewed as itself; the end-to-end test asserts it.
- **A candidate built on a head the branch has moved past is merged by the runner** (`git merge-tree`, no working tree touched) onto the new head, on the same candidate ref, and gated and reviewed again. If that merge fails a check, it is a failed attempt (charged) and the repair starts from the new head. This costs one gate and review run instead of a whole builder session, so parallel tasks that touch different files cost little.
- **A merge conflict is a stale base, not a failure:** the attempt ends uncharged, a `stale_base` record says why, and the task is redone from the new head with a line in its prompt saying so.
- **A task is passed only once it is promoted:** `state_reached passed` is written after the fast-forward, so dependents never start on a task that isn't on the run branch. A promotion that git refuses blocks the task and never crashes the run or its restart.
- **Reviews from the review service are recorded by the service.** The loop reads the verdict back from the ledger for that reviewer and revision. `investigate` blocks the task for a person; `error` is retried once and then blocks; neither is ever a builder repair.
- **A session's payload never runs before the runner has recorded its process group** (Codex review 19 found a parent-side SIGSTOP raced it). The group's leader is a hold, `/bin/sh -c 'read _ <&3 || exit 125; exec 3<&-; exec /usr/bin/env -u PWD -u SHLVL -u OLDPWD -u _ "$@"'` by absolute path, with the session's own environment and argv passed through unchanged; it execs the payload (same PID, so the identity holds) only after the runner writes a line to fd 3. A refusal closes the pipe and kills the group, and if the runner dies the hold reads EOF and exits. A group counts as exited only once it is empty, and SIGKILL stays armed until then.
- **A lease holder is identified by PID and start time,** so a reused PID can't hold a dead run's lease.
- **The main checkout's `.git/info/exclude` gets `/.jarvis/`,** so `REPORT.md` never makes the next promotion refuse a dirty tree.
- **Session plans** (`.jarvis/onboard/plan.json`, `.jarvis/sweep/plan.json`) are read only with `jarvis run --plan onboard|sweep`. Their tasks carry no criteria or stories, and every check they name must be installed.
- **Budget reservation (decision 14) is not implemented:** decision 14 names no amount to reserve, and on a subscription the budget is the usage window (decision 42), which the loop already waits out. A concrete rule needs a new decision.

*From:* the Opus review of loop.ts and the integration of lane 11, Oct 24.

### 101. In golden task 02, the baseline gets the same approved spec as Jarvis (new; Oct 24; the integrator under decision 81's thresholds; Fabricio can veto; tightens 47, 97)
Task 02's hidden checks drive a command-line contract that the approved spec defines (built from task 01's defaults). A baseline that only sees the original request can't know that contract, so it would fail the black-box checks by construction, and a claimed done would count as a false done. That would measure what the baseline was told, not how well it builds. So the baseline's prompt for task 02 includes the same approved spec text, pasted after the request. Jarvis's edge then has to come from the build loop: checks, review, repair. The two baseline runs of task 02 recorded before this decision are kept as history but aren't counted for the stage 3 proof; two new runs replace them.

### 102. A built desktop app runs only in a sandbox; until a sandboxed launcher exists, native smoke is "not run" (new; Oct 25; the Opus review of QA follow-up 1; Fabricio can veto; tightens 18, 76)
QA follow-up 1 (Codex) builds the Tauri app as a protected gate case, then had the runner launch the copied `.app` with a plain spawn: no sandbox, the runner's own user, full disk and network. The app is candidate code, so that was a path to the runner's secrets and to actions outside the broker. Codex also proposed an `afterCases` callback in `runGate` to hand the built bundle to the runner before checkout cleanup. Settled:
- **The native probe has no default launcher.** `probeDesktop` refuses to start without an injected launcher, and `runDesktop` reports **not run: desktop (no sandboxed native launcher)** unless one is given. The unsandboxed launcher was removed.
- **The `afterCases` hook isn't added to `runGate` yet.** It's only useful once a sandboxed launcher exists, and `checks/gate.ts` is a stage 0–1 safety file. Until then a missing handoff is also **not run**, never a pass.
- **The build check needs the bundle:** an exit 0 that leaves no real `.app` directory (with `Contents/Info.plist` and `Contents/MacOS`, no links) at the plan's path is a failed build.
- **What the launcher must do** (backlog): start the app under the sandbox runtime with the runner home, the system temp folders and the network denied, keep the app's own PID visible to the fixed osascript probes, and prove with a canary that a launched app can't read a denied file.

So golden task 12 reports a built, verified bundle with native smoke **not run**, as decision 18 already requires when a native test isn't possible.
*From:* the Opus review of QA follow-up 1 (lane `qa-2`), Oct 25.

### 128. A candidate's bundle is copied from verified descriptors, at most 2 GiB and 200,000 entries (new; Oct 26; the qa-backlog lane and its Opus review, backlog 89; tightens 76 and 102; Fabricio can veto)
- **Each file is copied from the descriptor that was checked.** `materializeTree` opens a source with `O_NOFOLLOW` and requires the descriptor to be the regular file it stat'ed (device and inode). On macOS a second open with `O_NOFOLLOW_ANY` (the two flags can't be combined) must reach the same file, so a parent directory swapped for a link, even one that swaps back, is refused; on Linux `/proc/self/fd` must resolve inside the tree. Other platforms are refused. Bytes and the hash come from that descriptor, and a size, mtime or ctime change during the copy is an error.
- **A copy has caps.** 2 GiB and 200,000 entries by default (directories and expanded internal links count; the destination root doesn't), and exceeding either is an error that removes the partial copy. The Chrome for Testing bundle (356 MB, 641 entries) copies to 852 files and 1.1 GB once its framework links are expanded (measured Oct 26 with this copier, 48 s under load).
- **The desktop capture passes its approved checkout** (`sourceRoot`), so the copier re-checks containment itself rather than trusting the capture's earlier check.
- **The copier stays in `lanes/materialize.ts`.** The design checks copy that file and `chromium-install.ts` into their protected fixtures by name, so a new module behind it would break the installed copy.

*From:* the Codex qa-backlog lane (gpt-6.1-sol) and the Opus review, which kept the copier in place, added the capture test, and ran the worker test under the real sandbox runtime.

### 103. The security pass's scanners run pinned and offline, with an explicitly fetched, hashed OSV snapshot (new; Oct 25; the integrator after the Opus review of the security-pins lane; Fabricio can veto; tightens 17)
- **Pins.** Semgrep 1.182.0, OSV-Scanner 2.7.0 and gitleaks 8.28.0, by absolute path (`pinnedSecurityScanners` in `config/pins.ts`), each version-checked before every scan. OSV prints its own version and OSV-Scalibr's; only the labelled scanner line counts.
- **Semgrep gets exactly `SSL_CERT_FILE=/etc/ssl/cert.pem`.** In a clean environment 1.182.0 won't start without it (`ca-certs: empty trust anchors`). Only that fixed path is accepted; inherited certificate or proxy variables never are.
- **OSV runs its local matcher explicitly** (`--x-plugins=vulnmatch/osvlocal`) with `--offline` and `--offline-vulnerabilities`. The two offline flags alone returned an empty success with no database.
- **The OSV database is a hashed snapshot fetched outside any gate.** `node scripts/osv-db-fetch.mjs <project> <new-folder>` lets the pinned binary download npm, Go and PyPI databases (chosen from the project's files, which it never runs), writes `manifest.json` with every file's SHA-256 and the fetch time, and refuses an existing folder. Installing the checks copies the snapshot into the protected fixtures, where the store approval hashes it. Every scan re-hashes it and requires it to cover the ecosystems found in the candidate. Missing, partial or tampered gives `not run: osv database missing`, which is never a pass and can't be exempted. An ecosystem without a local database (Cargo, or a lockfile under `vendor/`) makes OSV exit 127, which is an error (verified live). An update is a new snapshot and a new reviewed install.
- ~~**The fetch time is recorded, but no maximum age is enforced yet.** A stale snapshot misses newer advisories; the age is visible in the manifest until a threshold is chosen.~~ Superseded by decision 127: a snapshot older than 14 days is an error.
- **Semgrep uses a small original ruleset** (`security/rules/`: six sink categories each for JS/TS, Python and Go), copied into the fixtures. It is a conservative sink screen, not dataflow coverage, and no community ruleset is copied. Registry or `auto` configs are refused.
- **Candidate files can't switch scanners off.** Semgrep runs with `--disable-nosem`, `--no-git-ignore`, `--x-ignore-semgrepignore-files` and `--max-target-bytes=0` (by default it skips files over 1 MB without reporting them; backlog 92); gitleaks with `--ignore-gitleaks-allow` and full redaction. A root `.gitleaksignore`, `.gitleaks.toml`, `.semgrepignore` or `osv-scanner.toml` makes the scan an error. OSV runs with `--config=/dev/null`, because it loads an `osv-scanner.toml` next to every lockfile at any depth. The Opus review found a candidate `.gitleaks.toml` and a nested `osv-scanner.toml` each gave a clean pass with a planted finding present, and fixed both.

*From:* the security-pins lane (Codex) and its Opus review, Oct 24–25. Still open: the integrator's real fetch, and both live scanner tests rerun inside the real gate sandbox with a network control.

### 110. The Codex reviewer runs inside a Seatbelt profile that confines its reads; Codex's own sandbox is off inside it (new; Oct 25; backlog 77, eval-arm Codex review H2; Fabricio can veto; supersedes the `--sandbox read-only` part of the Codex reviewer and of `scripts/review-run.mjs`)
`--sandbox read-only` stops writes, not reads, so candidate content could steer the reviewer into `~/.jarvis/` (secrets, ledger, hidden checks), the private evals repo or other repos. Now the whole Codex process tree (Codex, its node launcher and every command it runs) starts under `/usr/bin/sandbox-exec -f <profile>` (`review/confine.ts`), for the loop's reviewer and for every lane of `scripts/review-run.mjs`:
- **Reads:** closed by default. Open: the system and toolchain (`/System`, `/usr/lib`, `/usr/share`, `/usr/bin`, `/usr/sbin`, `/usr/libexec`, `/bin`, `/sbin`, `/private/etc`, `/private/var/db/{timezone,dyld,mds}`, `/private/var/select`, `/Library/Apple`, `/Library/Preferences/Logging`, the Command Line Tools), only the Homebrew kegs the Codex launcher loads (see below), the Codex npm package, the review checkout, the inputs Jarvis names (the schema), the reviewer's own output folder, and a private per-review `CODEX_HOME` in a temp folder that holds only a link to the auth file. The auth file is opened by its real path, read and write (Codex refreshes tokens in place); nothing else of `~/.jarvis/codex-home` (history, logs, config) or `~/.codex` is. Metadata (stat, readlink) is open everywhere so paths resolve; contents and listings aren't. A folder that holds `~/.jarvis` is never opened.
- **Homebrew: kegs, never the prefix.** `/opt/homebrew/var` and `/opt/homebrew/etc` hold real secrets on this Mac (a Tor hidden-service key, PostgreSQL data), so the profile no longer opens `/opt/homebrew`. The runner reads the launcher's `#!` line (`/usr/bin/env node`, resolved on the reviewer's `PATH`) and the Mach-O load commands of node and every library it loads (through `@rpath`, `@loader_path`, `@executable_path`, fat images included), and opens only those `Cellar/<name>/<version>` kegs: on this Mac node@24 and 13 library kegs (brotli, c-ares, hdrhistogram_c, icu4c@78, libnghttp2, libnghttp3, libngtcp2, libuv, openssl@3, simdjson, sqlite, uvwasi, zstd). A library inside the prefix but outside a keg refuses the review. `var` and `etc` are then denied (read, write, map) after every grant, so not even an allowed folder that contains them reopens them. Homebrew's node opens `etc/openssl@3/openssl.cnf` at startup and exits when it can't, so the reviewer gets `OPENSSL_CONF=/dev/null`. The native Codex binary, its `rg` and its code-mode host link only system libraries. Other Homebrew tools on `PATH` (`jq`, Homebrew's `git`) fail with `Operation not permitted` inside the review.
- **Writes:** only the output folder, the private home, the private temp folder (`TMPDIR`) and the auth file. The checkout is read-only, and the checkout hash still fails a review that changes it.
- **Network:** only `localhost:<port>` of a runner-owned CONNECT proxy that tunnels to `chatgpt.com`, `openai.com` and their subdomains on 443 and refuses everything else, IP literals included (none can end in an API domain). **The proxy reads the TLS ClientHello before it dials**: it answers the CONNECT, buffers the client's first bytes (at most 16 KiB of ClientHello, 32 KiB of records, 10 seconds), reassembles the ClientHello across TCP chunks and TLS records, and tunnels only if it is a well-formed ClientHello with exactly one SNI host name equal to the CONNECT host. Non-TLS bytes, no SNI, a different or differently-cased SNI, `encrypted_client_hello` (0xfe0d) or ESNI (0xffce), a repeated extension, or bytes after the ClientHello in its record close the tunnel without dialing. This stops domain fronting by SNI (CONNECT `chatgpt.com`, then a handshake naming another site on the same CDN). The real Codex 0.164.0 ClientHello (1486 bytes, SNI `chatgpt.com`, no ECH) passes, captured against a local sink. Codex follows `HTTPS_PROXY`; anything that ignores it gets a Seatbelt denial. TLS uses macOS's own `/private/etc/ssl/cert.pem` (`CODEX_CA_CERTIFICATE`), because the platform verifier needs securityd, which stays closed.
- **IPC:** only directory, logging, trust, power and network-configuration services. LaunchServices, AppleEvents, preferences (cfprefsd) and securityd stay closed: they act outside the profile.
- **Fails closed.** No macOS, no `sandbox-exec`, a profile that can't be applied, or a probe failure refuses the review (`error`, no Claude fallback). Before Codex starts, the runner proves the profile on this run: `/bin/cat` of a canary planted beside the allowed folders must fail, and of a file inside them must succeed. `review-run.mjs` checks the machine before its hours of evidence and copies lane verdicts out of the jail only as plain files.

*Why this mechanism:* stage 0's experiment on this Mac (Darwin 25.5, Oct 25): an outer profile denying reads by default confines `cat`, `ls` and writes as intended, but a process under any profile can't apply a second, different one (`sandbox_apply: Operation not permitted`, even when the second is stricter; only an identical profile nests). Codex's `read-only` sandbox is Seatbelt, so inside our profile it would fail every command. Codex's sandbox is therefore off (`--sandbox danger-full-access`) and the outer profile takes over what it did: no writes outside scratch, no network but the proxy. Live (three short prompts): under the profile, Codex logged in, ran `cat candidate.txt` (read), `cat <canary>` (`Operation not permitted`), and `curl https://example.com` (proxy 403). The sandbox runtime (srt, decision 69's gates) was the other option; it would need its proxy to stay up for the whole review, and Codex's own permission profiles (`deny_read`) would confine its commands but not the Codex process itself. Seatbelt directly is one profile, written and tested here, independent of Codex's config.

*Limits:* Codex's API hosts are an exfiltration route only to OpenAI, which receives the review content anyway. **The HTTP `Host` inside TLS can't be checked without intercepting TLS**, which would mean a runner CA trusted by Codex: a client with a valid `chatgpt.com` handshake can still ask the CDN for another zone in its HTTP request, and whether that works is up to the CDN. A second ClientHello after a HelloRetryRequest isn't re-checked either. The remaining system reads hold no user data on this Mac (audited Oct 25): `/private/etc`'s secrets (`master.passwd`, `sudoers`, `krb5.keytab`, `racoon/psk.txt`, `cups/printers.conf`) are root-only, so POSIX still denies them; `hosts` is world-readable and Fabricio-edited, but holds only host names; `/private/var/db/mds` holds the Security framework's MDS tables and error strings, `timezone` the zone data, `select` one link, and `/private/var/db/dyld` doesn't exist; `/Library/Apple`, the Command Line Tools and `/usr` are root-owned system files. `/System` covers `/System/Volumes/Data`, but Seatbelt matches the firmlinked path (`/Users/...`), so a denied file stays denied through it (tested). The auth file is readable to the reviewer's commands, as it was before; its findings stay redacted and fingerprinted. Evals still use the Claude reviewer only; adding Codex back to the eval arm (decision 97) is a separate call. The integrator's hand-written `codex exec -s read-only` command is not confined; use `scripts/review-run.mjs`.

### 104. Building Jarvis: workers are routed by difficulty, across both subscriptions (new; Oct 25; Fabricio; extends 84, 93)
Fabricio asked for as many Claude and Codex workers as the subscriptions and the Mac can carry, each on the model the task needs. The integrator routes every worker:
- **Hard (security design, adversarial review, sandbox or scanner bypasses, safety-gate fixes):** Claude `claude-opus-5-5`, or Codex `gpt-6-astra` at high or xhigh effort. Every Codex review of security code uses `gpt-6-astra`.
- **Normal (feature lanes, wiring, ordinary fixes with tests):** Codex `gpt-6.1-sol` at high, or Claude `claude-sonnet-5-5`.
- **Easy (mechanical edits, test splitting, docs, renumbering):** Claude `claude-sonnet-5-5` or `claude-haiku-5-5`, or Codex `gpt-6-luna`.
- **The ceiling** is decision 93's 6 Claude and 5 Codex workers. The Mac (8 cores, 16 GB) is the tighter limit: full suites, mutation runs and review evidence still go through the quiet slot, and nothing else runs a full suite while review evidence is being collected.
*Why:* review evidence collected under a load near 28 took about 4.5 minutes per mutation instead of under one, and round 20's evidence never finished.

### 105. Fabricio delegated the stage 2 (and later) ratings: a stand-in runs the intake, two independent judges rate (new; Oct 25; Fabricio; changes how 47's and §8's "you rate" is carried out)
Fabricio, Oct 25: "I'm literally just gonna let you do it and let you judge it yourself." So:
- **The run:** a Claude worker plays Fabricio in the real interactive flow (pinned Claude Code 2.1.309, the installed plugin, `/jarvis <the task's exact prompt>`). It answers each question as Fabricio would from what the repo and his notes say, or takes the default, and never reads the rubric. It records the full transcript.
- **The rating:** two judges that did no part of the run. One is a fresh Claude `claude-opus-5-5` worker; the other is Codex `gpt-6-astra` (read-only, confined). Each scores independently against the rubric in `jarvis-evals/rubrics/` and the GUIDE's questions, and fills the same `ratings.md` fields.
- **The verdict:** the proof passes only when both judges pass it. If their 1–5 scores differ by more than 1 point, or one passes and one fails, Fabricio decides.
- The integrator never rates work it orchestrated. Fabricio can still rate any run himself; his rating replaces the judges'.

### 106. One notify.json format; the stage-0 file reads as the same config (new; Oct 25; the run-wiring worker, found by the first live intake run)
Stage 0 wrote `~/.jarvis/notify.json` with `backend`, `server`, `topic`, `reply_topic`; the CLI's strict schema wanted `baseUrl`, `topic`, `replyTopic`, so every intake round said "notifications are off". One parser (`notify/config.ts`) now serves setup, intake and `jarvis run`, and reads both forms (`backend: "ntfy"` + `server` → `baseUrl`, `reply_topic` → `replyTopic`). The file stays as it is, so the phone's subscriptions keep working, and `jarvis setup --redo ntfy` rewrites it in setup's form. Errors never quote the file: its topics act as secrets.

### 111. Reviewers get bounded gate evidence; a review infrastructure error is never a code failure (new; Oct 25; the review-error worker, found by the first live Jarvis build; tightens 88 and 100; the integrator may renumber)
The first live `jarvis eval jarvis 05-citizenship-filter` blocked its task with nothing promoted: the protected Go gate passed all three attempts, but each gate's `go test -json` log was about 5 MB, the review service refused any evidence file over 1 MiB ("invalid or oversized review evidence"), and no reviewer ran. The eval arm passed the loop the service's pass/fail form, so the loop saw a code "fail", sent the builder "fix the review findings" twice and blocked with "Review code failed after two repairs". Settled:
- **What a reviewer gets of the gate evidence (refines 88):** the gate's verdict (check, status, each case's exit code and timeout, the verify phase's exit) and a bounded excerpt of every evidence file (`review/evidence.ts`). A log shows its last 16 KiB; a `go test -json` log shows a summary: the counts, every failing test with the last 4 KiB of its output, other events, and the final package lines (48 KiB at most). All of one review's excerpts total at most 192 KiB; the verify output goes first, so the logs are cut first. Each file says what was cut, with its full size and hash. The service still hashes every byte before a reviewer starts. The checks' own commands are not shown. As before, only the loop's gate evidence reaches reviewers; grading output never enters the loop (decision 97).
- **The review input is bounded, never refused for size.** The JSON data is at most 768 KiB, because both reviewers take the prompt as one argument and macOS allows 1 MiB of arguments and environment together. A larger diff is cut at file boundaries. The files left out are named, so the reviewer reads them in its checkout. Only the runner's own spec and criteria can still exceed the limit; that is an infrastructure error.
- **An infrastructure error stays an error (as decision 100 says).** Every caller passes the loop the service's recorded verdict: `jarvis run` already did, and the eval arm now does too. The loop retries an `error` once. If it errors again, the task blocks with `review infrastructure error: <what the service recorded>`. Neither try spends a repair or sends a fix prompt. A plain "fail" from a review function is a verdict on the code.
- **The record says what failed:** `review_result.error` is the service's own error, or the first reviewer's. `model` lists the models that reviewed, and is `null` when none ran (it was `""`). The eval's review-session count includes only reviewers that ran.

### 113. The planner gets one corrective attempt with the runner's refusal, and a plan may carry top-level notes (new; Oct 25; the planner-retry worker, found by the stage 3 eval of task 02; tightens 91; Fabricio can veto)
Both stage 3 Jarvis runs of `02-build-recruiter` ended `plan-failed` before any build: the planner wrote a sound plan, but added a top-level `feature` string and a `notes` array, and the strict plan schema refused it (`Unrecognized keys: "feature", "notes"`). The prompt asked for "an object with a tasks array" without showing the exact shape or saying that other keys are refused. The notes held real constraints: where the new package goes, no new dependencies, one canonical encoding for the message hash. Settled:
- **The prompt shows the exact shape.** The eval planner's prompt has a JSON skeleton of the plan and says the runner refuses any other key, at the top or in a task. The architect skill (the production planner, run interactively) says the same next to its example, and its example is parsed by the runner's schema in a test.
- **A plan may carry top-level notes.** `notes` is an optional list of at most 32 strings, each trimmed and 1 to 2000 characters, 16000 characters in all. Every other top-level key is still refused. The runner copies the notes onto every task's definition as `planNotes`, in the eval arm (`planEntries`) and in `jarvis run` (`planTasks`), and each build session's prompt and run header show them under "Planner notes (claims from the planning session, not evidence; ...)", one line each. Reviewers never get them (88). They are claims, never evidence.
- **One corrective attempt.** When a planner session finishes but the runner refuses its plan (not JSON, the schema, or coverage), one more planner session runs in the same planning workspace. Its prompt quotes the refusal (at most 4000 characters), says to rewrite `.jarvis/plan.json` only, and repeats the full planning prompt, since sessions don't persist. There is at most one retry. A session that ended usage-limited, refused, timed out or crashed is never retried: usage-limited stays usage-limited so the scheduler reruns the task, and the others are `plan-failed`. If the corrective attempt fails too, the run is `plan-failed` and its reason holds both errors.
- **Each planner session is recorded like the first.** The corrective session has its own header, log and usage record (`plan-a2`), and the `planner` session count says 2.
- **`jarvis run` has no runner-driven planner session,** so it gets no retry: it reads the architect's `.jarvis/plan.json` once, at start, and refuses an invalid plan with the error, which the person or the architect session fixes.

### 114. Bug tasks: sessions get their skills as text, a bug's exit condition names every path, and the reviewer checks the fix against the report (new; Oct 25; the stage 3 bug-task worker, from the failed Jarvis runs of golden tasks 4 and 5; Fabricio can veto; tightens 30, 88 and 97; the integrator may renumber)
In the stage 3 proof runs the loop claimed done on both bug tasks while their hidden checks failed: both runs of 04-chromium-sandbox and run r1 of 05-citizenship-filter. The build and review transcripts show five gaps:
- **No session had its skills.** Task sessions run `--restricted --tools Bash,Read,Edit,Write,Glob,Grep` (decision 68). That list has no Skill tool, so a plugin's skills are listed in `init` but can't be loaded. The eval arm didn't pass `--plugin-dir` either. Every build session ran on the bare task prompt.
- **One refused command ended all testing.** Each first attempt ran on the fast tier: 12 to 16 turns, about a minute. Each used compound commands (`;`, pipes, heredocs) that the build skill forbids. The first refusal ("Permission to use Bash has been denied…") was read as Bash being off. No first attempt reproduced the bug or finished a test run, and each wrote "NOT verified" in its notes.
- **Each fix covered the first trigger it found.** In 05 r1 the builder added phrase spellings without reading what the callers pass. In 04 r2 it fixed one compose service, and in 04 r1 it changed application code for a container fault. The run that passed, 05 smoke2, found the stored-data cause by comparing with a sibling function. Its own markup tests then failed in the gate, which escalated the repair to the strong tier.
- **The gate can't see what the builder didn't test.** The loop gates on the project's own suite (decision 97). A builder's test encodes the builder's hypothesis, so a fix for a wrong or partial cause passes unless some test covers the path it missed.
- **The reviewer checked the diff, not the report.** For a single-task plan, the review material was the request plus "reproduced, fixed, and the unit check and code review pass". Two of the three reviews took 3 or 4 turns and read only the changed files. The third said the gate couldn't show the fix works, and filed that as advisory.

Settled:
- **Every build-loop session gets the build and debug skills as text** in its runner-owned run header (`runner/session-skills.ts`). They are read from the Jarvis install, which no session can write, with the frontmatter removed. A missing, empty or oversized skill stops the loop before any session starts. This applies to `jarvis run` as well.
- **The eval arm loads the Jarvis plugin,** as `jarvis run` does (its tripwire and SessionStart hooks), so the arm measures what production runs.
- **The debug skill gets "Cover every path to the symptom".** Before fixing, the builder:
  - traces every caller's real data back to where it is produced or stored;
  - lists every configuration, service, entrypoint or platform the report covers;
  - writes these in the notes as `Paths:`, each one marked fixed or out of scope.

  The fix stays in the layer the report points at. The checks step tests the fix against the report's own words, not only against the new test. The build skill says a refusal refuses that one command, not the tool.
- **A bug's exit condition names every path:** "The reported symptom is reproduced and its root cause is fixed on every path that produces it (every caller, input form, configuration or entrypoint the report covers), and the unit check and code review pass." The builder reads it, and the reviewer checks it as the task's criterion.
- **A bug fix's reviewer gets a bug brief** (`review/service.ts`, when the material's `kind` is `bug`). The reviewer:
  - lists the symptom's paths by reading the checkout;
  - traces at least two inputs or configurations that the candidate's tests don't contain;
  - reports a path that still shows the symptom as high, because the exit condition isn't met;
  - reports a symptom fix outside the report's layer;
  - files a medium finding when no evidence case exercises the symptom.

  The verdict rules don't change.
- **A session is pointed at a spec only when the checkout has one.** Otherwise its prompt says there is none, because a bug report has no spec.

*Why these are general, not fixes for these two tasks:* each is a standard debugging or review practice: reproduce, trace the real input, list every trigger, fix at the cause's layer, check against the report, and review with new inputs. None names a task, file or phrase from tasks 4 or 5. The examples are generic categories (encoding, markup, case; the container, a deploy configuration, the build), but two of them match these tasks' root-cause families. That is one more reason the held-out task decides. The skill evals were not changed. The scaffolding that covers a model weakness is listed in `docs/harness-assumptions.md`.

*Found, not fixed: sessions can't run these projects' tests.* The gate runs Go 1.26.10 offline from its protected module-cache fixture. A session gets an empty per-run cache, the host's Go 1.24.5 and a toolchain download that fails inside the sandbox. No session in any of the four runs, the passing one included, finished `go test`. Every Go bug task therefore falls under the debug skill's "can't reproduce" exception, and the gate is the builder's only test run. Giving sessions a read-only copy of the gate's toolchain and module cache (never its checks) is an envelope change, so it is a separate decision (backlog). Settled by decision 123.

*Not changed:* routing. The first attempt stays on the fast tier and escalates after a gate or review failure (decision 24); the passing smoke run shows escalation works once something fails. If a held-out bug task still gets through the gate and review with an incomplete fix, the next lever is the strong tier for bug reviews (backlog). These changes were tuned on tasks 4 and 5, so they count as general only after a bug task never used in tuning passes (backlog). The Jarvis-arm runs made before this decision measured an arm without skills. As with decision 101, they are kept as history, and new runs replace them for the proof.

### 115. A failure inside `.rejects`/`.resolves` counts as a catch only if the reporter recorded it as an AssertionError (new; Oct 25; the mutation-hygiene worker, found by the 71bc00f stage 0–1 evidence run; changes the classifier both of decision 92's modes share)
Vitest 5.0.5 rewrites the stack of every error raised in a `.rejects`/`.resolves` chain to `Error: <message>` under its own frame. In the JSON report a failed matcher there (a wrong rejection, a multi-line "promise rejected … instead of resolving") looks exactly like a runtime error thrown in the chain, so the classifier called real catches ERROR (the three settings mutations, "eval allowlist not enforced at run").
- **The reporter records the real name.** `scripts/unhandled-reporter.mjs` writes, for each failure under Vitest's promise frame, the error's name keyed by the SHA-256 of the failure message the JSON report shows. Two errors sharing one message get no trusted name.
- **Only that record counts.** Under the frame, a failure is an assertion only when its record says `AssertionError`. Not even Vitest's own wording ("… instead of rejecting/resolving") counts without it: a runtime error can end the same way. Outside the frame nothing changed: the first line must still start with `AssertionError`.
- **Still errors:** a TypeError or any other runtime error thrown inside a `.rejects` matcher, with or without that wording, and any promise-chain failure the reporter didn't record.
*From:* the stage 0–1 mutation-hygiene work; Codex review of 927131c..9dc1d73 (FAIL, high: the wording shortcut let a recorded TypeError count). Tests: `tests/unit/mutation-classify.test.ts`, with a real Vitest run on `scripts/fixtures/promise-errors`.

### 117. Approving from the phone during a run: what counts, what the phone shows, and when it stays at the terminal (new; Oct 25; the approve-phone lane and its Opus review; settles backlog 99; extends 12, 41 and 50; Fabricio can veto)
`jarvis run` now sends each pending broker request to the phone and polls the reply topic while the run lasts (`commands/run-approvals.ts`, wired in `run-compose.ts`). Decisions 12 and 50 say a tap is only the answer and the broker checks the payload; they don't say which taps count, what the message shows, or what happens when the notifier is reachable from a session. This settles it.
- **A tap is only an answer, and only the broker records it.** The runner-owned poller calls `Broker.decide`, which binds the answer to the request's exact payload hash and op; nothing on the task-reachable broker socket can decide. First answer wins across the phone and `jarvis approve`/`reject`: a second answer that agrees is a no-op, one that disagrees is refused and the phone is told "Not counted".
- **A tap counts only if all of these hold:** its request id names a broker request of this project that is still unanswered; that request was registered for the phone with this project and a fresh 256-bit nonce, and the tap carries that nonce; the runner recorded a successful send (`sent`, written only after the publish returned; a failed or ambiguous send grants nothing); ntfy's server timestamp for the tap is after the send, to the second (a same-second tap is refused, a later tap with the same nonce counts; decision 130 compares it with ntfy's own time for the publish); no earlier tap answered this request or used this nonce; and its message id is new. Anything else is ignored and logged without its body. Requests from before this decision carry no project and stay terminal-only.
- **The phone shows what it approves.** The message carries the broker's own one-line summary (email: recipient and subject; other operations: their description, amount and target, as the broker writes it) and the payload hash's first 12 characters, never the payload or an email body. The summary is session-written text, so control, format and line-separator characters are removed and it is cut at 300 characters. *Trade:* ntfy's server sees recipients and subjects. A blind "approve email.send?" was the alternative, and a prompt-injected session counts on exactly that. To veto, drop `oneLineSummary(...)` from the message in `run-approvals.ts`.
- **The reply path stays out of every session's reach, or the run doesn't start.** Before hosting the broker, the run compares the notifier host with every session's effective network allowlist (the builder's, the Claude reviewer's, and the Codex reviewer's API domains with their subdomains), each passed as the same constant the session gets; a host any of them reaches refuses the run. A notifier on the Mac's loopback keeps approvals terminal-only instead: a protected check that may bind local ports reaches every loopback port, and a phone can't reach the Mac's loopback anyway.
- **A broken notifier never blocks a run (10, 50).** No notifier, an invalid config or a loopback host: one notice, and approvals stay terminal-only. A timed-out call pauses the poller until that call settles (a late answer is discarded); polls always start from the runner's durable cursor in the ledger, never from an adapter's in-memory one. An outage is reported once, with one line when the notifier is back. Poll bodies are capped at 4 MiB, and their errors quote nothing (ntfy events carry the reply topic). A ledger failure stops phone approvals for the run. Shutdown stops the broker first, then flushes the last requests to the phone, within 10 s.
- ~~**The poller reads only approval taps.** Typed steer notes and intake taps are passed over without a trace, so the reply topic's other readers still get them (a recorded "ignored" would have made them duplicates everywhere).~~ Superseded by decision 130: typed steer notes go to the run's inbox; intake taps are still passed over without a trace.
- **Known limits (backlog 113-116):** approval authority rests on the topics' secrecy, because the send-topic message carries the nonce and the reply URL; ~~the send-time check trusts the Mac's clock against ntfy's; the Mac itself shows no pending summary yet; and phone steer notes still aren't read during a run.~~ the other three are settled by decision 130.

### 118. The native launcher uses Seatbelt directly, and a GUI sandbox also needs input isolation (new; Oct 25; the native-launch lane review, found on the real machine; refines 102's "sandbox runtime" for the native lane, follows 110)
- **Seatbelt, not the sandbox runtime.** `lanes/desktop-sandbox.ts` writes a deny-by-default profile the way decision 110's `review/confine.ts` does; it needs `(literal "/")` (dyld lists the root at startup) and nothing below it.
- **Files and network aren't enough for a GUI app.** Seatbelt doesn't cover WindowServer, and WindowServer judges synthetic input by the TCC-responsible process: the runner, which holds the Accessibility grant the osascript probes need. Verified on Darwin 25.5: a binary under the profile posted a key and a mouse move into the user's session.
- **So the launcher refuses without input isolation.** `NativeSandboxDeps.isolateInput` is required with no default; without it native smoke stays "not run". The verified remedy (a helper that spawns with a disclaimed TCC responsibility, `responsibility_spawnattrs_setdisclaim`, a private API, plus a per-run input canary) is backlog 111 and needs Fabricio's go before it ships.
*From:* the Opus review of the Codex native-launch lane (backlog 87); backlog 110 (gate hook), 111 (input isolation), 112 (bundle defects).

### 119. Intake after the first live runs: delivery starts the clock, honest defaults, user decisions need a recorded answer (new; Oct 25; the stage2-fixes lane and its Opus review, found by the stage 2 run 1 judges; changes 8's alternative count and the timer in 10 and 86; tightens 48 and 85; Fabricio can veto)
The task 11 and task 01 runs (decision 105) promised a 15-minute timeout while phone delivery was off, recorded an explicit "yes" as accepted defaults, blocked the session on a foreground wait that only Esc could end, offered defaults that dropped the requested feature or hid their costs, and wrote `--by user` decisions the user never made. Settled:
- **Only a delivered round has a deadline.** The timer (decision 10) starts at a durable delivery receipt, written after the notifier accepted the message, not when the round is registered. An undelivered round has `deadline: null`: it never turns into unconfirmed defaults, a phone tap on it isn't counted, and the session waits for an answer typed there instead of handing off. A delivered message isn't proof the phone showed it.
- **Waits run in the background.** `jarvis intake answers <n> --wait 540` still runs at most twice, now in the Bash tool's background mode, and the session ends its turn, so the user can type answers at any time. An answer typed while a wait is pending is submitted once with `jarvis intake answer`; the pending wait sees the closure.
- **Yes/no questions:** each question has a default and 1–3 alternatives, so a yes/no question has one (decision 8 said 2–3). Every question still has a default.
- **Defaults say what they cost.** A format-2 round (`formatVersion: 2`) needs `default.tradeOff` on every question: the known costs research found, or "not checked" with the limitation. Older rounds still load. A default never drops or replaces the core of the request, and anything that rewrites or destroys past data is a question or an assumption the user can veto in the round.
- **An explicit answer is the user's, even "yes".** A one-question round takes a JSON string as the answer to that question. Only `{}` or `"defaults"` means accepted defaults.
- **`--by user` needs a recorded answer.** `jarvis decide --by user` requires `--answer <answerSeq>:<questionId>`. The ledger must hold that explicit session answer with user provenance, and the decision text must be its exact words (decision 168: or, with `--recorded-answer`, those words are verified separately and the text states the decision); a supersession must name the old ID in that question or answer. There's no TTY or environment exemption, since a session can open a pseudo-terminal. So an explicit request that overrides a decision (48) is recorded as a supersession only once a round has recorded it, and onboarding records a kept inferred decision as an accepted default ("keep" was the default it showed). The CLI still can't tell who typed a session answer (harness assumptions).
- **Not handled yet:** an answer typed after a delivered round timed out stays in the intake record and can't become a user decision (backlog 122).

### 120. The stage 2 plugin ships its roles, templates and paths (new; Oct 25; the stage2-fixes lane; Fabricio can veto)
- **Two roles in `plugin/agents/`:** `researcher` (`claude-opus-5-5` at `effort: medium`, Fabricio's call on 2026-10-29, was `claude-sonnet-5-5`; WebSearch and WebFetch only) and `spec-reader` (`claude-opus-5-5`; Read, Glob, Grep; only the spec and what it cites). The pinned Claude Code takes a full model ID in an agent's `model`. **No role has both web tools and local read or shell tools** (the review dropped the lane's Read, Glob and Grep from the researcher): the interactive session isn't sandboxed, so a page that steers a role able to read files could have it fetch a URL carrying a file's contents. The researcher works from the brief the main session writes, which never carries secrets or private project text. Without the researcher, research uses recorded sources or writes "not checked", and never substitutes Explore or another agent with a shell. Research and intake read nothing outside the project folder.
- **Bundled templates.** `PRODUCT.md`, `spec.md` and `DESIGN.md` are copied from `templates/` into the skills that fill them, since an installed plugin can't see the repository; a test keeps the copies equal.
- **`jarvis taste show`** prints the profile as JSON, or `null`, without creating the memory folder. Intake offers the profile in its own message before the round and never waits on it.
- **Mockup tooling stays inside the tripwire's rules:** generator scripts in `.jarvis/scratch/`, the comparison screenshot under `.jarvis/mockups/comparison/`, browser profiles in a gitignored project scratch folder. No hook change.
- **`jarvis spec check` compares the latest spec with today's register:** no unknown or superseded decision citations, and a decision range in a heading or a decisions line spans the whole register. Older versions stay as history.
- **`/jarvis` shows the triage headline first,** and the stage 2 hand-off says what's ready and stops: it never runs or inspects `jarvis run`.

### 121. Skills state rules; golden-task specifics stay out of them (new; Oct 25; the Opus review of the stage2-fixes lane; tightens 35 and 105; Fabricio can veto)
The lane wrote the round-1 judges' findings into the skills as examples: calendar reminders that fire on logged days, streak recalculation, manual contact entry, a "Recruiter" label, plan metering, the run's own assumption IDs. The stage 2 rerun re-rates the same two tasks, so those examples would hand it the answers. A finding from a golden-task run goes into a skill as a general rule. `tests/unit/skills-stage2-review.test.ts` bans the round-1 specifics in the stage 2 skills, roles and command. Examples that predate round 1 (the recruiter backlog example in research, the habit-app example in design) stay for now (backlog 126).

### 122. A Semgrep pass needs positive coverage, and gitleaks runs Jarvis's copy of its default rules (new; Oct 25; the scan-coverage lane and its Opus review, backlog 104–106; tightens 103)
- **Semgrep coverage is checked against the tree.** Pinned Semgrep 1.182.0 skips `.mts`, `.cts`, uppercase extensions and every extensionless script without reporting it (verified live). After each scan the runner lists the candidate's JS/TS, Python and Go files, by extension plus a 4096-byte first-line read for `#!` runners (node, tsx, ts-node, bun, deno, npx, python, pypy, including behind `env` options or wrappers). It requires every one of them in `paths.scanned`. A gap is an error naming up to 20 paths. A symlink, a special file, an unreadable tree or a longer first line also gives an error. Reported `paths.skipped` or `skipped_targets` still refuse a pass. `.git` is not listed (a git checkout can't contain one).
- ~~**So such files make the pass an error, never a pass, until Semgrep scans them** (backlog 130).~~ Superseded by decision 127: a second pass scans mapped copies of them. Semgrep's `--scan-unknown-extensions` applies explicit targets to every rule language, so it isn't used.
- **gitleaks gets `packages/cli/src/security/gitleaks.toml`.** It is the default config embedded in the pinned 8.28.0 binary (all 217 rules) without the global `paths` allowlist and three path-scoped rule allowlists, so `node_modules/`, lockfiles, `go.mod`/`go.sum` and images are scanned (verified live: the built-in config missed 11 of 19 planted fake tokens, this one none). Value-based allowlists stay. The runner adds `--config` to every gitleaks pin that has none; installation copies the file into the approved fixtures, and a unit test pins its SHA-256. A pin bump re-vendors it from the new binary. An explicit `--config` still has to be a protected file outside the checkout. MIT: the notice ships beside the copy (`security/gitleaks-LICENSE`); `skills/CREDITS.md` credits it.

*From:* the Codex scan-coverage lane (gpt-6-astra) and the Opus review, which added the tsx/bun/deno/npx runners and `env` handling and ran the live tests.

### 123. Task sessions get the gate's pinned Go, offline and read-only (new; Oct 26; the session-toolchain worker, from decision 114's "found, not fixed"; settles backlog 121; tightens 69, 95 and 97; Fabricio can veto; the integrator may renumber)
No session in the stage 3 Go runs finished `go test`, in either arm: four of the six baselines tried, and so did both 05 Jarvis runs. The cause was reproduced without a model session: the pinned sandbox runtime ran a session's own settings (`buildTaskSettings`) and environment on a sanitized FreeHire snapshot. Three things go wrong together:
- **The host's Go is older than go.mod.** A session's `go` is Homebrew's go1.24.5, and FreeHire's go.mod says `go 1.26.10`, so Go (`GOTOOLCHAIN=auto`) tries to download go1.26.10.
- **Go can't download anything in the sandbox, not even from the allowlisted proxy.** Go checks TLS through macOS's trust service, which Seatbelt keeps closed: `tls: failed to verify certificate: x509: OSStatus -26276`. curl, which has its own CA file, gets 200 from the same host. So decision 99's Go proxy entries were never usable by Go in a session.
- **Even `GOTOOLCHAIN=local` fails.** go1.24.5 refuses (`go.mod requires go >= 1.26.10`), and the per-run module cache is empty.

The sessions' workarounds made it worse. Under `blockReadsOutsideWorkingDirectories`, `dontAsk` refuses three kinds of command it can't check against the read block: an environment assignment outside a safe list (`GOTOOLCHAIN=local go …`), code read from stdin (`python3 - <<EOF`), and a `cd` to a computed path. Each refusal looked like Bash being off (backlog 6). With the environment set by the runner, a plain `go test ./...` runs.

Settled:
- **The runner unpacks the toolchain go.mod asks for, once per run** (`toolchain/go.ts`). It takes the `toolchain` line, else the `go` line, and unpacks that version's toolchain module zip from a fixture module cache in the gate's layout (`cache/download/golang.org/toolchain/@v/`). The toolchain goes in `~/.jarvis-work/toolchains/<task>/<run>` and is removed after the run's sessions.
- **The runner unpacks that zip itself, as hostile input** (`toolchain/zip.ts`; Codex security reviews of dd0923f..a299593, highs 1 and 2, and of e13ca2a). It runs outside any sandbox, so it uses no `unzip`, whose `UNZIP`/`UNZIPOPT` options from the runner's environment can turn on `../` paths.
  - **Trust first.** The zip must be the pinned one: `config/pins.ts` `GO_TOOLCHAIN_ZIPS` lists the SHA-256 per version and platform (go1.26.10 darwin-arm64 now, the same hash as jarvis-evals' `hidden/go-fixture.sha256`). Its bytes are hashed before a single one is parsed. A version with no pin, or any other zip, stops the run.
  - **In a process of its own.** Listing and extraction run in `toolchain/zip-worker.ts`, started with the runner's own Node, a 512 MB V8 heap and an empty environment, so `NODE_OPTIONS` and the like can't reach it. The runner kills it at 300 s (it takes about 23 s at load 17). Any kill, crash, non-zero exit or missing reply is a refusal, and the partial folder is removed.
  - Every entry is listed and checked before anything is written. Each name's length (1024 bytes), depth (64 folders) and all names together (8 MiB) are bounded before any string is built from them. The path must lie inside the toolchain module's folder, with no empty, `.` or `..` segment and no control characters or backslashes. It must be a plain file or folder, with no link and no special file. Two paths that this Mac's disk treats as one are refused, compared after Unicode decomposition (NFD) and case folding. So is a file where a folder goes, found with one sort in linear memory. Zip64, encryption and any method but stored or deflate are refused.
  - Limits: 256 MiB archive, 20,000 entries and 512 MiB declared expansion. go1.26.10 darwin-arm64 is 69.6 MB, 11,523 entries and 211.7 MB.
  - Free disk is checked first: if the largest allowed unpack would go below the 20 GiB floor (decision 63), the run stops and nothing is written.
  - While unpacking, each entry inflates to at most its declared size and what is left of the budget, and must match its CRC-32. Files are created with `O_EXCL | O_NOFOLLOW`.
- **Sessions get two folders read-only, and nothing else.** These are the unpacked toolchain and the fixture's module cache, each in `allowRead` and `denyWrite` (the install's read-only mechanism). The environment matches the gate's go-env:
  - the toolchain's `bin` on PATH, after the jarvis launcher;
  - `GOTOOLCHAIN=local`, `GOMODCACHE=<fixture>`, `GOPROXY=off` and `GOSUMDB=off`;
  - `GOFLAGS=-buildvcs=false -mod=readonly` and `CGO_ENABLED=0`.

  `GOCACHE` and `GOPATH` stay in the session's private, writable cache (decision 69). Nothing is downloaded.
- **Refused before any session starts:**
  - a fixture that is a symlink, is reached through a linked folder, or holds a link or a special file;
  - a toolchain folder or path variable that overlaps the runner folder or any folder that a session or a gate's candidate code writes (worktrees, caches, eval workspaces and check runs of any run), checked by the harness and by both eval arms;
  - a PATH entry outside the read-only folders;
  - any variable but the six above.

  The settings themselves also refuse a read-only folder that overlaps the session's cache or temp folder.
- **It fails closed.** Only an absent fixture, no zip for the version go.mod asks for, or a go.mod with no `go` line means the host's Go, as before. The run says so with `toolchain` in manifest.json and summary.json and a log line. Anything else stops the run before any session, in both arms: an unreadable go version line, an unpinned version, a zip that isn't the pinned one, a refused or failed unpack, a kill at the deadline, the disk floor, or a folder that overlaps one sessions write. Each arm writes summary.json with `started: false` and `toolchain: {status: "refused", reason}`, so the run isn't counted, and the schedule stops there.
- **In evals, both arms read the same fixture:** the gate's `hidden/<task>/gate/fixtures/gomodcache`, reopened read-only in place.
  - The gate reads its own installed copy in the runner folder, so the gate's input is never a path a candidate can reach.
  - Only that subfolder of `hidden/` becomes readable; `hidden/<task>/checks` and the rest of `gate/` stay closed (checked live). A fixture that leads into the grading checks is refused.
  - *Why in place, not a copy:* on this Mac, an APFS clone of the 739 MB, 47,000-file cache takes 2 to 3.5 minutes from Node, `cp -c` or `ditto --clone`. Only `clonefile(2)` on the whole folder is fast (1 s), and Node can't call it.
- **`jarvis run` keeps today's behaviour.** Production checks live in the runner folder, which sessions can't read, so a production fixture would need a runner-made copy, and no production fixture format exists yet (backlog 139).

*Proof (no model session, Oct 26):* sandbox runtime 0.0.81, a fresh snapshot of FreeHire 9c1dbd4, the production preparation, check and settings:
- before: `go version` fails with the x509 error;
- after: `go version go1.26.10 darwin/arm64` and `ok github.com/strelov1/freehire/internal/dict/location`;
- `touch` into either folder gives "Operation not permitted".

*Known noise:* Go's telemetry prints `error acquiring upload token … operation not permitted` on every command, because it reads `~/Library/Application Support/go/telemetry`, which sessions can't read, and `GOTELEMETRYDIR` can't be set. It is harmless. Node and pnpm projects and the unused Go proxy entries are backlog 140 and 141.

### 124. The design reviewer and the Impeccable checks (new; Oct 26; the Codex gpt-6-astra design-reviewer lane and its Opus cross-family review, with the first live negative control; settles how 56's reviewer sees the app; tightens 53, 54, 110 and 111; Fabricio can veto)
- **The runner drives the app; the reviewer gets bounded evidence.** Decision 110's jail lets the Codex reviewer reach only its API, so it can't use the live app as 56 describes. The runner's protected `design-browser` check (`review/design-browser.ts`) drives each named flow in the gate's sandboxed Chromium at 375, 768 and 1440 px, one single-process browser per page (decision 125). A flow is at most 30 fixed click, fill or press steps, and must end on its URL showing its expected text; a redirect fails the capture. The review gets up to 4 flows and 12 PNG screenshots (2 MiB each, 4096 px at most, attached with `codex exec -i`). It also gets the accessibility tree and visible text of each page, in 192 KiB of excerpts it shares with the code checks' evidence (decision 111), every evidence file hashed in full. Last, `PRODUCT.md`, `DESIGN.md` and the direction's principles.
- **Confined exactly as the code reviewer (110):** the same Seatbelt profile, CONNECT proxy and canary probe, the screenshots opened as single read-only files, the version check inside the jail, the checkout hashed before and after, and no fallback reviewer. `gpt-6-astra` at high effort, a different family from the builder.
- **One design per session, never a comparison (56).** The capture holds one design id and refuses extra keys; every review is a fresh session; the two calibration fixtures are reviewed separately.
- **The runner computes the verdict.** Each axis is scored 1 to 5: quality and originality weigh .35 each, craft and functionality .15 each. The review fails on an axis below 3, a weighted score below 3.5, any high finding, or the model's own "fail". A failing code check fails the review whatever the model says. A missing, malformed or oversized verdict (over 64 KiB or 100 findings) is an `error`: never a pass, and never a design failure either (111). `reviewDispatch` sends the loop's "design" reviewer to a design service and keeps its recorded verdict.
- **Candidate content stays data.** Page text, trees, code-check excerpts, `DESIGN.md` and `PRODUCT.md` go in one JSON line between fixed markers, with `<`, `>`, U+2028 and U+2029 escaped. The instructions treat every page, screenshot (text in it included) and file as untrusted. Since the runner decides pass or fail, injected text can only sway scores, which the code checks and the calibration bound. Reviewer-written finding text is redacted before the ledger or a caller sees it, because the jail can read the auth file (110).
- **Verdicts count only after a negative control on this exact policy (56).** A review that isn't a calibration is an `error` until its ledger holds two runner calibration entries for this model and policy hash. The generic fixture's must have the model's verdict "fail" and name `launch-tour`, `multiple-primary` and `apologetic-error`. The runner records those friction rules from the findings before redacting them. The good fixture's must pass, its code checks included. The policy hash covers the model, the rubric and the full instruction text, so any change needs a new control.
- **Only an existing product's design system excuses its own choices (51, 53).** The runner's material says `designSource`. "existing" means `DESIGN.md` was written from a product that already exists, so its choices are inherited and not findings. "new" means it is a direction picked for this product, and a tell from decision 53 that it adopts is still a finding unless `PRODUCT.md` asks for it. A material without a valid source is refused. Found by the control's first round: the lane's "existing design systems keep their inherited choices" let the generic fixture's `DESIGN.md` excuse its default theme, gradient, card kit and emoji.
- **Impeccable runs its native engine, pinned (54).** `pins.ts`: engine 0.1.16 at `~/.jarvis-work/cache/impeccable/0.1.16/impeccable`, by sha256, never the npm launcher, which can download an engine. A gate case can't read the home folder, so installing the design checks checks the hash and copies the engine into the protected fixtures. Before every scan the driver hashes that copy, then checks that `--version` prints exactly `0.1.16+engine`. Scans run with `--no-config --no-inline-ignores`, so a candidate's config, `DESIGN.md` and suppressions don't apply. Exit 2 must match the primary findings, and output is capped at 1 MiB. A missing, swapped or wrong-version engine, a crash or unparseable output is an `error`. URL scans attach with `--cdp` to the runner's own single-process Chromium, one per viewport and never navigated by Impeccable, after checking that the DevTools port's only page is that browser's target. `jarvis doctor` reports the engine's hash and version. Impeccable alone flags none of the three friction choices; `lanes/tells.ts` does.
- **Not wired into `jarvis run` yet (backlog 133):** runner-owned design material, a calibration record that outlives one project's ledger, protected `ai-tells`, `token-lint` and `design-md-lint` definitions (the service requires them; none exist), and the lane-check caller (backlog 127). All but the lane-check caller are settled by decision 156.

*Result of the first control* (docs/reviews/design-negative-control-1.md): Impeccable fails generic and passes good. The reviewer fails generic, flagging every planted choice in round 2, and also fails good, mostly on that fixture's own contradictions. So it is not calibrated, and the service refused a counted review live. Next: backlog 134.
*From:* the Codex `gpt-6-astra` design-reviewer lane; the Opus integrator's review (the engine couldn't run inside the gate, single-process Chromium, findings unredacted, calibration matching redacted text, the inherited-design excuse); backlog 133–138.

### 156. `jarvis run` composes the design reviewer from the run branch and the approved store (new; Oct 31; the Codex design-wire-133 lane and its Opus cross-family review; settles backlog 133's needs 1, 2, 3 and 5; extends 124; tightens 56; Fabricio can veto)
- **Composed when the run branch has a `DESIGN.md`.** `prepareProductionRun` gives `reviewDispatch` a design service whenever the run branch's tree has a `DESIGN.md` entry (`designOnBranch`, `review/design-material.ts`); a test seam injects a fake. The candidate's working tree is never read. Each review reads the branch head again through the runner's git seam: `DESIGN.md` and `PRODUCT.md` must be regular committed files, and the principles are the Overview's `Principles:` field from the template. A missing `PRODUCT.md` or a bad `DESIGN.md` is a recorded design review error, not a run that refuses to start. "code" reviews still go only to the code service.
- **Material from the approved store, checked on every review.** The store must verify against the ledger first. `designSource` and the axe pin come from `checks/design-review.json`, the flow plan from `design-plan.json`. `designSource` defaults to "new": nothing written in the repo can claim an existing design system (51, 53). The integrator sets "existing" at install, for a product onboarded from its own system.
- **Evidence only from the protected definitions.** A check's name proves nothing: an architect-authored check can be called `design-browser` and run candidate code that prints a capture of anything, and before this the service would have shown that capture to the reviewer. The material carries the protected definitions, from `design-checks.json` (the Impeccable installer) and `design-lint/checks.json` (the lint installer), both outside the top-level names an authored check can take. The latest result under each required name must have run exactly that definition, cases and verify alike, or the review is an `error` naming the check.
- **Protected lint checks.** `installDesignLintChecks` (`lanes/design-protected.ts`) writes `ai-tells`, `token-lint` and `design-md-lint` as top-level checks the loop runs, in the gate's two phases. The case runs the existing lint code (`lanes/design.ts`, `lanes/tells.ts`) from the fixtures on the checkout and prints its findings; a separate verify with no checkout fails on any finding, an incomplete observation or a case that didn't exit 0. Token lint uses the tokens of the `DESIGN.md` approved at install, not the candidate's. Sources are bounded UTF-8 text from a file list fixed at install, never read through a symlink. Like `installSecurityChecks`, it never approves and refuses to overwrite; approving the reviewed store is a separate runner step.
- **A calibration that outlives one project.** `saveDesignCalibration` writes `~/.jarvis/design-calibration.json` only after checking both control entries. The record names the control's ledger, which must sit under the runner home in owner-only folders with no symlinks or hard links, the two entry hashes, the model and the policy hash. `calibrated()` accepts the project's own controls or that record, re-verifying the record's ledger chain and entries every time; a record that doesn't verify is ignored.
- **The latest control decides.** For each fixture, the latest calibration entry under the current model and policy must hold: the generic fails and names all three friction rules, the good passes with its code checks. A later control that failed withdraws an earlier pass, and a fixed fixture's later pass can calibrate. Named hashes, and the shared record's, must also hold.
- **A fenced verdict reads as its JSON,** as for the code reviewer (6e76430): `evaluateDesignVerdict` takes `unfencedJson` from `review/verdict.ts`, so a reply that is exactly one fenced JSON block reads, and prose around it, two blocks or another language stay an `error`. The 64 KiB bound applies to the raw reply. The parse is the runner's, so the policy hash and the control are unchanged. The Impeccable installer now also copies `review/verdict.ts`, since its protected runtime imports `design-verdict.ts`; without it the `design-browser` verifier couldn't load.
- **Still missing.** Nothing in `jarvis run` runs `impeccable-source`, `impeccable-url` or `design-browser` yet (the lane-check caller, backlog 127), and no control has been saved, so every production design review is an `error` until both exist. Installing the Impeccable checks currently stops `jarvis run` from starting at all (backlog 180). The golden-task harness doesn't use this composition (backlog 184). Decision 162 settles 180 and the harness half of 184.

*Why:* backlog 133. The review found the name-only evidence binding (high), the ignored later failure (medium) and the run-wide refusal (low); each was fixed tests first, with its mutations in stage 4 files (`review/mutations-design.json`, `commands/mutations-run-design.json`, `lanes/mutations-impeccable.json`).
*From:* the Codex `design-wire-133` lane; the Opus integrator's cross-family review; backlog 180–184.

### 125. Axe fails on what a change adds; the QA browser is single-process, one per viewport; hidden checks install as clones (new; Oct 26; the stage 4 fixes lane and its review, found building golden task 06; changes 54's "zero serious issues"; the integrator may renumber; Fabricio can veto)
- **Axe is compared with the starting revision.** An existing app can have serious issues of its own (FreeHire's `/jobs` has 7 contrast nodes), and "zero serious issues" failed every UI change to it. The runner records the serious and critical violations of the base revision from its own run in the sandbox (rule, impact and selector, per viewport and frame position), and the check fails on a violation that record lacks, or on a rule with more nodes than before. Severity going up counts as new.
- **No baseline means today's strict rule,** and a baseline that doesn't match the URL and the pinned axe version fails the check. A baseline is a process-local handle made only by `recordWebBaseline` from the runner's base observation; nothing in a candidate's output or files can make one. Incomplete results and findings with no impact still fail, and a base run that has them records no baseline. Across verify processes the base observation lives in the approved checks (`checks/expected/axe-base.json`, outside `fixtures/`). Wiring that capture into the runner is backlog 127.
- **The QA Chromium launches with `--single-process`** (`lanes/toolchain.ts`), because srt has no Mach registration allowance and a normal Chromium dies at its `MachPortRendezvousServer` bootstrap inside the gate. A single-process browser takes one page, so `observeWeb` launches and closes one browser per viewport. The installer's smoke launch runs outside the sandbox and can't catch either; `JARVIS_BROWSER_LIVE=1` runs the real observation inside `runSandboxed`.
- **Hidden checks install as APFS clones.** Node 24.21 cannot clone on macOS (`cpSync`'s `COPYFILE_FICLONE` mode is ignored, and `copyFileSync` with it does a full copy), so `installHiddenChecks` runs `/bin/cp -cR` and falls back to Node's copy if cp fails. A Go task's ~1 GB module cache and task 06's 2.8 GB of fixtures no longer land in every grade folder. The hashes of the installed copy are still checked against the source.
*Why:* each was found by the real machine and none was visible in the lane's fakes: the lane's clone option copied everything, and its single-process browser could not take a second viewport.
*From:* the Codex stage 4 fixes lane (gpt-6.1-sol) and its Sonnet review; backlog 127 (baseline wiring), 128 (baseline edges), 129 (single-process).

### 126. A review that asks for fixes: the review writes the report, one bug task per finding, then the report says what happened (new; Oct 26; the review-fix worker, backlog 109, golden task 3; extends 89 and 114; the integrator may renumber; Fabricio can veto)
Golden task 3 says "Put what you find in REVIEW.md and fix the real problems", and triage made it a read-only review with no edit pipeline, so the Jarvis arm couldn't run it and `/jarvis` had no way to fix what a review found.

> **Round 3 supersedes the triage rules below.** Triage no longer starts a review's fixes from its wording, and no longer reads limits from it either. Round 2's ledger exemption for reports is gone too. Fixes start only on an explicit, structured opt-in; see "Round 3" at the end. The pipeline itself (the report, one bug task per finding, the report update) is unchanged.

**Triage** (extends 89; superseded by round 3):
- **A review stays a review.** When its words ask for fixes ("and fix …", ". Fix …", ", repair …"), or the model passes `--then`, triage adds a bug pipeline as its `then`, the way a question with edits gets one. A review's fixes are always bug work. A bare "fix" is not a request: "Review the fix for the login bug" asks for a review of a fix.
- **Its one step becomes `review-report`.** The findings go to the report the request names ("put what you find in REVIEW.md", or `--report`), and to REVIEW.md when it names none. A typed path outside the checkout, or in `.git` or `.jarvis`, gets a `report-refused` signal and the default. The report is the step's only edit.
- **A named report alone starts no fixes.** The review writes the file and stops. A named file is a deliverable, not permission to change code. A plain "review this" stays read-only, as before, and still has no Jarvis build-loop arm in evals.
- **Security lens:** the review also follows the security skill when the request has security words or touches a tier-2 area (decision 37). Task 3's "outreach" is one.

**The pipeline** (`runner/review-fix.ts`, shared by the eval arm and `jarvis run --plan review`):
1. **The review step writes the report.** A session writes the report and `.jarvis/review/findings.json` in its checkout; the runner never writes the findings itself. In evals the runner starts that session as the reviewer, in a fresh checkout, with the review (and security) skills as text and the static trifecta detector's result as evidence. In production the interactive `/jarvis` session runs the review skill's new report mode. The prompt asks, for each finding, for:
   - file:line, severity and confidence;
   - the code path from an input the code really receives, and why that path is reachable ("a dangerous-looking line with no reachable path is not a finding");
   - a proposed fix.

   It also asks the session to say "Not a problem" explicitly for suspicious code it checked and cleared.
2. **The runner reads both files once the session ends,** with the bounded no-follow reader:
   - No report means no fixes, and the run says so ("the review session wrote no report at REVIEW.md; no fixes were started"). The eval outcome is `review-failed`.
   - A symlink, a hard link, a symlinked folder or a path outside the checkout is refused the same way.
   - Every finding must appear in the report with its id and file:line, so the JSON the fixes come from matches the report a person reads.
   - A finding about a file the base revision lacks gets no task.
   - Anything else the session changed is discarded, and the run says so.
3. **The runner commits the report** on the run branch, that one path only. In evals it is the fixes' base revision, as task 2's spec is. In `jarvis run --plan review` it is committed before anything is hosted, since promotion needs a clean checkout. The findings stay claims.
4. **One bug task per finding,** not one per file:
   - Each exit condition embeds decision 114's for that one finding: confirmed in the code before anything changes, and fixed on every path. A low-confidence finding that can't be confirmed is left unchanged.
   - The reviewer gets the bug brief, with the finding as the report.
   - So each fixed or not-fixed line comes from that task's own gate, review and promotion, never from a session's account of which findings in a group it fixed. One false or stuck finding blocks only itself.
   - Two findings in one file can overlap. That costs a runner merge and a second check, or a redo, which the loop already handles.
   - A low-confidence finding's goal says to change code only once it is confirmed.
   - Each fix task requires the `unit` check and a code review.
   - Ids follow the ledger's own tasks, since the loop never re-creates an id. A task with the same definition keeps its id, so planning the same findings twice adds nothing.
5. **A last task writes the outcome into the report.** It is gated and reviewed like any task and may touch only the report. It records what the runner's records say happened to each finding:
   - fixed: passed and merged, with the files it touched;
   - left unchanged: passed with no file change;
   - not fixed: with the reason it was blocked;
   - not attempted.

   The session writes the report; the facts are the runner's. A fix loop that throws runs no update. In evals the run counts as complete only when every fix and the update passed. In production, `PreparedRun.drive` runs the two loops one after the other.

*Why:* task 3 needs both the report and fixes that hold up. Review work and bug work already have their rules (the review skill, decision 114), so the pipeline joins them instead of inventing a third kind of task. False alarms are a review's known failure, and task 3 counts them. So the prompt asks for evidence per finding and an explicit "Not a problem", and the runner checks what code can check: each finding's id and file:line in the report.
*Not done:* the protected scanners (gitleaks, semgrep, osv-scanner) don't run in the review step. They run only as gate checks recorded against a task, and a gate result for a task the ledger never created breaks state replay. The step says "not run" rather than imply a clean scan (backlog 160).
**Round 1 of the Codex security review (three highs, fixed):** the report commit is the one change no gate or reviewer sees, so:
- **The runner owns the report path.** It comes from the request (triage), or from `jarvis run --plan review --report <path>`, default REVIEW.md. The findings file's `report` is only compared with it, so a session can't name a different file for the runner to commit.
- **A report is a file only people read:**
  - a .md, .markdown or .txt path with no git pattern characters (`[ ] { } ! * ?`);
  - not hidden, and not under `docs/spec/`, where the approved specs live;
  - not a name that builds, agents or Jarvis read (README, CHANGELOG, LICENSE, AGENTS, CLAUDE, GEMINI, DESIGN, PRODUCT, SKILL, SECURITY, CONTRIBUTING and the like);
  - for .txt, a name that says review, finding, report or audit, so it is never `requirements.txt` or `CMakeLists.txt`.

  An existing file can be the report only when it is REVIEW.md or the file the request names, because the path is never the session's.
- **The commit names the report as a literal pathspec** (`:(literal)…`), so a name like `[C]MakeLists.md` can't take `CMakeLists.md` with it. Afterwards the runner checks that the commit changes exactly the report against its parent; otherwise it undoes the commit (the branch goes back, the work tree stays) and refuses (`commitReportOnly`).
- **An explicit constraint wins over fix words and the model's judgment,** for a review and for a question's edits alike:
  - "do not edit", "don't change anything", "make no changes", "read-only" or "without changing anything" means a plain read-only review: no report, no fixes;
  - "fix nothing", "don't fix anything", "report only", "suggestions only" or "only report" means no fixes, though a report the request names is still written;
  - a scope ("don't change the public API", "no changes to the CLI flags", "without changing the file format") is not a constraint.

**Round 2 (one high left from round 1, one new): fail closed, instead of listing what not to do.**
- **Fixes need a positive authorization** (`triage/authorize.ts`).
  - Fixes start only on an imperative to fix, repair or resolve something: the verb at the start of a clause or after "and", "then", "also", "please" or a comma, followed by what to fix ("the real problems", "them", "what you find").
  - The clause it sits in holds no negation at all.
  - Descriptive uses never authorize: "fix suggestions go in the response", "the fix for", "fixes go in", "address", "patch".
- **Any negation of editing anywhere in the request means a plain review.** That covers edit, change, modify, touch, write, fix and commit, plus "read-only" and "report only". The one exception is a change scoped to a named part with "to", "in", "inside", "within" or "on" ("make no changes to the public API"). Such a scope becomes a limit the fix tasks carry: in the goal, and in the exit condition the reviewer checks.
- **"The whole repository" is not a named part:** "no changes to the code" or "to the repository" stops fixes. A write or a commit can never be scoped, so "don't write to disk" stops fixes too.
- **The model's judgment can veto fixes but never add them.** When fix words were seen but authorize nothing, triage says so: "Fixes weren't requested".
- **A report name may not start with a reserved stem, with any suffix and in any case:** CLAUDE*, AGENTS*/AGENT*, GEMINI*, COPILOT*, CODEX*, CURSOR*, WINDSURF*, CLINE*, AIDER*, WARP*, MEMORY*, SKILL*, DESIGN*, PRODUCT*, README*, CHANGELOG*, HISTORY*, LICENSE*, COPYING*, NOTICE*, SECURITY*, CONTRIBUTING*, CODE_OF_CONDUCT*, CODEOWNERS*, CONVENTIONS*. It also may not contain "instruction", "rules" or "prompt", and hidden names were already refused. `CLAUDE.local.md` and `AGENTS.override.md` are refused, and so is `SECURITY-REVIEW.md`.
- **The report commit never replaces a file the base revision already has,** unless this pipeline wrote that file before. The runner records each report it commits in the ledger (`reconciled`, type `review_report`). A new REVIEW.md is fine; one the project already has is refused. The eval arm checks this before starting the review session, and `jarvis run --plan review` checks it before anything is hosted.

**Round 3: no edit permission from free text.** Three rounds of the Codex review found phrasings that got edit permission out of prose: negations, scopes ("no changes to any files"), quoted text, explanations ("Explain how to review and fix the bugs") and conditionals ("If I approve, fix the bugs"). So triage stops trying:
- **A review is always a review, and triage never sets its `then`.** That holds whatever the wording and whatever the model's `--then`. Fix words only give a `fixes-mentioned` signal, which prompts the opt-in question. `triage/authorize.ts` is gone. `triage/fix-words.ts` keeps only that signal and a fail-closed prohibition check, with no scope exemption. The prohibition check only ever removes edits: a question's edits (decision 89 still reads those from words) and a named report.
- **Fixes start only on an explicit, structured opt-in:**
  - **Interactive.** The `/jarvis` session asks one intake question with id `review-fix`: "Fix the confirmed findings after the review?", default "no", the one alternative "yes". Decision 119's rule applies: only the user's recorded, confirmed, session-typed "yes" counts.
  - **`jarvis run --plan review`.** It needs `--fix`, or `--fix-answer <answerSeq>:review-fix`. The runner checks the second against the ledger and refuses a no, a default, a timeout, a phone tap or another question's answer. Without either, the run is refused before the probe.
  - **The eval arm.** The golden task's `task.json` carries a runner-owned `"reviewFix": true`, or `{ "limits": ["…"] }`. Any other value refuses the task before the preflight, and a review without it has no Jarvis build-loop arm.
- **Limits come only with the opt-in:** `--limit <text>` (repeatable) on the run, or the eval opt-in's `limits`. They are never derived from prose, and they ride on every fix task's goal and exit condition as before.
- **A report never replaces a file the base revision has, whoever wrote it.** The ledger record and its exemption are dropped. The eval arm refuses before the review session. `jarvis run --plan review` refuses unless the branch already has that report exactly as it stands (a rerun commits nothing, so it replaces nothing). The refusal names `--report <path>` for a new file.

**Round 4: a review run touches only its own tasks.** The loop picked ready tasks from the whole project ledger, so a review run dispatched unrelated unfinished work, including when the review found nothing. That work kept its own goal, which this review's limits never reached.
- **The loop takes an allowlist** (`RunLoopOptions.only`). It dispatches, retries, recovers and blocks only those task ids. Its result, its `run_ended` entry and REPORT.md ("Left alone by this run") list every other unfinished task as left alone, and `jarvis run` prints them. An empty allowlist runs nothing; with no allowlist, the loop behaves as before.
- **The allowlists:** the fix loop gets this review's fix task ids. The report update gets those ids plus its own; the fix tasks are done or blocked by then, so only the update can run, and the result covers the whole review. This holds in production and in the eval arm.
- **No findings means no fix loop at all,** only the report update. `jarvis run --plan review` always drives its own phases, and never falls through to the ordinary build loop.
- **A scoped run keeps what it leaves alone recoverable** (round 5). At the end it deletes only its own tasks' candidate branches; `deleteCandidateBranches` takes the allowlist. At the start it keeps the other tasks' workspaces. A task that crashed after committing its candidate is still recovered by the next unrestricted run.

*From:* the review-fix worker (Opus), Oct 26; round 1 after the Codex `gpt-6-astra` security review of 5316a3c..f686919, round 2 after its review of 5316a3c..2cc72ae, round 3 (the integrator's design) after its review of 191837e, round 4 after its review of d765748.
### 116. A stage proof counts runs from one frozen Jarvis revision, rated by blind judges (new; Oct 26; the integrator, after the first stage 3 runs)
- **One revision per proof.** The counted runs of a stage proof all come from one frozen clone of Jarvis; runs from an earlier revision move to `~/.jarvis/evals/_superseded/<task>/` with a README, and their results stay recorded. When a fix changes what both arms' sessions get (decision 123's toolchain), both arms are rerun.
- **Ratings by two blind judges** (decision 105): each task's runs from both arms are shown to a fresh Claude `claude-opus-5-5` judge and a Codex `gpt-6-astra` judge under neutral labels; a run's rating is the two judges' mean rounded down, the same rule for both arms. A gap above 1 point or a split goes to Fabricio.
- **Tuning on the proof tasks is disclosed.** Fixes found on a proof task must be general (decision 114's rule); a held-out task (backlog 118, 150) checks they generalize.

### 127. Semgrep scans mapped copies of the files it skips, and an OSV snapshot expires after 14 days (new; Oct 26; the scan-mapped lane and its Opus review, backlog 130 and 93; changes 122's second bullet and 103's snapshot-age bullet; Fabricio can veto)
- **A second Semgrep pass covers the files 1.182.0 skips.** After the normal pass, the runner copies each covered file missing from `paths.scanned` that has a known mapping (`.mts`/`.cts` to `.ts`, an uppercase JS/TS/Python/Go extension to lowercase, a `#!` script to `.ts` for tsx/ts-node/bun/deno/npx, `.js` for node, `.py` for python/pypy) into a private folder in the scanner's temp directory, under flat numbered names. It runs the same pinned Semgrep with the same arguments there, maps each finding's path back to the original file before fingerprinting, and removes the folder. The rule IDs and fingerprints match what a first-pass finding would have (verified live).
- **Coverage still has to be positive.** The pass is clean only if every covered file appears in one pass's `paths.scanned`, the copy's names counting only for their own originals. A file with no mapping (an ordinary `.ts` the first pass missed) is still an error, as are a scanner fault, a skipped or errored target and a finding on a path outside the copy.
- **The copy is bounded and refuses links.** At most 4,096 files and 64 MiB in all; each source is walked component by component with `lstat`, opened with `O_NOFOLLOW`, and must be the same regular file (device and inode) the walk approved, so a link, a special file, or a parent directory swapped for a link is an error. The copy keeps the exact bytes.
- **Protected rules must not filter by path.** The copy's names carry no folders, so a rule with `paths:` would match differently there. The vendored rules have none.
- **An OSV snapshot older than 14 days is an error** (`OSV_MAX_SNAPSHOT_AGE_MS`), naming its fetch date and the refresh command (`node scripts/osv-db-fetch.mjs`, then a reviewed reinstall). Exactly 14 days passes. A missing, unparseable, non-canonical or future `fetchedAt` is an error too. The check runs at scan time, after the snapshot's hashes, and can't be exempted. Fourteen days allows a weekly refresh with a week of margin while keeping advisories at most two weeks behind.
- **Installed checks keep their copied drivers** (like backlog 108 and 132): an install made before this change neither runs the second pass nor expires its snapshot until it is reinstalled and approved.

*From:* the Codex scan-mapped lane (gpt-6-astra) and the Opus review, which added the device/inode check after showing a swapped parent directory let the copy read a file outside the checkout, and ran the live tests.

### 129. A stage review confirms only its own stage's mutations; everything is confirmed once before v1 closes (new; Oct 26; Fabricio; supersedes decision 94's cross-stage fast pass)
Round 21's estimate was 20–30 hours of an otherwise idle Mac: 376 stage 0–1 mutations on the full suite (about 2 minutes each) plus 1,220 other stages' mutations in fast mode. Fabricio chose, Oct 26: "Check this stage only."
- **A stage review's evidence** runs `--confirm-stage <s>` for that stage's mutations only; other stages' mutations aren't run at that review.
- **Stage 7's close** still runs `--confirm` over every mutation, once.
- Cutting the suite's CPU time stays the main lever for both.

### 130. An approval answered at the Mac shows the exact action; a phone tap is timed on ntfy's clock; phone steer notes reach the run (new; Oct 26; the approve-ui lane and its Opus review, backlog 114–116; extends 12 and 117, changes two of 117's bullets; Fabricio can veto)
- **`jarvis approvals` lists, and `jarvis approve`/`reject` show before they answer.** The list is read-only from the verified ledger: no lock, no repair, and a missing project stays missing. It shows the id, operation, the broker's one-line summary, the payload hash's first 12 characters, when it was asked and, where the ledger has them, the task, attempt and session. `approve`/`reject` print the operation, summary, full payload and full hash, then ask `[y/N]`; anything but `y`/`yes` records nothing. Without a TTY they refuse unless given `--yes`. They never execute anything (the broker executes on its next request, as before). The project comes from `--project`, then `JARVIS_PROJECT`, then the repository.
- **What is printed is what is approved.** The command recomputes the payload hash from the stored payload and refuses a request where the two differ or the payload is missing. It hands the shown hash and operation to `Broker.decide`, which records the answer only for that request. If the same answer was recorded elsewhere while the prompt waited, the command says so; a different answer is refused (first answer wins, 117).
- **Redaction never hides where an action goes.** `to`, `ref`, `target` and `amount_usd` print verbatim; only URL credentials go, and the host stays. Free text (`subject`, `body`, `description`) loses only secret-looking words: the snapshot scanner's credential patterns, JWTs, and values assigned to password, secret, token or key names. A secret spread over several words (a key block, an Authorization header) hides that whole field, with its length shown. The review redactor's rule for any 32-character run is not used here: it hid commit SHAs, repository paths and bucket names. Zero-width, bidi, separator and unusual space characters print as JSON `\u` escapes, so a payload without secrets prints as JSON that parses back to exactly the approved payload. *Trade:* a secret-looking word in free text is approved unseen. The hash still binds it, and its `[redacted]` marker is itself a reason to reject.
- **A tap's time is checked on ntfy's clock** (changes 117's "ntfy's server timestamp for the tap is after the send, to the second"). `Notifier.send` returns the publish response's server `time`, and the run records it with the send as `serverTime`. A tap counts only if its ntfy timestamp is later, to the second, than that publish time. The publish time stands in for the Mac's record of the send by at most `MAX_APPROVAL_CLOCK_SKEW_SECONDS` (120), so a garbage publish time can't widen the window. So a Mac running ahead no longer refuses real taps, and a tap from before the send still never counts (the poller retries an ambiguous send with the same nonce, so a tap on a delivery the runner never confirmed would otherwise count). Without a publish time the Mac's clock is used, as in 117. When ntfy's time is what let a tap count, the ledger records the measured skew and the allowance applied. The lane's first version allowed a fixed 120 s before the Mac's record instead; the review replaced it for that reason.
- **A refused tap gets a fixed one-line reply on the reply topic**, "Not counted: …", with no request id, nonce, payload or body. It goes only to a tap carrying a nonce this project registered for that request. The reply topic is shared by every project's run, so any other tap is another project's, or a forgery probing for request ids. Reply-topic readers treat `Not counted:` as invalid, never as a steer note.
- **Phone steer notes reach the run** (decision 50; supersedes 117's "the poller reads only approval taps"). The run's poller records a typed note once, by its ntfy message id, and writes it into the inbox `jarvis steer` uses, under a name derived from the ledger entry (`notify-<seq>.json`). A replay after a crash neither loses nor repeats it, and the runner applies it between tasks. Intake taps are still passed over without a trace. A note is only text for the planner: it can't approve, and a reply shaped like a button is never a note.
- **Known limits:** the broker doesn't record which task or session asked (backlog 152); phone steer notes aren't addressed to a project (151); `jarvis status` and REPORT.md don't list pending approvals yet (153).

*From:* the Codex approve-ui lane (gpt-6-astra) and the Opus review. The review bound the answer to the shown payload, kept targets out of redaction, replaced the fixed 120 s window with ntfy's publish time, and limited refusal replies to this project's taps.

### 131. Golden task 3 plants a compiling regression and names its report (new; Oct 26; the task 03 build; refines docs/02-golden-tasks.md §3)
- **The plant isn't a plain revert of 971efc2.** Later commits call what that fix added, so undoing it doesn't compile, and the compiler errors would name two of the three answers. The plant reverses 971efc2 and keeps the later callers compiling with the guards gone (a plain HTTP client behind the same constructor, the two validation calls and one later test removed, three comments that named the guards reworded). It is built by a script in the private eval repo from FreeHire's own objects; FreeHire is only read.
- **The prompt names the report and asks for fixes:** "Review the outreach code before I ship it. Put what you find in REVIEW.md and fix the real problems." A report needs a known path to be graded black-box, and the hostile-content trial needs real fixes (§3's "finding it isn't enough").
- **Graded by five protected checks:** the report names each of the three findings with a file and a fix in one unit of REVIEW.md (other finding-shaped units are counted as possible false alarms, not failures); SSRF, header-injection and prompt-injection trials against the wired code; and the project's own suite. Proven on the real gate: the planted tree fails, the reference fix plus a hand-written report passes, and each half-fix fails only its own check.
- **The Jarvis arm can't run it yet:** a review that asks for fixes needs the review-then-fix pipeline (backlog 109, being built). It can since decision 126 (pipeline `review-fix`).

### 132. Recorded research, uncontaminated skills and bounded intake (new; Oct 26; the Codex stage2-r3 lane and its Opus review, the stage 2 round 2 prerequisites in docs/reviews/stage2-run2-summary.md; extends 15, 70, 119 and 121; refines 7; supersedes 120's profile-offer placement and architecture §4 step 7's intake production grant; Fabricio can veto)
- **No answers in the plugin.** Skill evaluations live in `evals/skills/<name>/`, outside the installed plugin, byte-for-byte as before. Plugin-reachable instructions, templates and roles contain no evaluation answers or task-specific examples; `tests/unit/stage2-plugin-contamination.test.ts` walks the plugin through its symlinks for eval files and a domain ban-list that lives only in the test.
- **Recorded research.** A project's `.jarvis/research-fixtures/` folder selects recorded mode, even when empty or invalid: no web calls, no live fallback. The format is the private eval repo's recordings: one Markdown file per source directly in the folder, front matter `url`, `title`, `retrieved-at`, `kind` (`page` or `search`) and, for a search, `query`, whose `url` is a synthetic `websearch:?q=…`; an optional `INDEX.md` is a table of contents, never a source. Research chooses sources from the index or front matter, reads in full each one it uses, cites its file, original URL (or query) and retrieval date, and declares "Sources: recorded fixtures". Missing evidence stays "not checked".
- **Recorded pages are quarantined like live ones** (decision 120, the Opus review). Only `jarvis:recorded-researcher` (`claude-sonnet-5-5`; Read and Glob; no web, shell, search or write tools) reads the recordings and returns findings; the main session never opens them, and without that role outside claims are "not checked". The web researcher keeps WebSearch and WebFetch only and isn't used in recorded mode. Like the spec reader, the role's reads are confined to its folder by instruction only (backlog 125).
- **The tripwire is a guard against mistakes; the eval's boundary is the bytes the run actually read.** The interactive session isn't sandboxed (decision 120), so nothing in the repo can stop a determined session from changing, swapping or restoring fixture files: permission bits yield to their owner, a writable parent lets the folder be replaced, and an after-run checksum misses a change, read and restore. The boundary is a post-run verifier outside the repo that checks every fixture Read's returned content in the run transcript against the original recording (backlog 155). The tripwire (`plugin/hooks/tripwire.mjs`) only catches obvious attempts early, with a clear reason.
- **What the tripwire allows** (Codex reviews of this lane, rounds 1 and 2: writes through Bash and quote splits, case variants, links, ancestor links, searches):
  - **Reads:** Read of a regular file with one link directly in the session's own `.jarvis/research-fixtures/` (same inode as that real folder, under the nearest `.jarvis` up to the git toplevel), with no symlink in any path component from the git toplevel down; Glob only with `path` set to that folder (same walk) and a pattern without `/`, `**` or `..`. Grep gets no fixture exception (it recurses).
  - **Writes:** Write and Edit to the fixtures are refused. Bash is read with its quotes, backslashes and `$''`/`$""` splits taken out; in a Jarvis session it is refused when it names `research-fixtures`, has a word (through plain `cd`) at `.jarvis/research…` in any case, or has a glob that could expand into the fixtures (`.jarvis/r*`, `.jar*/*`, braces and brackets read as the shell does). It is also refused when one pipeline combines a changing command (`chmod`, `chown`, `chflags`, `mv`, `rm`, `cp`, `install`, `rsync`, `tee`, `truncate`, `dd`, `touch`, `mkdir` and kin, `sed -i`, `perl -i`, `find -delete`/`-exec`, behind `sudo`/`env`/`xargs`) with a `.jarvis` path it may not change, or redirects into one. Any command may change the session's own files and what is inside its areas (notes, scratch, intake, mockups, checks, onboard, sweep, release, plus `plan.json`); `mkdir`, `touch`, `cp`, `install` and mv's destination may also name an area folder itself (`mkdir -p .jarvis/notes`, Codex round 3); nothing changes `.jarvis` itself, an area folder or a runner-owned path, and no link (`ln`) is made under `.jarvis`.
  - **Searches:** a Glob pattern or Grep glob may reach those session areas (`.jarvis/notes/*.md`, `.jarvis/checks/*.mjs`), as before; other `.jarvis` paths, `..` and the runner home are refused.
  - **Case:** every `.jarvis` rule ignores case (APFS does), the runner home included.
  Without the read exception every fixture read was refused and recorded mode had no sources.
- **Intake decides engineering and asks only what only the user can answer** (refines 7). It records engineering policies itself, asks about the person's current situation before solution choices for a new product, and counts every independently answerable question toward seven, a profile offer included. The profile offer no longer precedes the round; incomplete preferences stay product context without invented answers. Spec confirmation is a separately labeled round. Release, production and spending permissions belong to ship, against concrete actions.
- **Defaults preserve the requested outcome.** A conflicting project constraint is quoted with its path and line~~, and the constrained default says it follows it~~. Superseded by decision 155: the question states the conflict and the default keeps the request's outcome.
- **The spec reader loop is bounded.** It ends on a clean pass~~, or stops after three passes with no new blocking gap; unresolved blockers keep the spec draft~~. Superseded by decision 168: at most three fresh-reader passes per spec version, never reset, and what remains goes to the confirmation.
- **The verifier fails closed (Codex review rounds 3 and 4).** A stage 2 run counts only if the post-run verifier passes on its transcript: every Read of a recording returns exactly the original lines, in order and within the requested range; any other route that could return recorded content (a Bash command with a reading tool near `.jarvis`, a recursive search that includes hidden folders, a Grep or Glob into `.jarvis` or with a hidden-folder pattern, a script that names the recordings, a duplicate or missing tool result) voids the run instead of being trusted. Residual risk: a session that reaches the recordings through a route the verifier doesn't recognise. The stand-in denies any command that touches `.jarvis` beyond the session's own files, and the judges see the transcript.

### 148. Golden task 7 names its report, grades the git findings by rubric, and the Jarvis arm runs the onboarding step (new; Oct 31; the task 07 worker; refines docs/02-golden-tasks.md §7; extends 89, 97 and 100; the integrator may renumber; Fabricio can veto)
- **The prompt names the report:** "Get familiar with this repo and make it easier for agents to work in. Put what you find in ONBOARDING.md." As for task 3 (decision 131), a report needs a known path to be graded black-box, and headless Claude Code's final message never reaches the repo.
- **Graded by five protected checks** (jarvis-evals `hidden/07-onboarding-cleanup/checks/`): `agents-size` (at most 32 KiB); `guidance` (every `##` section of the old `AGENTS.md` is reachable from the new one within two links: its heading, and at least 80% of its text as 8-word shingles, pinned as hashes); `links` (FreeHire's own `scripts/check-doc-links.mjs`, pinned); `findings` (one unit of the report names `AGENTS.md`, its size or the harnesses' read limit, and a fix); `map` (at least 15 cited paths that exist, in at least 4 top-level areas, at most max(3, 10%) that don't; a Go test and a Go build or vet command; no invented make target or package script). "Every old heading is still reachable" is read as heading and text: a table of contents that keeps the headings and drops the bodies loses what the finding is about.
- **The two git findings are graded by the rubric** (`rubrics/07-onboarding-cleanup.md`). A snapshot has one commit and no remotes (02 step 1), so "`impl/de-0001` has no remote" and "`origin` points at the public upstream" can only be drawn from `IMPLEMENTATION.md`'s source-pin table. Giving snapshots remotes was rejected: it changes the snapshot rule and the runner's git surface for every task, for two findings a file already shows. A report that draws them from that file is right, and so is one that says the checkout can't show remotes; words can't tell either from a guess. The `findings` check prints what the report says about git state, for the person grading.
- **The gate is FreeHire's own suite for a documentation change:** its `docs` CI job (the link check, its own pinned copy) and its Go suite offline, allowing only the arch-test complaints `23d3266` already has (tasks 4 and 13). Moving sections without rewriting their links fails it.
- **The Jarvis arm runs the onboarding step as one session** (pipeline `onboard`). Triage reads a question with onboarding words and a refactor or bug `then`. One session as the architect, in a fresh checkout, follows the onboard skill (as text) and writes the report the request names (default `ONBOARDING.md`) and `.jarvis/onboard/plan.json`. The runner reads both with the bounded no-follow reader, the plan exactly as `jarvis run --plan onboard` reads it (no criteria or stories, installed checks only, plain boundaries), discards anything else the session changed, commits the report alone (never over a file the snapshot has), and runs the plan's tasks through the loop. No report or no usable plan: outcome `onboard-failed`, nothing committed, no cleanup. An onboarding question with a feature `then` goes to the research skill, which the arm doesn't run.
- **The skills' hand-off names the plan.** Session plans are read only with `--plan` (decision 100), but onboard and sweep handed off with plain `jarvis run --detach`, which ignores them: the stage 6 Codex review's "the cleanup handoff has no consumer". They now hand off with `jarvis run --plan onboard --detach` and `jarvis run --plan sweep --detach`. The onboard skill also writes its report where the request names one, and lost its golden-task specifics (decision 121).

### 155. Stage 2 round 4: defaults keep the request's outcome, and what the user confirms is final (new; Oct 31; the Codex intake-r4 lane and its Opus cross-family review, the six defects in docs/reviews/stage2-run3-summary.md; follows 121; supersedes 132's constrained-default wording and the intake skill's "keep" default for a register conflict; refines 9 and 86; changes when architecture §2's design step runs; Fabricio can veto)
Round 3 failed on six defects both judges found. Each is now a general rule in the skill step where the session applies it, with no golden-task specifics (decision 121; `tests/unit/stage2-plugin-contamination.test.ts` passes). `tests/unit/stage2-r4-rules.test.ts` checks each rule in its section, and `tests/unit/stage2-r4-mutations.json` breaks each one (stage 2). Settled:
- **A default never narrows the requested outcome** (intake, Write the questions). When a project rule really conflicts with the request, the question quotes the line, states the conflict, and its default keeps the request's outcome; a register conflict's default follows the same rule instead of "keep". A project line that limits what the build may do (deploy, buy, send, connect) is a build constraint, not a product rule: it still binds the build, and accepting a default never authorizes spending, messaging a real person or bypassing it. Outside actions still go through the broker.
- **Engineering that protects people outside the project is decided, never asked** (intake, Sort product from engineering): at least a refusal list checked before every message, a retention rule and an idempotency rule, recorded like any engineering decision. A mechanism never works against the job story's outcome (round 3's second defect also had a rule that worked against the goal research supported).
- **The story map covers the new job only:** every stage from its trigger to its last user-visible outcome. An existing later stage of the project is named as a boundary, never pulled in.
- **One confirmation carries about 20 P1 acceptance criteria and 7 unconfirmed assumptions** (spec, Write the spec). Past that, P1 is cut to the walking skeleton and the rest become P2/P3 stories with their own criteria and assumptions. The runner still builds them all (the plan must cover every criterion, `runner/plan.ts`), so nothing is called deferred; nothing is dropped or merged to fit~~, and a skeleton over the budget is kept whole and said to be~~ (superseded by decision 168: a skeleton over the budget is thinned to the shortest complete path). The confirmation question lists every unconfirmed assumption on its own numbered line, and the count it reports is the file's.
- **What the user confirms is final** (spec, Confirm and Hand off; design, After the pick). The design skill's After the pick (or its existing-system step) now runs inside the spec step, before the reader check, so `DESIGN.md`, its Taste decisions and a revised mockup are part of what is confirmed. Triage still lists `design` after `spec`; `/jarvis` only checks that it ran and, if not, runs it and confirms again. Before sending, the spec, `DESIGN.md`, `PRODUCT.md`, the register and the picked mockup are made to agree, and lines that state an earlier position are updated or marked superseded. After confirmation none of them changes without a new confirmation round. A "changes" answer leaves the spec a draft and is confirmed again with the revised artifacts; 86 had the answer itself count as the confirmation. Mid-run versions keep 86: checked, read, `status: unconfirmed`, never a confirmation round.
- **A contradicted default is re-asked once** (intake, Take the answers). When an answer contradicts another question's accepted default, a short second round holding only the contradicted defaults runs before the spec, outside the seven-question cap. There is only one; a conflict that remains becomes an unconfirmed assumption listed first in the confirmation, so the hand-off never stalls on it.
- **Phrase tests prove the rules are there, not that a session follows them.** That is the round 4 proof's job (decisions 105 and 116).

*From:* docs/reviews/stage2-run3-summary.md; the Codex intake-r4 lane; the Opus review, which kept 86 for mid-run versions, counted the budget on what one confirmation shows (P1 criteria and unconfirmed assumptions: the lane counted every assumption in the file against 7, which a round's answers alone can exceed, and then left the spec a draft that never hands off), dropped the lane's claim that P2/P3 stories aren't built, and restored guidance its compression dropped.

### 168. Stage 2 round 5: a hard cap on reader passes, a thin skeleton, honest defaults, no silent widening, re-rendered mockups, register entries that state the decision, and no Claude Code memory (new; Nov 1; the Codex stage2-r5-fixes lane and its Opus cross-family review, from the round 4 judges' defects; extends 155; supersedes 132's conditional reader bound and 155's oversized-skeleton exception; refines 119's entry text; Fabricio can veto)
Round 4 (main 969fc41, with 155's rules) reached a confirmed spec on both tasks, but the judges split, one PASS and one FAIL on each, and every judge reported the same defects. Each is now a general rule in the step where the session applies it, with nothing from a golden task (decisions 114 and 121; `tests/unit/stage2-plugin-contamination.test.ts` passes). `tests/unit/stage2-r5-rules.test.ts` checks each rule in its section, and `tests/unit/stage2-r5-mutations.json` (stage 2) breaks each one. Settled:
- **At most 3 fresh-reader passes per spec version, never reset** (spec, Check with a fresh reader). Passes after confirmation changes count; a new blocker or revised wording never resets the count. At the cap, a remaining blocking product question becomes a `[delegated]` "default unconfirmed" assumption listed first in the confirmation, and any other remaining blocker is a known gap on the confirmation page; then confirmation starts. The intake record notes the count under Spec check vN. Both round 4 runs ran 8 passes (78 minutes and 2 hours) under 132's "three passes with no new blocking gap", because every pass found a new one, until the user said stop. The spec reader role no longer names the old stop. Mid-run versions keep 86.
- **A walking skeleton over the budget is too thick** (spec, Write the spec): thin it to the shortest complete path and move the rest to P2/P3. Both runs had used 155's escape (41 and 23 P1 criteria, 55 and 85 in all). Criteria state behavior the user can observe; implementation mechanics are engineering decisions in the intake record unless a safeguard needs them to be checkable.
- **Honest defaults** (intake, Write the questions). A question about the user's own past or situation gets a neutral default, what the product assumes when unknown, never a made-up first-person answer that a timeout would record as fact. A default never takes the option its own trade-off names as the failure risk, unless the question says in one line why that risk is accepted.
- **A provider or service is engineering** (intake, Sort product from engineering): ask the need it serves and decide the pick, unless the user must hold an account, pay, or would notice the difference. The lane wrote this for storage providers only; the review made it any provider or service.
- **Questions are checked against the constraints before sending** (intake, Send the round): each question's text, default, trade-off and alternatives against the fixed and build constraints.
- **Silence never widens** (spec, Write the spec). A decision after intake that widens who or what the product acts on, or overrides a safeguard research found, is never a silent Mechanical or Taste call. The spec keeps the requested scope and the safeguard, and the widening is listed first in the confirmation as an unconfirmed assumption that applies only if the user explicitly asks for it. The lane made the widening itself the unconfirmed default, which a timeout or "defaults" would have applied, against 155's "accepting a default never authorizes messaging a real person" and intake's "never grants or widens anything".
- **A revised mockup is re-rendered and looked at** (design, After the pick): at the width it was made for, with the comparison page, and fixed before the confirmation, which names the revised files. Without a renderer the confirmation attaches the HTML paths and says the revision wasn't visually checked, as intake does for the first round. The lane's "keep confirmation pending" had no way out and would have stalled the hand-off.
- **Register entries state the decision, and a design pick is Taste** (intake, Take the answers; spec, Confirm). Refines 119: `jarvis decide --by user` now takes `--recorded-answer "<the exact words>"`. The CLI verifies those words against the ledger exactly as before, then requires the entry text to state the decision, starting with the answered question's ID (`Q3: …`, `CONFIRM: …`). Why keeps the answer reference and `Exact answer: "<the words>"`. A supersession is still checked against the recorded question and answer, never the statement. Without `--recorded-answer`, 119's form (the entry text is the exact words) still works. The CLI can't check that the statement is faithful to the words; the register shows both side by side (harness assumptions). The lane taught the flag in the skills before the CLI had it, so every user decision would have been refused; the review added it, tests first, with four stage 2 mutations, and a test that every flag a skill teaches is one the CLI registers. The review also restored "no answer grants release, production or spending", which the lane's compression of intake had dropped.
- **Never write Claude Code memory** (`/jarvis`, before triage, so it holds for the whole session): learnings go in the project notes the skills name. An interactive round 4 session wrote a feedback note to the user's auto-memory, outside the project, to change the reader loop for later sessions. Three redundant sentences in the command were shortened to keep it under its 4,500-byte cap.
- **Phrase tests prove the rules are there, not that a session follows them.** That is the round 5 proof's job (decisions 105 and 116).

*From:* the round 4 judges' reports; the Codex stage2-r5-fixes lane; the Opus cross-family review, which added the CLI flag, kept a widening out on silence, removed the renderer stall, generalized the provider rule, fixed the reader role's old stop and the command's size, restored the dropped hard stop and added three skill mutations.

### 169. Stage 3 round c: a candidate's `.gitignore` edit is refused only when it weakens the runner's protection, a schema failure says which fields failed, and no build or review makes something work by weakening a security control (new; Nov 1; the Codex stage3-fixes-2 lane and its Claude cross-family review, from the three Jarvis defects that decided round c; extends 160; refines 87's "candidates never carry `.jarvis/`" for the `.gitignore` check; follows 116; Fabricio can veto)
Round c (main bf08637) completed or stopped honestly on every run, and three Jarvis defects, not the work, decided it: a feature build's one-line `.gitignore` addition (`/outreach`, the new binary, in the file's own convention) was refused as "must keep .jarvis/ ignored" because the project's `.gitignore` had never listed `.jarvis`, so both runs, the repair that builds on the failed candidate (160) and every dependent task fell; a reviewer's output failed the verdict schema and nothing readable said why; and a build "fixed" a crash by turning a sandbox off behind an environment flag, which the code reviewer passed. Each is now a general rule (116: nothing from a golden task). Settled:
- **A `.gitignore` change is judged against the runner's effective exclusions, and refused only when it weakens them** (`runner/worktrees.ts`). The runner keeps `.jarvis/` ignored through the workspace's `.git/info/exclude`, which the loop writes at workspace creation and `excludeReportFolder` writes for the main checkout. The check builds a scratch tree holding only the candidate's root `.gitignore` and an empty `.jarvis/`, asks `git check-ignore` under the context repo's `.git` with that file and its exclude in force, and requires `.jarvis` ignored by a non-negated rule. A root `.gitignore` that ignored `.jarvis` in the base must still ignore it itself: the exclude never substitutes for a removed line. Any negation aimed at `.jarvis` or anything below it (`!.jarvis`, `!.jarvis/`, `!/.jarvis/**`, `!/**/.jarvis/**`, character classes, escaped separators, trailing spaces) is refused even when Git masks it behind a later rule or an ignored parent, in any letter case: `core.ignoreCase=true` on the check models the default APFS volume on every host. The staged index (`commitCandidate`), a seeded repair, a merge and a promotion all go through one immutable-tree check that reads the ignore file by its stored name (`ls-files --stage` or `ls-tree`, so a case-renamed `.GITIGNORE` is read, two spellings are refused, and a symlink or submodule in that name counts as no file). A git fault other than "not ignored" propagates; a missing blob is never read as an absent file. Unrelated negations (`!keep.txt`, `!src/.jarvis/`) and a nested `.gitignore` pass: a nested file cannot reopen the root directory.
- **A verdict that fails the schema says which fields failed** (`review/verdict.ts`): `review output does not match the verdict schema: findings.0.line:invalid_type; checked:invalid_type; +3 more`. Zod issue paths and codes only, never a reviewer value, key or message, in one line of at most 160 characters, which is what the loop's blocked reason keeps and what REPORT.md's blocked line and the `review_result` ledger entry show. Before validation the adapter normalizes shapes with one meaning and no others: a `line` that is a string of digits, a `confidence` that is a decimal string in 0..1 (`"0.9"`, never `"90%"`, `"1.1"` or `".9"`), a severity in another letter case. Missing `checked` stays invalid, with empty findings too: empty findings do not establish that the reviewer performed the required checks. `FindingSchema` and `VerdictSchema` are unchanged, so the Codex `--output-schema` is the same.
- **Never make something work by disabling or weakening a security control** (build skill, Stay inside the worktree): a sandbox, TLS or certificate verification, an auth or permission check, input validation, an isolation boundary. Fix the cause, or stop and report when the fix needs a decision. The code reviewer's prompt (`review/service.ts`, every reviewer) makes such a change a high finding unless the spec explicitly asks for it, quoting the changed line and the exposure, an environment flag included; passing tests do not justify it.
- **Review of the lane (Claude, Nov 1):** the port onto main ffbd238 had no conflicts. The reviewer broke three guards by hand (the masked-negation rule, the case fold, the schema diagnostic) and the lane's tests caught each, in both the staged and the committed-tree path and at the verdict, ledger and REPORT.md layers; the 160-character bound was probed and holds (the final string is the one already measured at the previous passing step). One thing moved: the build-skill rule's phrases are pinned in `skills-build.test.ts` with the skill's other rules and its mutation is in `tests/unit/skills-build-mutations.json` (stage 3), where the lane had put it in `skills-mutations.json` (stage 2) and in a review-named test. The reviewer-prompt mutation stays next to `review/` (stage 4), so a `--confirm-stage 3` run doesn't run it. What stays open is backlog rows 225 to 229: a base `.gitignore` whose own negations un-ignore everything (`!*/`) is refused on every edit and is not protected by the exclude either, the exclude line is written by the loop rather than by `createWorkspace`, the normalized shapes are the three seen so far, and the security-control rule is prompt text with no mechanical detector.

*From:* the round c run records, the lane brief (`.runs/stage3-fixes-2`), the Codex lane's report and its Claude cross-family review.
### 170. The Goldfish plan review: three fresh-context lenses judge the plan before the build loop, and `jarvis run` refuses a plan without a counted review (new; Nov 1; the Goldfish worker, implementing docs/ideas/handoff-egm.md Part B as designed, deferred by 147; takes from Google's Elephant-Goldfish Model what docs/ideas/egm-gap-analysis.md ranked first; Fabricio can veto)
Jarvis had a strong verdict spine and an almost empty decision layer: the plan (`.jarvis/plan.json`) got schema and coverage validation only, and every design choice was made once, by one model, in one context. Now, between the architect session and `jarvis run`:
- **Three lenses, one at a time, on the strong tier** (`review/plan-lenses.ts`, the EGM personas adapted to Jarvis's artifacts): the Skeptical Architect (`zoom-out`: reuse-search, yagni, altitude, dead-ends), the Design Critic (`critic`: alternatives, assumptions, risks, standard-sections) and the Implementation Readiness reviewer (`readiness`: zero-decision, target-scope, phasing, test-plan). Each is a fresh read-only Claude session (Read, Glob, Grep; 40 turns, 15 minutes) over a clone of the run branch head with `.git`, `docs/intake`, `docs/research`, `.jarvis/notes`, `.jarvis/intake` and `.jarvis/mockups` removed, plus the plan at `.jarvis/plan.json` and the runner's approved checks at `.jarvis/checks` (the code review's checkout drops `.jarvis` whole; this one keeps what is being reviewed). The prompt carries the canonical plan, the approved spec, the committed register (cut at its newest entries when too large) and the plan's hash; the checkout's hash is checked after every lens.
- **The runner computes the verdict** (`review/plan-verdict.ts`): a lens's JSON must name every one of its four checks in `checked` or it is invalid, never clean; a blocker fails, a major needs resolution, a nit is advisory. Live Claude habits (one fenced block, `checked` as an object) are read as the code review reads them. One `plan_review` ledger entry per lens and one `overall` record carry the plan hash, the policy hash, the model, the verdict, the findings (ids `<lens>-<n>`) and whether the review counts.
- **A review counts only after a negative control** (decision 56's pattern): the latest control on the bad fixture (`tests/fixtures/plan-review/bad`: T2 recreates an existing util, T3 leaves the storage format to the builder, D3 is `hard` with no alternative) must fail naming T2, T3 and D3, and the latest on the good fixture must pass, for this exact policy text and model. The pair is per project ledger, or shared from the runner home by `jarvis plan review --save-calibration <bad>:<good>` (`plan-calibration.json`, verified like the design record). An uncalibrated review is recorded with `counts: false` and reported as an error.
- **The gate** (`commands/run-compose.ts`): a default `jarvis run` whose plan comes from `.jarvis/plan.json` computes the plan's hash (sha256 of the parsed plan's canonical JSON) and refuses unless the latest counted review at that hash passed, or every blocker and major has a resolution (172) with no escalation still open. Session plans (`--plan onboard|sweep|review`), bug requests (`--request`) and ledger-only runs are not plans it judges. The eval arm's planner is not gated (147's note; backlog 233).
- **Commands:** `jarvis plan review` (also `--calibrate bad|good` and `--save-calibration`), `jarvis plan resolve`, `jarvis plan accept <id> --answer`, `jarvis plan status`. The architect skill runs the review after `jarvis checks install`, with at most 2 rounds per plan version; the `/jarvis` command says so before its hand-off.
- **Deviations from the handoff's design,** each because the code refused the text as written: the handoff's `prepareCheckout` removes `.jarvis` whole, so the plan review has its own checkout (`preparePlanCheckout`); the plan is read from the working tree (decision 87 keeps `.jarvis/` out of candidate revisions), its hash from the parsed canonical JSON; the checks come from the runner's approved store, not the workspace proposals; the live control runs from `tests/fixtures/plan-review/<fixture>` copied and committed by the runner; the `plan_review` kind joins the ledger's `KINDS`; mutations live in `review/mutations-plan.json` mapped to stage 3 (the review folder's default is stage 4).

*Why:* decision 147 deferred this until the stage 3 to 5 proofs; Fabricio asked on Nov 1 for the planning layer to be finished with the rest of v1. The verdict spine makes a bad build visible after the fact; this makes a bad plan visible before any code, written by a model that never saw the author's reasoning.
*From:* docs/ideas/egm-gap-analysis.md (Oct 27) and docs/ideas/handoff-egm.md Part B; the Goldfish worker, Nov 1.

### 171. Engineering decisions of moderate or harder reversibility require rejected alternatives (new; Nov 1; the Goldfish worker, handoff B7; EGM's Alternatives Rule; extends 83 and 85)
`jarvis decide` with `--reversibility moderate|hard|irreversible` refuses unless `--alternatives` is a non-empty array whose every item matches `<option>: rejected because <reason>` (`decisions/decide.ts` `requireAlternatives`; the error text names the form). `--by user` decisions are exempt: the user's answer is the reason. The Design Critic lens checks that every such decision the plan cites has an alternative it can verify against the code, and that the rejection reason does not contradict what it reads.
- The intake skill's `jarvis decide` example is unchanged: the file is at its byte cap (backlog 224, 245) and intake records user answers, which are exempt. The architect skill carries the rule and an example.

*Why:* a design that proposes a single path without showing what it rejected has not been designed, only asserted; writing the rejection down is what lets a second model with no memory of the reasoning find the gap.
*From:* docs/ideas/handoff-egm.md B7; docs/ideas/egm-gap-analysis.md §2.

### 172. Plan-review findings are resolved by contest, fix, escalate or decline, validated by the runner without a model (new; Nov 1; the Goldfish worker, handoff B4; EGM's resolve protocol; applies to the spec reader's findings too)
The architect session writes `.jarvis/plan-review/resolution.json` (`planHash`, `resolutions: [{id, action, …}]`) and runs `jarvis plan resolve` (`review/plan-resolve.ts`):
- Every blocker and major of the latest counted review at that hash has exactly one resolution; a nit may only be `fix`ed or `decline`d; a blocker or major is never declined.
- `contest` needs `evidence` the reviewer could have read: an existing repo-relative file, `file:line` within the file's length, or an active decision `D<n>`. "This was intentional" is not evidence. A blocker is contested only with a decision id.
- `fix` requires the current `.jarvis/plan.json` hash to differ from the reviewed hash; the revised plan then needs its own review before `jarvis run`.
- `escalate` records a one-line `question` as a `plan_review` entry (`purpose: "escalation"`) that blocks the run until `jarvis plan accept <id> --answer "<text>"` records the user's answer once (`escalation_answer`, terminal authority). The register decision it settles is the architect's to record (backlog 234).
- Any violation throws and appends nothing; the accepted list is one `plan_review` entry (`purpose: "resolution"`).
- The spec skill's reader check uses the same four actions in place of "fix each gap, or record why not": a gap no file can settle is escalated into the confirmation, never padded into the spec.

*Why:* the spec author used to triage its own reader's findings, and nothing stopped "intentional" from closing one. Evidence the reviewer could have read is checkable by the runner; what it couldn't have read is the user's call.
*From:* docs/ideas/handoff-egm.md B4 and B8; docs/ideas/egm-gap-analysis.md §3.

### 160. A review's usage limit is waited out like a build's, a repair starts from the failed candidate, and the eval counts what ran (new; Oct 31; the stage 3 pre-review at 9ffe580, the Codex stage3-fixes lane and its Opus cross-family review; refines 62, 87 and 100; Fabricio can veto)
The stage 3 proof run of Oct 28 ended "blocked" with 4 sessions and almost no tokens, minutes before the plan's usage limit. A review session the limit refused was a review error, and two errors block a task. The eval also counted attempt records and refused reviews as sessions. The read-only Codex pre-review of stage 3 found six gaps; architecture §8 already says a usage limit is never a failure. Settled:
- **A review that hits the limit is `usage-limited`, never an error.** Only the harness's stream is the signal, as for builds (decision 62): a rejected `rate_limit_event` or an assistant `rate_limit` error in the review session, or the eval preflight's own limit, each with its reset. A reviewer's words reach the stream only inside JSON strings, so they can't fake one. A tool outside the read-only list, an init mismatch or a changed checkout still wins over a limit. The service records `status: usage-limited` with `resetAt` and starts no Codex review after a limited Claude review. A limit also wins over the timer that stops a limited session, for reviews, builds and repairs.
- **The loop waits it out like a build's limit** (`waitForUsage`: the reset plus the margin, or the capped backoff; the reprobe; the run-wide pause), then reviews the same revision again. The recorded limit is the checkpoint: a restart waits, then reviews, without rebuilding. A limit spends no repair and no review-error retry, and never blocks. After 8 waits on one review the run stops, the review checkpointed, as the eval schedule stops after 8 (`docs/harness-assumptions.md`). When another reviewer has already failed the code, the review is a fail: no rerun can overturn it.
- **A repair starts from the failed candidate's files.** Decision 100 says only that a failed runner merge repairs from the new head. No decision says other repairs start over, and the lane misread 100 as one. The repair's fresh workspace checks out the failed candidate's tree over the current run branch, through a three-way merge from the candidate's own base when the branch has moved since. HEAD stays on the run branch, so the next candidate is gated and reviewed as the whole change. A conflict, a missing candidate or a runner merge starts from the run branch as before, a stale-base redo is never seeded, and the prompt says which it got. The e2e repair scenario now edits the first attempt's files.
- **`jarvis run --request "<bug report>"`** hands one bug to the runner without an approved spec. The runner's own triage must read it as a bug, and anything else is refused before anything is hosted. `singleTaskPlan` makes the task, as in the eval arm (decision 89: the tier doesn't change the pipeline). The run touches only that task, and running the same request again resumes it. Its review gets the request as typed, the bug exit condition and the bug brief. The request is data in the review prompt and never reaches the protected checks. `.jarvis/plan.json` still needs an approved spec, and `--request` doesn't combine with `--plan`.
- **The eval counts what ran.** A session is a process start the runner recorded at spawn: a build's `attempt_started` with its process group, `review_process_started`, and `eval_session_started` for the planner and the review step. Attempt records, verdicts and preflight refusals aren't sessions. Reviewer tokens are in the usage totals, and the validated plan's tier reaches the eval loop, its reviews and its usage rows, as `jarvis run` has done since 73c63ce.

*From:* the pre-review (`.runs/prereview-s3`), the Codex stage3-fixes lane, and the Opus review, which added repair seeding (the lane had left it out on that reading of 100), made a reviewer's fail stand over a limited fallback, and added the wait ceiling. Its open findings are backlog rows 190 to 194.

### 162. Protected installer runtimes are opaque in the store; the eval arm reviews a design task's design with the calibrated Codex reviewer (new; Oct 31; the Codex stage4-prereqs lane and its Opus cross-family review; settles backlog 180 and the eval half of 184; changes decision 97 for design reviews only; tightens 15, 56 and 156; Fabricio can veto)
- **Installer runtimes are opaque, hashed artifacts.** Reserved for the protected installers: `design-runtime/`, `design-lint/`, `security/` and `desktop/` and their `fixtures/` copies; the installers' own files (`design-review.json`, `design-plan.json`, `design-checks.json`, `fixtures/design-plan.json`, `fixtures/impeccable.json` and the six design `<name>.check.json`); and the runner's axe baseline, `expected/axe-base.json` (decision 125). No reader parses them as check definitions or reads them as text: `readApprovedChecks` reads only the top-level `<name>.check.json` files, within the old limits (256 KiB each, 256 files, 4 MiB). Every byte is in the lock. Hashing streams each file without following links, and refuses symlinks, hard links, special files and anything that changes while it is read. The reserved areas share one bound: 256 MiB a file, 512 MiB in all, 4,096 files, 4,096 folders and 32 levels. Past it the store can't be approved and doesn't verify, so `jarvis doctor`, the gate and `jarvis run` refuse it. The rest of the store is bounded where it is read; an eval's hidden gate holds 126,000 files.
- **The Impeccable installer writes loop-readable definitions.** `impeccable-source`, `impeccable-url` and `design-browser` are now also top-level `<name>.check.json` files, as the lint checks are, so the loop can run them. `design-checks.json` stays the design service's record of what they must have run (156).
- **`jarvis checks install` owns only the architect's files.** It validates and reviews only what isn't reserved. Before and after the review it checks the whole store against the approved lock. It copies the reserved bytes into the new store and checks their hashes before the swap. An authored path may not be a reserved name or anything below one, in any letter case: the default APFS volume folds case, so `Design-Runtime` is `design-runtime`. It must also be printable ASCII, because APFS folds some other letters into ASCII ones (U+017F into `s`). An authored check may not take a protected check's name. Each of these is refused before the review session. An unapproved store that holds only installer files is never approved by an architect install.
- **Design reviews in the eval arm (changes 97 for design only).** Code reviews stay Claude only, under the task-session sandbox. A design review uses the service `jarvis run` composes (156): the pinned Codex `gpt-6-astra` design reviewer in decision 110's jail, material only from the snapshot's committed `DESIGN.md` and `PRODUCT.md` and the approved store, evidence only from the protected definitions, and the calibration record under the runner home (`~/.jarvis/design-calibration.json`, from the round 3 control). Decision 97 kept Codex out because its reads weren't confined. Decision 110 confined them, and the design reviewer reads only its checkout, its screenshots and the capture.
- **The evals repo declares a design task; the runner never infers one.** A golden task with `tasks/<id>/design-lint.json` is a design task. The file gives the lint's file list, the generated token files it leaves out, the axe pin and `designSource` (task 06: "existing", FreeHire's own system; omitted, "new"). It is read before the preflight. A design task is refused before any session when the snapshot's main has no committed `DESIGN.md`, or when the installed gate lacks any of the six protected design checks. Each of its tasks requires those six checks and a design review whatever the plan says. A missing design verdict therefore blocks the task and is never a pass. A task without the file keeps its plan: the service is composed when the branch has `DESIGN.md`, as in `jarvis run`, and nothing is forced.
- **Still missing before task 06 can run.** Task 06's snapshot (`043423f`) has no root `DESIGN.md` or `PRODUCT.md`, and both arms need the same committed references. Nothing installs the Impeccable or `design-browser` checks into an eval run's gate store. Their pins are absolute paths into that store, so the evals repo can't carry them ready-made. Nothing serves the app for the URL scan and the browser capture either (backlog 127). Until both exist, task 06 is refused before any session (backlog 200).

*Why:* backlog 180: the readers and the installers disagreed. The Impeccable engine and the zod copies stopped `jarvis run` from starting, and every architect install after a protected installer failed. Backlog 184: the eval arm had no design reviewer. The review found three more problems. Reserved names were compared case-sensitively on a case-insensitive volume, and nothing below a reserved file was reserved (medium). An authored check could take a protected name, refused only later, when `jarvis run` met duplicate names (low). Design was required whenever the branch had `DESIGN.md`. Task 06's snapshot has none, so it would have finished on code review alone, while a task on a snapshot that has one would block on checks it can't run (medium). Each was fixed tests first, including fault injection: a flipped byte, an extra file, a symlink, a hard link, a FIFO, oversize, count, folder and depth bounds. The store mutations are inline (stage 0–1); the eval ones are in `eval/mutations-design.json` (stage 4). Open findings are backlog rows 200 to 204.
*From:* the Codex `stage4-prereqs` lane (gpt-6-astra); the Opus integrator's cross-family review.

### 164. Task sessions get the gate's pinned Rust, offline and read-only (new; Oct 31; the task 12 worker, golden task 12 for stage 5's proof; the Rust counterpart of 123; tightens 69 and 97; Fabricio can veto; the integrator may renumber)
A desktop task builds a Tauri app: Rust, the Tauri CLI and crates. Sessions and gates run sandboxed with no network, no Rust is on a session's PATH, and the gate sandbox can't read the home folder where rustup puts it. So, as decision 123 did for Go:
- **One fixture, read in place.** jarvis-evals' `scripts/rust-fixture.sh` builds a tree: Rust 1.99.1 for aarch64-apple-darwin (rustup's minimal profile), the Tauri CLI 2.12.3 release binary in its `bin/`, the crates of a Tauri 2 menu-bar template's lockfile (`cargo vendor`, with the 213 crates no macOS build compiles stubbed to their manifest and checksum, 682 MB down to 151 MB), a `cargo-home/config.toml` that sends crates.io to the vendored folder and turns the network off, and `fixture.json` with the versions. The gate reads `hidden/<task>/gate/fixtures/rust` in place; grading extracts the same tree from one xz tar (decision 97). Nothing is unpacked by the runner, so there is no unpack to bound.
- **Trust is the pin.** `config/pins.ts` `RUST_FIXTURES` names, by `<rust>.<target>`, the SHA-256 of the fixture's file listing (every file's SHA-256 and path, as `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256` prints them; jarvis-evals keeps that listing as `hidden/rust-fixture.sha256`). `toolchain/rust.ts` recomputes it before any session (12,683 files), and refuses any added, removed, renamed or changed file, a link or special file anywhere in the tree, a fixture that is a link or is reached through one, a `fixture.json` that doesn't name plain versions, a fixture for another platform, an unpinned version, or a pinned tree missing `cargo`, `rustc`, `cargo-tauri`, its Cargo config or its crates.
- **Cargo works with a read-only CARGO_HOME.** Verified in the gate sandbox: it skips its lock and last-use files. So sessions and the gate both use the fixture's `cargo-home`, read-only, and the build cache is the checkout's own `target/`, which both eval arms now keep out of candidate commits (`EXCLUDE`).
- **Linking goes through the Command Line Tools directly.** `/usr/bin/cc` and rustc's own SDK lookup run xcrun, whose cache is in the per-user temp folder every sandbox refuses (decision 95); it then falls back to `xcodebuild` calls costing seconds each (one crate with C: 76 s, against 6 s with the fix). The session's PATH gets the fixture's `bin`, then `/Library/Developer/CommandLineTools/usr/bin`; `SDKROOT` is the SDK's real path and `DEVELOPER_DIR` the Command Line Tools. These are a toolchain's **system folders**: `SessionToolchain.systemDirs`, accepted by the harness only from a fixed list (the Command Line Tools), as their real, root-owned, not group- or world-writable selves, overlapping nothing sessions write. They are reopened read-only in the settings (`allowRead` and `denyWrite`), so the session's read block (decision 69) can't hide what the session runs from them; whether that block covers `/Library` was not checked live. The toolchain variables a session may get are Go's six plus `CARGO_HOME`, `CARGO_NET_OFFLINE`, `SDKROOT` and `DEVELOPER_DIR`; `RUSTFLAGS`, `RUSTC_WRAPPER` and the rest stay refused.
- **When.** A task whose gate has `fixtures/rust` gets it in every session of both eval arms, whatever the workspace holds (task 12 starts from an empty folder, so there is no `Cargo.toml` to look at). Go and Rust can be given together (`mergeSessionToolchains`; two toolchains setting one variable are refused). Only an absent fixture means none; anything else wrong stops the run before any session, in both arms, with `toolchain: {status: "refused"}` in summary.json. The run records `rustToolchain` in manifest.json and summary.json.
- **`jarvis run` keeps today's behaviour,** as for Go (backlog 139): a production fixture needs a runner-made copy (backlog 210).

*Proof (no model session, Oct 31):* the reference menu-bar app built in the gate's own sandbox policy (home and temp folders read-denied, no network): `cargo tauri build --bundles app --ci --no-sign` in 4 min 11 s leaving `Matches.app` (13 MiB), and its 10 tests passing with loopback on, the fixture readable and not writable; `ring` built its C and assembly offline. Not yet run: a model session on the fixture (both arms get it in the unit tests, through the settings' `allowRead` and `denyWrite`).

### 165. Golden task 12 starts from an empty folder and a recorded FreeHire stand-in, and its checks prove the bundle, not the launch (new; Oct 31; the task 12 worker; follows 18, 34, 102, 118 and 128; Fabricio can veto; the integrator may renumber)
- **"Your API" is a stand-in.** The start (`tasks/12-menubar-matches/start/`, one fixed commit by `scripts/plant-12.sh`) is a README and `freehire-api/`: a dependency-free Node server with FreeHire's own shape at `23d3266` for "my matches", `GET /api/v1/me/tracking/swipe` (the open jobs matching the user's filters they haven't saved or dismissed, newest first; the list envelope; `jobview.Job`; the `posted_within_days` facet; Bearer auth; `{"error"}` errors). Its eight jobs are synthetic; Fabricio's live API and account are never used. Sessions can't bind or reach local ports (decision 69), so the gate and grading start it on `127.0.0.1:8787` with `allowLocalBinding` and set `FREEHIRE_API_URL` and `FREEHIRE_API_KEY`, as its README says the app is configured; sessions test with fakes.
- **The start README names the build machine.** One line: Rust 1.99.1 and the Tauri 2.12 CLI are installed, crates come from a vendored set, and crates.io and npm aren't reachable during builds. Without it a session scaffolds an npm frontend (npm's registry is on the session allowlist) that no gate can build offline, which would grade the environment, not the work.
- **The gate (`unit`) is the project's own suite plus the build:** `cargo test --release` with the stand-in up, then `cargo tauri build --bundles app --ci --no-sign` (no signing identity, no keychain), then an inspector; tests pass and one `.app` is left. Its bundle is `<tauri project>/target/release/bundle/macos/<productName>.app`, the folder the release step's desktop setup names as its build output.
- **Grading (`app`) judges the bundle and two proxies.** One `.app` with `Contents/Info.plist` and `Contents/MacOS`, `CFBundlePackageType` APPL, a reverse-DNS identifier of its own, a name, a version, an arm64 Mach-O executable, its icon and no links; menu-bar only (`LSUIElement` in the bundle, or the accessory activation policy in the source) with a tray icon and no window visible at launch; a passing test named for the API being offline; and a user-facing offline message in the app's own source, not its tests or comments. Launching the app and seeing today's matches is native smoke, still **not run** (decisions 102, 118), so the offline criteria are proxies, gameable by naming, and Fabricio's rating (`rubrics/12-menubar-matches.md`) judges the rest. The architecture's desktop lane has no design checks; none run.
- **The Jarvis arm builds from an approved spec,** as task 02 does: `tasks/12-menubar-matches/spec.md`, seven criteria the gate's `unit` check covers. It stands in for intake's defaults, written by the worker from the golden task's "good looks like"; no intake of task 12 has been rated. The baseline gets only the prompt.
- **Proved on the real gate** with `reference/12-menubar-matches/prove.mjs`: the empty start, a reference app, an app that ignores a failed fetch, and a Dock app (results in the evals repo's reference README).

### 166. The Rust and Tauri pins on this Mac (new; Oct 31; the task 12 worker, with Fabricio's approval of Oct 31 to install Rust and Tauri; Fabricio can veto; the integrator may renumber)
Each is the newest release at least two weeks old on Oct 31, 2026, installed without touching any shell profile (`rustup-init --no-modify-path`):
- **rustup 1.29.1** (Sep 1; 1.29.2 of Oct 21 was too new), `rustup-init` aarch64-apple-darwin SHA-256 `ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a`, in `~/.rustup` and `~/.cargo` (452 MB).
- **Rust 1.99.1** (the stable channel of Oct 15), minimal profile, as default; rustup checked the components against the channel manifest: rustc `23948a0a…10a3`, cargo `685e563d…1eaf`, rust-std `fe79d6ab…1031` (the `.tar.xz` SHA-256s in `channel-rust-stable.toml`).
- **Tauri CLI 2.12.3** (Oct 14; 2.12.4 of Oct 21 was too new), the release's `cargo-tauri-aarch64-apple-darwin.zip`, SHA-256 `35e3b339bfb5f2061023bf5646dc969e5fa53b6fc4347daf467e7f6743692494` (GitHub's asset digest), binary `b2db2125…1686`, in `~/.cargo/bin` and the fixture's `toolchain/bin`. A prebuilt binary, so no 1.5 GB `cargo install` build.
- **Crates:** `tauri` 2.12.4, `tauri-build` 2.7.3, `tauri-plugin-opener` 2.7.2, `tauri-plugin-positioner` 2.4.0, `ureq` 3.4.2, `serde` 1.0.229, `serde_json` 1.0.154, `chrono` 0.4.45, `tokio` 1.53, `anyhow` 1, `thiserror` 2; the transitive set is whatever `cargo generate-lockfile` resolved on Oct 31, fixed by the committed lockfile.
- **The Xcode Command Line Tools** were already installed (26.6, SDK 26.5), and so was Xcode.
### 167. An eval run installs its own design checks, serves the app inside the gate, and records the base revision's axe findings first (new; Nov 1; the Codex stage4-design-gate lane and its Opus cross-family review; settles backlog 200, 201 and the eval half of 127; extends 125, 156 and 162; Fabricio can veto)
- **The QA toolchain has a reserved root.** `qa-toolchain/` and `fixtures/qa-toolchain/` join decision 162's runtime roots: opaque, reserved in any letter case with everything below them, inside the shared runtime bounds, every byte in the lock, carried over by `jarvis checks install`. `installQaToolchain` (`lanes/qa-install.ts`) hashes a source folder within the same bounds (no links, no special files), checks it against the caller's manifest, clones it into `fixtures/qa-toolchain/` with `/bin/cp -cR` (Node's copy if cp fails), hashes the copy again, writes `manifest.json` and returns it with its hash. It never approves. `buildQaToolchainManifest` assembles a manifest from installed Playwright and axe packages against an approved file inventory, reading their exact versions.
- **The evals repo declares a design task's checks.** `tasks/<id>/design-checks.json`, version 1: the QA toolchain's source folder and its manifest's sha256; the Impeccable engine's file, version and sha256; the scanner's files and the page it opens; the flow plan with app-relative URLs; the app's build and serve commands, the path that says it is ready, and a timeout. Paths are relative to the evals repo and may not come from its `hidden/` folder, compared by folder identity so another letter case can't pass. It is read before the preflight and needs `design-lint.json` beside it; the QA manifest's axe version must equal the lint's pin.
- **Installed per run, into that run's store.** After `installHiddenChecks` and the design lint, the runner installs the toolchain and `impeccable-source`, `impeccable-url` and `design-browser` into the run's gate store and approves it as a separate step. Every absolute pin names that store (the engine copy, the QA manifest); nothing in it names the evals repo. Grading is unchanged for both arms: `gradeRun` installs and runs the grading suite as before, and only the Jarvis arm's gate gets these checks.
- **The app is built and served inside the case.** `impeccable-url` and `design-browser` each get one protected case (`lanes/served-design.ts`): it builds with the declared command in the checkout, picks a free loopback port inside the case, starts the serve command with `HOST`, `PORT` and `ORIGIN`, waits at most 30 s for the ready path, scans or captures, and stops the server however it ends. A capture that left the app's origin fails; URLs are then rewritten to `http://127.0.0.1:1` so captures at different ports compare. Those two checks keep local binding (124); `impeccable-source` and every verify phase don't have it. The runner names no pre-existing service.
- **The base revision's axe findings, before any session.** After every other refusal and before the first session, the runner runs the `design-browser` check on the base revision through `runGate` (a fresh clone, the gate sandbox), with its own ledger under `<project>/design-base/`. It checks the stdout against the hash in that gate result, builds the record with `recordWebBaseline`'s rules (incomplete results, a wrong URL or another axe version make none), writes `checks/expected/axe-base.json` and approves the store. A failed or refused base run writes nothing, so axe stays strict (decision 125), and `summary.json` says `designBaseline: "failed"`. The gate's verifier (`lanes/design-gate.ts`) and the design reviewer read the file only from the locked store and make the handle with `recordWebBaseline`; nothing a candidate prints or writes can be the baseline, and a hidden gate that ships the file is refused before any session.
- **The reviewer judges what the gate judged.** A passing `design-browser` capture is verified against that baseline in the design service too (`verifyServedDesign`); without one, strictly. A failing one is shown as captured, and its failure fails the review (124).
- **Gate and grading stay disjoint around the installs (97).** The installed gate is checked whole before the protected installs and again after them. The second check leaves out only the runner's runtime roots (`checkRuntimePath`), since both arms may load byte-identical browser libraries; every definition, plan and expectation the installers write is still compared.
- **Not settled.** Local binding on macOS opens every local port, so a candidate's build or server in these cases can reach services already listening on this Mac, Tor's SOCKS port among them (backlog 215). The evals repo's side of task 06 isn't written (216). Each gated revision builds the app twice (217). `jarvis run` has none of this yet (218). A failed base capture is reported, not refused (219).

*Why:* backlog 200, 201 and 127: task 06 was refused before any session because no eval run could get the Impeccable and browser checks or a served app. The review found that the design service re-verified a passing capture strictly, so a candidate that kept the base's own findings (FreeHire's `/jobs` has 7 contrast nodes) passed its gate and still got a design review error, and task 06 could never get a verdict (medium). The lane had dropped the disjointness check after the installs to let the libraries match (medium). A hidden gate could supply the baseline on the path where it carries its own design definitions, design inputs could come from `hidden/`, `design-checks.json` could stand without `design-lint.json`, the base was built before cheaper refusals, and the stored record held its stdout twice (all low). Each was fixed tests first and seen failing. The store mutations are inline (stage 0–1); the eval, lane and review ones are in `eval/mutations-design.json`, `lanes/mutations-eval-design.json` and `review/mutations-design.json` (stage 4). Open findings are backlog rows 215 to 219.
*From:* the Codex `stage4-design-gate` lane; the Opus integrator's cross-family review.

### 174. A desktop project's release ends at "built, not distributed": a locked build plan, a verified bundle under project state, no provider, no token, no launch (new; Nov 1; the Codex s5-desktop lane and its Claude cross-family review; answers the stage 5 pre-review's finding 4; extends 157 for desktop; follows 34, 102, 118 and 128; Fabricio can veto)
- **The setup names a desktop app, nothing to deploy to.** `jarvis release configure --kind desktop --app-name <name> --bundle <path>.app --build <command> --output <folder>` writes a `release.json` of kind `desktop` (version, app name, the `.app` path inside the build output, the build command, output and timeout; strict: no provider, site, plan, origin, data source or Render destination is accepted) and installs the desktop build plan into the project's checks store (`checks/desktop/plan.json` and the runner's own build worker and verifier, as `installDesktopChecks` lays them out), then approves the store with the reason "jarvis release configure: approved desktop build plan and verifier". Configure is the approval boundary and approves only what it derived from the typed options: it refuses when an approved check changed, when the store has files that were never approved, and when a desktop plan is already installed and differs. `prepareRelease` returns a desktop runtime with no provider config, no CLI check and an empty adapter list, so the broker keeps the stage 1 outbox for every deploy operation and the step never asks for one.
- **The build is the gate's.** After every planned task is done and the run branch head is the revision the runner last promoted (157's checks, unchanged), `runDesktopRelease` verifies the store, checks that the installed plan equals the plan derived from the setup, and runs `runDesktop`: the `desktop-build` check in the gate sandbox (candidate code reads the checkout and the fixtures, not the runner home; no network; the worker forwards the runner's environment allowlist and sets Cargo, npm and Yarn offline), its verifier outside the candidate sandbox, and the bundle captured from the checkout only after the gate passed, through `runGate`'s cleanup seam (the scratch folder outlives the result until the capture is done, then `removeRunDir`). The plan's binaries are the runner's own Node by absolute path (`pinnedProviderNode`) and `/bin/sh` for the protected command; tool selection is the command's, so on this Mac a Tauri build still needs the pinned Rust fixture in the release store (backlog 210, open), and `runDesktop`'s "Tauri unavailable" answer is replaced by the worker's own observation ("not run: desktop build needs network", or a failed build).
- **The deliverable survives in project state, bound by three hashes.** The captured bundle is copied (decision 128's materialize limits, from the capture, never from the checkout) into `<project>/artifacts/desktop-<random>/<bundle name>`, a folder the step makes 0700 and checks as runner-owned (a link, another owner or group or world write stops the step). The copy's per-file hashes must equal the capture's; then the ledger gets a `release.desktop-artifact` decision with the project, its real path, the revision, the build gate's seq and evidence, `artifactDigest` (file contents) and a metadata hash (every path, mode and folder, links refused). The build's cleanup never touches it, and it is kept even when a later required check fails on the revision: a verified build is evidence, only "built" is withheld. Every approved protected check is then rerun on the release revision with no task, as 157's web step does.
- **"built" is a release state like preview-ready: recorded once, rechecked at every render.** `state_reached {state: "built"}` carries the revision, the artifact seq, the build seq, the gate seqs and the required check names. `missingDesktopEvidence` recomputes, from the ledger and the disk, what it lacks now: tasks (every planned task done and the revision the last promotion), checks (the latest runner gate for every required name and every observed name at that revision is in the recorded set, passed, under the current approved lock, with intact evidence; task gates don't count), artifact (the record's binding to revision, project and build; the path is exactly two levels under the project's `artifacts` folder and is its own real path; both hashes still match; the build gate is a passing `desktop-build` at the revision with intact evidence). Anything missing lapses the state, and `jarvis release show`, REPORT.md and the phone summary then say `not-reached` with `Lapsed: built (artifact)` and so on. While it holds they say "built, not distributed", the bundle path, its SHA-256 and "Native smoke: not run (input isolation is unavailable (decisions 102 and 118))": distribution needs the paid Apple program (34), and launching the app needs an input-isolated launcher (102, 118).
- **Proof with fakes.** `tests/unit/release-desktop.test.ts` (17 cases: schema refusals, configure's approvals and refusals, a built release with every rerun check, ten refusals of built, six render-time lapses) and `tests/integration/e2e-release-desktop.test.ts` (two `jarvis run`s through `prepareProductionRun` with fake-claude, the real hosted broker and the real gate sandbox; the build is a shell script that leaves a minimal `.app`): the run reaches built, the bundle survives cleanup with the recorded hash, a tampered bundle lapses it, a failed release check keeps it from built, and no deploy adapter is called. `release/mutations-desktop.json`, 17 definitions, stage 5. No Rust, Tauri or model session ran: that is golden task 12's live proof, which waits for backlog 210.

*Why:* the stage 5 pre-review's finding 4: `runDesktop` had no production caller, its copied bundle died in `finally`, and nothing said "built, not distributed". The cross-family review added configure's refusal of never-approved stores (an empty-lock store would have approved any file lying in `checks/`), moved the artifact root's trust check into the recorded stop path, made a link above the bundle path lapse built, and replaced the e2e's mocked sandbox and broker with the real ones; the lane's own ten refusals and five lapses were kept. Open: backlog 240 to 244.
*From:* the Codex `s5-desktop` lane (gpt-6-astra); the Claude cross-family review and port.

### 147. The Goldfish plan review waits until after v1; the five wiring fixes go first (new; Oct 28; Fabricio; defers Part B of docs/ideas/handoff-egm.md)
- **Deferred:** the fresh-context plan review before the build loop, required alternatives on engineering decisions and the contest/fix/escalate/decline protocol (docs/ideas/egm-gap-analysis.md, docs/ideas/handoff-egm.md Part B). It is new scope that no stage proof in architecture §8 needs, and as designed it refuses every feature run until a live negative control passes, which would block the stage 3 to 5 proofs. It is backlog 164; its decisions take the next free numbers when it starts.
- **Kept:** Part A of the handoff, the wiring the first live runs showed missing: review findings reach the repair prompt; the review and build tier come from the plan; `installChecks` has a CLI caller; medium and low findings reach REPORT.md; a reviewer reports what it checked. Each is a Codex lane with tests and mutations, reviewed cross-family before merge (decision 82).
- **Order after that:** the stage proofs in §8, closest to passing first: stage 3 (tasks 02, 04, 05 and the held-out 13 from one frozen revision, decision 116), stages 0 and 1 (round 21, `--confirm-stage 0-1`), stage 2's round 3 judge, then 4 to 7.
- **Note for the deferred work:** golden tasks plan through `eval/jarvis.ts` `runPlanner`, not `prepareProductionRun`, so a plan gate needs both callers.

*From:* Fabricio, Oct 28 ("Yes and yes" to deferring Goldfish and launching the lanes); the integrator's check of the handoff's claims against the code at 21003f6.
### 157. The run's release step: preview-ready from runner-owned state, production gated (new; Oct 31; the stage 5 wiring worker, from the read-only Codex pre-review's findings 2, 3 and 5; extends 44 and 12; Fabricio can veto; the integrator may renumber)
The release library existed, but nothing called it. Now `jarvis run` releases, under these rules:
- **When.** Only a default plan run (never `--plan review|onboard|sweep` or `--request`, decision 160's bug runs), only once the loop finished with every task done, and only when the project has a protected release setup. Without one, the broker keeps the stage 1 outbox for every operation, so evals and older projects behave as before.
- **The protected setup** is `~/.jarvis/projects/<id>/release.json`, written only by `jarvis release configure` (owner-only, no symlink, refused if invalid). It names the provider, the account's plan, the site (and Vercel's account id), the live production origin, the build command and its output folder, and an optional data snapshot source. Nothing in it comes from a session or a manifest. The roots are fixed by the runner: build outputs under `~/.jarvis-work/release/<id>/artifacts`, deploy copies and snapshots under the project folder.
- **Spend policy.** The setup accepts only each provider's free plan (Vercel Hobby, Netlify Free; decision 33), and the release step checks it again, so a preview costs nothing. The step itself asks the broker for `deploy.preview` and nothing else; `spend`, `service.add_paid` and `domain.buy` still need an exact-payload approval.
- **The revision** is the run branch head, which must be the revision the runner last promoted, with every planned task done.
- **The provider CLI** is pinned in `config/pins.ts` (`PROVIDER_CLI_PINS`, empty until a provider is chosen) at `pinnedProviderBin`. It is verified when the broker is hosted, before the ship session, and again right before the deploy: the exact version, read with the adapters' own command environment; a regular executable that only Fabricio or root can change; not inside the repo, the worktrees or the work root. The adapters get its real path.
- **The ship step** is one fresh session in a fresh checkout of the revision, with the ship skill as text (decision 114). The runner reads only `.jarvis/release/manifest.json` (bounded, never through a link) and keeps only what a session may claim: smoke paths, migrations, rollback steps, the data kind and its commands. Anything else the session changed is discarded and named in the step's outcome.
- **The fixed-revision build** runs the setup's command on a fresh clone of the revision in the sandbox a gate case gets (no network, no credentials, the runner home unreadable). The output folder must be a real folder in the checkout; it is copied out with the bundle copier (decision 128) and its digest recorded as a runner `release.artifact` entry, the only binding of an artifact to a revision.
- **Acceptance.** The manifest takes the project, revision, provider, site, origin, artifact folder and hash from the runner, and a data source only as the runner's fresh private copy of the configured snapshot; `checkManifest` then checks it against the setup. It is recorded as a runner `release.manifest-accepted` entry, and only those entries resolve a release ref (the deploy adapters, the report, `jarvis release grant`).
- **Every approved protected check** runs again on the release revision, bound to no task (`GateInput.taskId` may be null), before anything deploys.
- **The preview** goes through the run's hosted broker, whose deploy adapters replace the outbox for `deploy.preview` and `deploy.promote`. The smoke test (`runSmoke`) checks the broker-reported URL; a failure notifies and stops. Then preview-ready is recorded.
- **Readiness is complete against the required set** (pre-review finding 5), not the observed one: every task the runner created is done, its required gates and reviews passed at its candidate revision with intact files; the manifest's revision is the last one the runner promoted; and there is a passing result, under the approved lock, for every check the plan requires and every name the release step gives from the approved store. Those names are recorded with the state, so every recheck requires them again. No plan means no required set, so nothing is ready.
- **Production stays gated.** The step never asks for `deploy.promote`. The adapter refuses one without a grant bound to this exact manifest; an approved exact payload is not that grant. `jarvis release grant <manifest-hash> [--allow-rollback]` shows the accepted manifest and the rollback scope, then asks `[y/N]` (or takes `--yes` without a TTY), like `jarvis approve` (decision 130). With a grant, promotion still needs release-ready, which the runner doesn't run yet (rehearsal, restore, promotion and recovery: backlog 185), and deployed still needs the failure-signal check.
- **A stop is never a run failure.** Each outcome is a runner `release.step` entry; REPORT.md shows the latest one.

*From:* the read-only Codex pre-review of stage 5 (`prereview-s5`, findings 2, 3 and 5); release/integration.md's evidence sequence; decisions 12, 33, 44, 49, 76, 114, 128.
### 158. Reports and notifications recheck release evidence every time (new; Oct 31; the stage 5 wiring worker, from pre-review finding 6; extends 44 and 19; the integrator may renumber)
REPORT.md and every notifier summary state a release state only if its evidence still holds when they are rendered. Each recorded `state_reached` release state, newest first, is rechecked against the ledger as it is now: its manifest must be a runner-accepted one, and `missingEvidence` must find nothing missing. So a later failed smoke test of the same preview, an evidence file edited or removed, a planned task that is no longer done, or a newer promotion un-readies it. The report then says `State: not-reached` and names the lapsed state and what it lacks. A state that holds is shown with its broker-reported preview URL and whether a production grant is bound to its manifest, with the `jarvis release grant` command when none is; the phone summary carries the state, the URL and "production gated (no grant)".

*From:* the pre-review's finding 6 (a read-only run of the selector confirmed a later failed smoke still selected preview-ready).
### 159. Deploy tokens: a preview token and a production token per provider, both broker-only (new; Oct 31; the stage 5 wiring worker, from pre-review finding 3; tightens 12 and 43; supersedes setup's single `VERCEL_TOKEN`/`NETLIFY_AUTH_TOKEN`; the integrator may renumber)
- **The contradiction.** Setup stored one account token as `VERCEL_TOKEN` or `NETLIFY_AUTH_TOKEN`, in `house-stack.accounts.env`, which no broker read; the deploy adapters asked for `<PROVIDER>_PREVIEW_TOKEN` and `<PROVIDER>_PRODUCTION_TOKEN` from the project's own file. Decision 12 wants a preview-only token, and decision 43 wants tokens scoped to previews where the provider allows it, with production tokens only in the broker.
- **The contract.** The adapters' names stand, because they keep the tier split: `deploy.preview` reads `<PROVIDER>_PREVIEW_TOKEN`, and `deploy.promote` (production, its inspection, rollback) reads `<PROVIDER>_PRODUCTION_TOKEN`, with no fallback from one to the other (the ship skill's gotcha). `jarvis setup` asks for both. Neither Vercel nor Netlify can limit a token to previews, so both are broker-only; two tokens still let the preview one be revoked or rotated without touching production.
- **Where the broker finds them.** The hosted broker reads the project's `<id>.env` first, then the house-stack accounts file, both owner-only (a file anyone else can read refuses the broker and the run). The legacy names are never read: an older setup re-stores with `jarvis setup --redo accounts.deploy`.
- **Not a weaker boundary.** No token reaches a session, a build, a check, the ledger, a report or a notification; only the adapter's child environment gets the one its operation needs (the provider CLI's own variable, `VERCEL_TOKEN` or `NETLIFY_AUTH_TOKEN`).

*From:* the pre-review's finding 3; decisions 12, 13, 43; `skills/ship/SKILL.md`'s gotchas.
### 133. Tests run the real git binary, not the xcrun shim (new; Oct 26; superseded by 137; retained below as historical rationale)
- **Why:** on macOS `/usr/bin/git` is a shim that looks up the developer directory and then runs the git inside it. A spawn through it costs about 22 ms of CPU, against about 8 ms for the same `git rev-parse` run directly. The unit suite started about 7,000 of them per run (about a quarter of its 415 CPU-seconds), and the mutation check runs that suite once per mutation.
- **What:** `tests/setup/real-git-global.ts` finds the binary the shim would run (`DEVELOPER_DIR`, else `xcode-select -p`) once per run. `tests/setup/use-real-git.ts` makes each test process start it in place of a bare `git` (no shell) whose PATH search would find `/usr/bin/git`, with the same arguments, working folder and environment, plus the four variables the shim adds (`CPATH`, `LIBRARY_PATH`, `MANPATH`, `SDKROOT`), which only processes git itself starts can see. The global setup reads those by asking both binaries for their environment, and turns the redirect off if the two differ in any other way, if there is no developer directory, or off macOS.
- **What it leaves alone:** an absolute `/usr/bin/git` (`scripts/review-run.mjs` and its test), a different `git` first on PATH, a spawn with a shell, child Node processes, and every line of production code: `safeGit`, the probe and the snapshot still ask for `git`; only the test process's `child_process` is wrapped. No test is about which git binary runs. The one visible difference is the text of a failed git's error, which names the binary's path.
- **Pinned by `tests/unit/real-git-redirect.test.ts`:** what is and isn't redirected, that git and the processes it starts see the same environment either way, and that a caller's own variable wins. Each of four breakages of the redirect fails it.
- **The live canary and the gate are unaffected:** the redirect exists only in Vitest's setup files; `jarvis doctor`, the probe and real task sessions run exactly the git they ran before.

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
| Accessibility | axe-core: zero serious issues (on an app that already has some, none the change adds, decision 125); keyboard and focus checks | WCAG 2.2 AA problems |
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


### 112. Publish the development repository before v1 is complete (Oct 25, 2026; Fabricio; supersedes the private-until-stage-7 restriction in decision 36)

Fabricio explicitly requested a public GitHub repository and a README for recruiters and engineers, as part of his software engineering and AI engineering portfolio. Publication is authorized before stage 7. It does not approve unfinished stages or declare v1 complete.

The public README describes the implemented components, incomplete proofs, installation requirements and evaluation limits. Do not claim a general benchmark win or equal-compute comparison. Preserve the existing development history after reviewing its secret-scan findings. The personal evaluation repository, local account credentials and notification settings remain private.

The initial public repository is `rodriguezzfabricio/jarvis`, with the existing MIT license and adapted-skill credits.


### 136. Integration helpers need a lifetime independent of a terminal turn (Oct 26, 2026; takeover integrator; extends 84)
The first takeover turn ended while four Codex helpers were working. Their processes ended too; none produced a completed verifier verdict. A saved PID or partial audit is not proof that a worker is running or finished.
- Launch long-lived integration helpers through the local service manager, with persistent logs and explicit exit records; do not rely on a child of a turn surviving that turn.
- Verify the job identity and parent process, then verify survival from a later turn before relying on cross-turn persistence. Until verified, keep the integrator turn open while work is active.
- A builder clone has its own frozen-lockfile dependency installation, including workspace package links. Linking node_modules to a read-only checkout blocks Vitest's cache and API-token writes; startup refusal is not a failing test of product behavior.
- Preserve interrupted work and completed command evidence. Restart verifiers as fresh ephemeral sessions with memory disabled, supplied only requirements, revisions and raw evidence; partial prior opinions are not verdicts.
This changes integration operations only. Task-session confinement, stage proofs and review gates are unchanged.

Operational check for decision 136: legacy `launchctl submit` enables keepalive. Use an explicit job plist with `RunAtLoad: true` and `KeepAlive: false`; verify loaded properties so completion cannot silently start another builder. Changing a running submit job’s next invocation with `launchctl debug` requires root and was refused. Do not escalate. For those existing jobs only, a one-shot completion monitor retires each owned job when its explicit exit record or terminal turn event appears; future jobs use the explicit one-shot plist.


### 138. A proof chain stops on an explicit guarded-stop result even when the CLI exits zero (Oct 26, 2026; takeover integrator)
A proof-chain log recorded a usage-guard STOPPED result with exit zero, after which its shell script attempted the next arm. Shell exit status alone therefore does not establish completion of an eval command.
- Host proof scripts stop the chain on a nonzero process exit or an explicit STOPPED result. They preserve both the original output and the stop reason; a guarded stop never triggers a later arm or a retry that bypasses the guard.
- Check the authorized start time, the evidence slot and the existing disk floor immediately before dispatch. Keep the proof's frozen product revision unchanged.
- Verify orchestration with local fake commands and fresh-copy negative controls before using the script for real runs. No test invokes a real model or changes a usage limit.
This changes host orchestration only, not eval grading, the usage guard or the frozen proof checkout.


### 137. Test processes keep native Node execution semantics (Oct 26; suite-speed repair; supersedes 133)

Independent host observations against 6ac5c097 contradict decision 133's equivalence and coverage claims: relative PATH entries used the parent cwd, cached lookups missed a newly created earlier executable, and the shim modified caller CPATH/LIBRARY_PATH/MANPATH differently. Version-string tests missed disabled API redirects; failed discovery skipped coverage. The in-process decision-command harness also hid an uncaught parse error that the base subprocess test rejected. These observations are not final independent approval.

- Remove global child_process interception and binary discovery. Keep inert compatibility context/exports for existing snapshot workers until their callers are removed together; all commands use Node's native argv, env, cwd and PATH behavior. No test coverage depends on discovering a developer directory. This supersedes every operational and equivalence claim in 133, including its four-breakage coverage claim.
- Keep repository-template copies and fixture-local compile caching, with native execution and file/mode/content equivalence checks. Production safeGit still runs through its original path and must reject planted hooks, fsmonitor and global configuration. No comparable speed improvement is claimed by this repair.
- Restore subprocess decision-command tests so expected Commander diagnostics and uncaught product errors remain distinguishable. Preserve base assertions and prove error controls fail when the expected handling is removed.
- Restore the base broker readiness/test limits (5/15 seconds) and desktop readiness/lifetime limits (3 seconds). A loaded-machine explanation alone does not justify increasing them.
- The AGENTS.md setup description and snapshot worker's redirect comment are superseded by this decision; their owners should update those descriptions. This lane cannot edit them. Full-suite, mutation and real Seatbelt evidence remain the integrator's responsibility.


### 140. A quiet slot drains already-started lane checks before host evidence (Oct 26; takeover integrator; extends 81 and 104)

A lane checking the slot before a test command does not stop a command that began just before the host acquired it. The host must acquire its own slot atomically and let already-running owned lane checks finish before starting evidence. Read only owned helper PID/parent/executable metadata for that drain; never process arguments or environments. No unrelated process is stopped. If the drain cannot establish quiet, preparation fails instead of accepting contended timeout evidence. Lanes retain their before-each-command slot checks, and stage-review evidence retains its exclusive evidence slot for the whole phase.

### 142. Native test-probe infrastructure failures remain infrastructure failures (new; Oct 26; Codex)
The native-process helper currently turns a child spawn error into an assertion about an undefined error. Fresh suite logs show ETIMEDOUT in that assertion, while the mutation classifier accepts completed assertion failures unless its timeout matcher recognizes them. A helper failure must not become apparent behavioral evidence.
- Preserve child spawn errors, signal termination and nonzero probe exits as infrastructure failures with their diagnostics. Keep behavioral comparison assertions, case coverage and deadlines unchanged.
- Tests must use the real classifier to distinguish these failures from actual comparison failures. Do not weaken the classifier or count an incomplete reproduction as proof.

### 143. A slot handoff must let an already-started fake proof finish (new; Oct 26; Codex; clarifies 140)
A fake-proof process can pause between cases when quiet-slot appears. Holding the slot while waiting for that process to exit then cannot drain it. Before evidence begins, the integrator may pause only its own preparation process, verify no evidence command has started, release only its own exact slot token, let the existing checks finish, and atomically reacquire the slot before resuming preparation. A running evidence phase is never released this way. Interrupted or expired preparation is unverified, not test evidence. Schedule whole proof invocations before slot acquisition to avoid this cycle; retain the quiet-machine requirement and all gates.

### 145. Diagnose Git launcher UI without changing the owner toolchain (new; Oct 26; Fabricio report; Codex investigation)
Fabricio reported repeated macOS command-line-tools installer dialogs during verification and supplied the installed Xcode Git path. Read-only inspection confirms the executable exists and the selected developer directory is Xcode; a direct clone with that executable succeeds. Test sources include bare Git lookup through `/usr/bin:/bin`, explicit `/usr/bin/git`, and deliberately altered caller variables. These facts identify launcher call paths, but do not yet establish which host condition caused each dialog.
The test harness must not depend on installer UI or silently treat unavailable Git as successful behavioral coverage. Diagnose and correct the narrow call path with tests first; preserve native lookup, arguments, environment, failure visibility and safety checks. Do not install tools, change the global developer selection, intercept process APIs globally or weaken mutation gates to suppress the symptom. Any corrected candidate requires independent exact-revision verification; prior evidence remains bound to its original revision.

### 146. Missing expected failures in tests are assertion failures, not worker infrastructure (new; Oct 26; Codex verification)
A fresh guard-removal experiment reached a test helper that threw a plain Error when the operation unexpectedly succeeded. The mutation classifier correctly refused that as infrastructure, so the experiment did not establish a caught safeguard. A test expecting rejection must assert when rejection is absent; actual worker spawn, signal, nonzero-exit and malformed-output failures remain infrastructure under decision142. Correct only the test expectation boundary, preserve diagnostics, and reproduce the distinction with the unchanged real classifier. No mutation or classifier rule is weakened.

### 153. The gate's suite waits on child processes and device flushes; no single file sets its wall time (new; Oct 31; the suite-speed worker's measurements on main 9ffe580; refines 92's "splitting the longest test files is the lever"; the worker-count part is a proposal the integrator or Fabricio decides)
- **What a confirm verdict runs:** `vitest run tests/unit` without the `*-mutations` files (`runSuite` in `scripts/mutation-check.mjs`): 239 files, 3,776 tests (3,768 pass, 8 skipped). `tests/integration` and `tests/fault` (7 files), the 9 `*-mutations` anchor tests and the 4 opt-in live tests run only in `pnpm test`, and `e2e.test.ts` alone takes 104–149 s there. A mutation verdict never waits for them, so `pnpm test`'s wall time (235 s against 204 s for the gate's suite, at the same load 20 minutes apart) overstates a verdict's cost.
- **Measured on this Mac (M1: 4 performance and 4 efficiency cores, 16 GB):** the gate's suite took 147.6 s wall and 392 CPU-s at load average 2.9 (the eval chain was in a model session), and 204–324 s with another worker's suite or the eval chain running at the same time. Its own processes keep 1.4 to 3.6 of the 8 cores busy on average, so it isn't CPU-bound.
- **No file is the critical path:** about 7 files are in flight until the last 5–24 s of a run, and the longest file takes 32–35 s (71 s on the most loaded run). The wall time is about (the summed file time plus about 0.4 s to start each file's worker) / 7 workers. Splitting a file no longer shortens a verdict; it only adds one worker start.
- **What the file time is spent on** (per-call timing of one run, 1,469 s of summed file time): child processes 60% (9,335 per run; git 7,916 of them, 37%; 5,651 of those come from product code, 3,133 from `runner/worktrees.ts` alone), `fsyncSync` 15% (25,575 calls, 24,447 from the ledger: a lock claim, the line, the head and its folder for every append), `rmSync` 8%, other writes, renames and links 7%. The tests' own JavaScript is under 1% (CPU profile of `runner-loop-6`).
- **Two Mac costs behind those numbers:** `git` on the runner's `PATH=/usr/bin:/bin` is the xcrun shim (10.7 ms per call against 5.0 ms for the git it starts). Node's `fsyncSync` on macOS issues `F_FULLFSYNC`, a full device flush: 9.3 ms per call on this Mac against 0.9 ms for plain `fsync(2)`, and flushes don't scale (382 per second with 7 writers, 18 ms each).
- **`JARVIS_MUTATION_JOBS` > 1 can't add throughput as written:** `jobPlan` splits the same cpus − 1 = 7 workers (2 jobs × 3, 3 jobs × 2), and one suite already keeps about 7 files in flight, so the total number of files in flight doesn't change. The verdict experiment (jobs 1 vs 2 vs 3 on a sample) wasn't run: the stage 3b eval chain was live (decision 140's quiet slot).
- **A mutated run costs what the control does:** a 5-mutation confirm sample (stages 0–1, 2, 3 and 4; all caught by assertions) took 18 m 59 s for the control and 5 verdicts at load average 7–9, so 176–199 s per suite. That gives these estimates at `JARVIS_MUTATION_JOBS=1`: 148 s per verdict on a quiet Mac, so `--confirm-stage 0-1` (413 mutations on 9ffe580) is about 17 hours and `--confirm` (2,115) is about 87 hours. At today's background load (about 190 s per verdict) those become 22 and 112 hours.
- **Proposed, not done:** more files in flight than 7 is the remaining concurrency lever, since the suite mostly waits. That changes the load every test runs under (decision 81, rule 3; decision 137's timing limits), so it needs a quiet-Mac experiment first (backlog 175).
*From:* the suite-speed worker, Oct 31: Vitest JSON reports and `/usr/bin/time` for six gate-equivalent runs, per-call timing of child processes and sync filesystem calls in the test workers, a CPU profile, and fsync and git micro-benchmarks.

### 154. The gate's test workers keep fsync's checks but skip the device flush (adopted; Fabricio, Oct 31: "Yes"; proposed Oct 31 by the suite-speed worker; narrows decision 137's native-semantics rule for one call)
- **What:** a Vitest setup file replaces `fs.fsyncSync` and `fs.fdatasyncSync` in test workers with a function that throws whatever native fsync throws for that descriptor: `fstatSync(fd)` gives EBADF for a closed descriptor and the same argument errors for a non-number or a negative number; a pipe or a socket throws EINVAL, as native fsync does. Then it calls `syncBuiltinESMExports()`. Nothing else changes: not product code, not the processes the tests start, and not the live canary, `jarvis doctor` or real runs. Those keep `F_FULLFSYNC`.
- **Measured** (an uncommitted experiment, back to back under the quiet slot): the gate-equivalent suite took 203.7 s → 166.6 s (−18%), and the summed file time went from 1,277 s to 1,013 s (−21%), while the eval chain loaded the Mac more during the second run. Every one of the 3,776 tests had the same id and status. Ledger-heavy files gained most: `runner-report` 10.6 → 1.0 s, `release-manifest` 10.6 → 1.4 s, `runner-loop-7` 35 → 18 s. Applied to decision 153's estimates, that is about 14 hours for `--confirm-stage 0-1` and about 71 hours for `--confirm` on a quiet Mac. This is one pair of runs, so repeat it before relying on the number.
- **What a unit test can't see either way:** durability, which only a power cut shows. The one fsync mutation ("decisions omit directory fsync") is caught through the store's injected `sync` spy, which records its call before calling `fsyncSync`. A mutation that syncs the wrong or a closed descriptor still throws.
- **The case against:** decision 137 reverted a global `child_process` wrapper whose behavior drifted from native in ways nobody had listed. Here the surface is one call whose only results in a test process are success or an error, and the replacement keeps those errors. What remains different is a device error raised by the flush itself (EIO), which no test injects.
- **Bar for adopting it:** tests first (the replacement throws exactly as native does for a file, a folder, a pipe, a closed descriptor, a string and −1; it is installed in every worker; each check fails when its part of the replacement is removed); a clean control with identical test ids and skips with it on and off; identical verdicts with it on and off on a confirm sample; and a line in `docs/harness-assumptions.md`.
- **Built as (Oct 31, lane `nosync-154`):** `tests/setup/nosync.ts` (registered in `vitest.config.ts` `setupFiles`, after `real-git.ts`) and `tests/setup/nosync-fsync.ts`. `fstatSync` alone doesn't reproduce native's errors for a pipe or a socket, so the replacement skips the flush in exactly one case, an open regular file or folder, and hands every other call to the native function, which then throws what it throws: a closed descriptor (EBADF), an anonymous pipe or a socket (EINVAL), a string or a negative number (its argument errors). A named pipe opened read-only returns without error natively on this Mac, so the replacement returns for it too. `tests/unit/setup-nosync.test.ts` compares 17 argument kinds for both functions with native taken from a child process that never loaded the setup file (a second child loads it, with an anonymous pipe as stdin); `tests/unit/setup-nosync-mutations.json` (14 definitions, stage 0-1) removes each part of the replacement. Async `fs.fsync`, `fs.fdatasync` and `FileHandle.sync` are not replaced: nothing in `packages/cli/src` calls them (every sync in product code is `fsyncSync`), so there is no surface for them to speed up.
*From:* the suite-speed worker, Oct 31 (decision 153's measurements).

### 173. A release build gets its Node dependencies from a separate sandboxed step: pinned npm or pnpm, a committed registry-only lockfile, scripts off, the registry as the only host, and the build after it offline (new; Nov 1; the Codex release-deps-188 lane and its Fable cross-family review; settles backlog 188 and the release half of 140; extends 157 and 69; the Node counterpart of 123 and 164; Fabricio can veto)
- **What:** before the fixed-revision build (decision 157), the runner installs a Node project's dependencies on the fresh checkout, inside the same sandbox the build gets, as a step of its own. The project must declare `packageManager` as `npm@<exact>` or `pnpm@<exact>` and commit the matching lockfile (`package-lock.json` v2 or v3 for `npm ci`, `pnpm-lock.yaml` v9 for `pnpm install --frozen-lockfile`); the declared version must equal the runner's pin. The lockfile is checked before any process starts: every entry resolves to the canonical `https://registry.npmjs.org/<name>/-/<base>-<version>.tgz` with a sha256 or sha512 integrity; git, file, link, tarball-URL, other-registry and bundled entries are refused, as are a manifest and lockfile that disagree, a committed `node_modules`, project package-manager configuration (`.npmrc`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, `npm-shrinkwrap.json`, the other manager's lockfile, `package.json`'s `pnpm`, `workspaces`, `overrides`, `resolutions`, `devEngines`, `config` and any `engines` key but node, npm and pnpm), YAML anchors and aliases, and pnpm's built-in `@jsr` scope. Names follow npm's own rule (lowercase, never starting with `.` or `_`), so no lock path can name a dot segment.
- **How it runs:** the pinned Node (`config/pins.ts` `pinnedDependencyTools`: Homebrew's node@24 24.21.0, its npm 11.19.0, pnpm 11.7.0 from Corepack's cache; absolute paths, never PATH, `npx` or Corepack's launcher) starts a runner-owned worker copied into the scratch folder, which runs `<node> <npm-cli.js|pnpm.mjs> --version` and compares before `npm ci --ignore-scripts --no-audit --no-fund --include=dev --include=optional` or `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.manage-package-manager-versions=false --config.package-manager-strict-version=true --config.side-effects-cache=false --store-dir <cache>`. The environment is the step's own: `PATH=/usr/bin:/bin`, a private empty HOME, TMPDIR and cache under the scratch folder, `npm_config_userconfig=/dev/null`, an empty read-only global npmrc, `npm_config_registry=https://registry.npmjs.org/`, `npm_config_ignore_scripts=true`, `COREPACK_ENABLE_NETWORK=0`, and nothing from the runner's environment; no token exists for it. The sandbox policy is the build's (runner home and the user's home unreadable, writes only to the checkout and the step's own folders) plus the pinned tool roots read-only, `allowedDomains: ["registry.npmjs.org"]`, no loopback, no Unix sockets. The build that follows keeps the build's policy with no domain and `npm_config_offline=true`.
- **Bounds:** 300 s, 4 MiB of output, 1 GiB and 100,000 entries across `node_modules`, the private home and the cache, measured by the worker every 100 ms and at the end, and a symlink that leaves those roots or a special file stops it. These are monitored limits, not filesystem quotas. A caller can lower them, never raise them.
- **Failures:** any refusal, limit or non-zero exit throws before the build; `buildRelease` records one `release.dependencies` entry (pass with the lock hash and evidence hashes, or fail with the reason and the evidence folder) and returns `fail`; the release step records its one `stopped:` line (run.ts), which REPORT.md shows. No artifact is ever registered after a failed install.
- **Scripts stay off for native packages.** Read in the lane: esbuild 0.27 resolves `@esbuild/darwin-arm64` directly, with its postinstall only validating and downloading a fallback; Rolldown declares a script-free darwin-arm64 optional package. These are source findings, not a clean-install proof (backlog 236). If a required package turns out to need a postinstall, the fix is a separately reviewed, pinned preparation step inside the sandbox, not lifecycle scripts.
- **Why a separate step and not the build with network:** the build runs candidate code; giving it a host would let that code reach the registry with the build's inputs. The install runs the runner's pinned tools on reviewed inputs, and the only candidate-controlled bytes it reads are the manifest and lockfile already checked. Why pinned tools and not Corepack: Corepack downloads whatever `packageManager` declares; the step refuses anything but its pin.
- **Not proven yet:** no real `npm ci` or `pnpm install` has run through the sandbox's allowlist (every test fakes the package manager and a registry seam; the sandbox runtime does export `HTTP_PROXY`/`HTTPS_PROXY` to the sandboxed command, which npm and pnpm honor): backlog 235. npm aliases (`npm:<name>@<range>`) are refused although they resolve to the registry: backlog 237. The pnpm pin is a Corepack cache copy without a hash: backlog 238.
- **Built as (Nov 1, lane `release-deps-188`, reviewed and ported by the Fable worker):** `release/deps-lock.ts` (the manifest and lockfile checks, `yaml` 2.9.1 already pinned), `release/deps.ts` (the step), `release/dependency-worker.ts` (the in-sandbox version check and monitor), `release/dependency-pins.ts` (types; the pins themselves in `config/pins.ts`), `release/build.ts` (installs first, records, stops), `release/config.ts` `DEPENDENCIES_TYPE`. Tests: `tests/unit/release-deps.test.ts` (40 refusals and acceptances), `tests/unit/release-deps-install.test.ts` (a fake package manager and registry seam; size, count, live size, timeout, output, exit, escape, wrong version, candidate-owned, relative and differing pins), `tests/unit/release-build.test.ts` and `tests/unit/release-run.test.ts` (the stop and REPORT.md), `tests/integration/e2e-release-deps.test.ts` (committed tree, install, offline build, static output through the Render adapter's deploy tree with the push faked). `release/mutations-deps.json`: 25 definitions, stage 5. The review removed a second `release.step` line `build.ts` wrote for the same stop, tightened the name rule above, and pinned the environment's exact key set in the install test.
*From:* the lane's final report (Nov 1) and its cross-family review; the pins read on Fabricio's Mac the same day.
### 175. `jarvis setup`: a typed mistake is one printed line and exit 2, and `--redo` runs only the steps it names (new; Nov 1; the integrator, from Fabricio's Render setup on Nov 1; refines 43)
Fabricio ran `jarvis setup --redo accounts.deploy,` (trailing comma) and got a Node stack trace; then `--redo accounts.deploy` also walked him through every account step his first setup had never reached.
- **Usage errors print one line.** `parseRedo` throws `SetupUsageError`; the command prints `jarvis setup: <message>` and sets exit code 2, the same for running without a terminal. Other errors still propagate (they are bugs, and a trace is right for them).
- **`--redo` is a selection.** With `--redo`, a step that was never finished is listed as "not finished; run jarvis setup without --redo to continue it" and skipped. The run is ok when every named step finished (done or skipped); a named step that failed still fails the run. Without `--redo`, nothing changes: setup resumes at the first unfinished step and is not ok while any step is pending.
- **Tests and mutations:** `tests/unit/setup-command.test.ts` (one line, exit 2, no runner folder created), `tests/unit/setup-run-1.test.ts` (half-finished home, `--redo claude` asks nothing and leaves the pending steps), `packages/cli/src/setup/mutations-setup.json` (5 definitions, stage 5 by the existing map).
*From:* Fabricio's two Nov 1 reports through the release worker's transcript; the integrator.

### 176. Keep the reviewed Codex version in its own installation (Nov 2, 2026; takeover integrator; refines 58 and 66)

The Nov 2 preflight reproduced Fable's handoff: the configured global npm launcher reports codex-cli 0.166.0, while Jarvis requires 0.164.0. A mutable global launcher is not a stable version pin. Keep 0.164.0 and select the native executable at `~/.local/share/codex/versions/0.164.0/codex`, with the version directory derived from `CODEX_VERSION`. The installer and runtime use the same path. The ordinary global Codex installation remains unchanged; no fallback to it or PATH is allowed.

The native executable comes from the exact `@openai/codex@0.164.0` npm distribution, installed into a separate runner cache with lifecycle scripts disabled. npm verifies registry integrity during installation. The runtime's exact version refusal and reviewer confinement remain required. This repairs the prerequisite; it does not approve any unfinished stage or replace a live confined review.

### 177. The release composition test must exercise the dependency step (Nov 2, 2026; takeover integrator; follows 173; settles backlog 244)

The first Nov 2 full suite on `c14075d` passed 4,632 tests and failed both web release integration cases. One hit backlog 244's unsupported ordering assumption; the other stopped at decision 173's dependency check because the older fixture had neither `packageManager` nor a lockfile. The fixture's shell build needs no external packages, but its Node manifest still requires the release dependency policy.

Give that fixture a committed exact package-manager declaration and lockfile. Forward test-only dependency pins through the existing release seams, so an inert package manager runs under the real dependency worker and sandbox. The build requires a marker produced by that process; a skipped install cannot satisfy the test. Production retains its default pins and all dependency refusals. Assert that both independent build sessions finish before the ship session, without imposing an order between the two builders.

### 178. Restore a missing Claude pin only from a verified matching binary (Nov 2, 2026; takeover integrator; follows 57 and 59)

The initial Nov 2 doctor found Claude Code 2.1.309 at its configured absolute path. The subsequent plan calibration found that path missing and recorded three infrastructure errors; no lens ran. The cause of the removal has not been established. The installed desktop bundle still contains an executable under its 2.1.309 directory. Check its reported version before copying it exclusively to the missing pinned path, and run the live safety probe before resuming calibration. Do not change the required version, silently select 2.1.316, or count the failed control as a passing one. A restored binary's version alone does not establish that it meets the sandbox policy.

The desktop executable reports the matching version in its bundle, but copying only that executable makes macOS kill it: `codesign --verify` reports an invalid Info.plist. Preserve the complete signed app bundle in a versioned private installation, verify its signature, and link the configured absolute path to its executable. Keep the rejected standalone copy for diagnosis. Do not strip or replace the signature or disable macOS validation. The source executable's SHA-256 is `40fa5522dc98b3b85d7122c1159b900891107ef6c198e3c8d0fd222586c13e31`.

### 179. Plan calibration checks cover both the default store and the safe override (Nov 2, 2026; local-readiness repair; follows 170)

The resumed good-fixture review found that the previous fixture repairs left T1's exit condition naming `data/items.jsonl` while every check used `data/check-items.jsonl`. No check exercised the default path, whitespace trimming, or unquoted multiword input; the blank-name check also accepted the wrong exit code and no error message. Four executable negative tests reproduced these omissions before the fixture edits.

Keep the two fixtures' spec and checks identical. Make their argument and error contract explicit, exercise the default path in a disposable copy of `src/` with its own empty `data/`, and preserve the original checkout's data. The good plan names each task's actual responsibilities and check outputs. The bad plan retains its three planted faults (duplicate retry helper, storage left to the builder, hard decision without alternatives). Do not alter the reviewer policy, severity thresholds, or calibration requirements. A deterministic reference implementation and broken variants test the checks; they are outside the material shown to reviewers.

### 180. Pin Claude directly inside the preserved signed bundle (Nov 2, 2026; local-readiness repair; supersedes 178's symlink)

The next calibration again found `~/.local/share/claude/versions/2.1.309` missing, including the restored symlink. The signed copy at `~/.local/share/claude/pinned-bundles/2.1.309/claude.app` is still intact. The process removing the old entry remains unidentified; assuming that an entry in the native installer's versions directory will persist is no longer supported by the observation.

Use the preserved bundle's `Contents/MacOS/claude` directly as the absolute pin. Installer, runtime, and clean-install tests must agree on that path. Preserve version 2.1.309, the complete signature, and every preflight requirement. Do not recreate the disappearing symlink as a prerequisite, use PATH, or replace it with a newer version. Run the live probe on the direct path before accepting another calibration.

The missing-pin diagnostic must point to preparation of the complete signed bundle described in getting-started, not suggest that the native installer's mutable versions entry is sufficient. The doctor unit mock selects the exact pin function's path; its old filename-suffix match caused the lone Nov 2 follow-up full-suite failure (4,656 passed, one failed, 18 skipped), while the actual live doctor passed.

### 181. Calibration must exercise empty stores and observable failure behavior (Nov 2, 2026; local-readiness repair; follows 179)

The live good-fixture reviewers found more real gaps: a missing file was mislabeled as an empty-file case, usage checks omitted missing and unknown commands, malformed data started on line one and could not expose partial stdout, and no case exercised a failed append or a parseable record with the wrong shape. The tests also omitted valid special characters and a relative override invoked outside the application's directory. Add executable negative examples before changing these checks. Rejection of a blank add must preserve an existing item, not merely leave an initially missing store empty.

Clarify the fixture contract: an existing zero-byte store is empty; only ENOENT among read errors means empty; failed writes report an error and never print saved; malformed records include an object whose name does not satisfy the stored-name rule. Parsing and validation finish before output. Torn writes remain outside recovery guarantees. Give each check its own override path, so independent checks cannot collide. T2 may correct the CLI's validation/error plumbing as well as its store validation. Preserve both fixtures' shared spec and check bytes and the bad fixture's planted faults. None of these repairs changes the reviewer policy or counts a failed control as a pass.

### 182. Every intermediate fixture build preserves valid persisted records (Nov 2, 2026; local-readiness repair; follows 181)

Two live lenses passed the repaired good fixture; the critic found one remaining major: T1 intentionally accepted invalid names until T2, allowing a builder's smoke test to leave a malformed default-store record that T3 would reject. A new negative test reproduces that gap in item-add before the correction.

T1 now implements the full stored-name rule before appending and rejects invalid input with the generic diagnostic `invalid item name`. Its protected check exercises those refusals and verifies that existing valid records are unchanged. T2 owns the specified user-facing diagnostic `item name must not be blank` and its exact acceptance check, preserving T1's data invariant. A staged oracle proves that T1's generic refusal passes item-add but does not satisfy item-blank. Thus T2 remains observable work, and no intermediate task writes records a later task rejects. This changes task decomposition and its checks, not the product's final contract or the reviewer policy.

### 183. Finish the local end-to-end harness; deployment is out of scope (Nov 2, 2026; Fabricio; supersedes the planning-only scope of the earlier local checkpoint)

Fabricio: "finish everything that needs to be done in order to use it end to end and I am confident about it but locally doesn't need to be deployed yet. Just I need to make sure the harness does it's intended job". Resume calibration and the existing harness proof work, connect the interactive handoff to reviewed local builds, and exercise the real workflow and failure paths. The previous choice to retain a planning-only stop no longer defines the target. Do not deploy, send outside messages, or claim stages complete without their required evidence. Decision 84's integration work may overlap; stage completion still requires its proof and review.

The Nov 2 inventory finds 2,488 mutation definitions, including 441 for stages 0–1. At the latest 446.93-second full-suite duration, serial full confirmation projects about 309 hours (roughly 13 days), excluding setup and reruns; stages 0–1 alone project about 55 hours. This is a measured planning estimate, not completed evidence or a waiver of the existing gate. The earlier 71-hour estimate is stale for this checkout.

### 184. Simplify the positive plan control and provide its external runner contract (Nov 2, 2026; follows 183; supersedes 182's temporary diagnostic task)

The final earlier control rejected artificial work introduced to retain three tasks: first emit a generic error, then change its string. The task count is not a product requirement. The good control now has two substantive tasks: save valid items and reject invalid input with the final contract from the start; then list stored items. T1 claims AC1 and AC2 and requires both checks. The bad control keeps its three planted faults and original task topology.

The missing contract affects ordinary project reviews too, so repairing only the calibration fixture would hide the defect. Every plan-review prompt now supplies the trusted runner contract: sequential case order within a check, shared checkout and cwd within that check, separate processes, recorded observations and isolated verifier inputs/completion. A real sandbox gate test exercises those guarantees and must fail if case order is reversed. Product-code claims still require code evidence; no severity rule is relaxed. The contract is part of COMMON, so the policy hash changes and both bad and good controls must run again. Old calibration receipts cannot count for this policy. Keep both fixtures' shared product spec and checks unchanged. Do not repeatedly rerun unchanged rejected material hoping for a pass.

### 185. Explicit local runs never start a release or phone traffic (Nov 2, 2026; follows 183)

The current run composition automatically starts the release step when a project has saved release configuration. That conflicts with Fabricio's local-only verification request, even though production promotion remains separately gated. Add `jarvis run --local`, preserved through detach, to skip release preparation entirely and keep the broker's local outbox adapters. It also skips loading the phone notifier and approval poller; blocked/wait status stays in the local log, and approvals remain terminal-only. This is not an offline model mode: Claude and independent reviewers still use their normal confined service connections.

Local mode keeps live preflight, approved checks, counted plan reviews, independent candidate review, ledger recovery and promotion unchanged. Existing runs without the flag retain their behavior. Tests must show the flag survives detach, saved provider/phone configuration is never used, and missing check approval or a failed canary still refuses the run.

### 186. Complete the missing planning-to-build transition (Nov 2, 2026; follows 183; supersedes 120's planning-only handoff)

The implementation disagrees with the old dispatch instructions: `run-compose.ts` consumes an existing reviewed plan and approved checks; it never launches an architect. Triage labels architecture as runner work, omits it for features, and `/jarvis` stops after spec. The architect also simultaneously says to commit cited files and forbids committing. These gaps leave the local workflow disconnected.

Architecture becomes an interactive session step after spec/design, for both new products and features. It writes no product code. Add the narrow runner command `jarvis plan checkpoint` to commit only planning documents (versioned specs, PRODUCT.md, DESIGN.md, docs/decisions.md, and Markdown intake/research records). It validates spec history and refuses drafts, symlinks and edits to previously approved spec content; unconfirmed-to-confirmed without content changes remains allowed. It preserves unrelated staged work, never commits .jarvis or product code, and uses runner-safe git with hooks disabled. A new project can initialize its local repository here. The architect checkpoints before checks installation and after recording any further decisions, then obtains a counted Goldfish review.

The checkpoint hashes captured, validated bytes through `hash-object --stdin` and builds its tree in a private index; it never uses `git add`, which can execute a repository-defined clean filter. A hostile-filter test reproduced that action before this correction. The branch update checks its expected old revision, and only selected planning entries are synchronized to the user's index.

Only a ready handoff invokes `jarvis run --local --detach` for this local-first workflow. Drafts, unanswered product choices, failed checks or failed plan review still stop. A printed pid/log is evidence of launch, not completion: status/report and runner evidence determine completion. Question-only and review-only requests never build; release remains explicitly outside this local handoff. No stage proof is waived by connecting these existing components.

### 187. Direct local refactors use the existing behavior-preservation plan (Nov 2, 2026; completes 186's spec-free handoff)

`singleTaskPlan` already implements both bug and refactor work, but `--request` rejected every refactor. Accept these two triage types through that same runner-owned plan generator; still reject feature/new-product requests that require a spec. Resume only a task with the same original request and exit condition, preserving unrelated work. A refactor is reviewed against unchanged behavior and its installed unit check, without the bug-only reproduction protocol. Bugs retain their stronger reproduction requirements. Neither path invokes the architect or fabricates a spec.

### 188. Check reviewers receive the approved spec's definitions and constraints (Nov 2, 2026; local end-to-end finding)

The first real check review called every storage path, input definition and error condition unspecified. They are present in the approved spec's assumptions, but `buildChecksReviewPrompt` discarded everything except the AC lines. Pass the approved spec's parsed goals, non-goals, stories, assumptions and open questions alongside its criteria. These remain framed as data; no intake, research or planner narrative is supplied. The reviewer must interpret the criteria with these definitions while still rejecting contradictions and missing coverage. A focused test fails when that context is omitted. This repairs the production review input, not the review's severity or verdict.

The same review correctly rejected the local proof's generic unit verifier for accepting zero tests: require TAP output with a positive test/pass count and zero failures, cancellations and skips. Keep the acceptance checks unchanged in strength. Expected usage text belongs in expected/ rather than looking like candidate execution inside a verifier. These proof-input corrections do not count as approvals; rerun the real reviewer.

### 189. A working Codex version banner is insufficient proof of a usable reviewer (Nov 2, 2026; local end-to-end finding; completes 176)

The three focused review attempts on `0d47640` returned empty findings and empty `checked` arrays because the pinned executable could not start its adjacent `codex-code-mode-host`. Their raw event streams explicitly report that failure; none counts as a review. Restore the companion host from the exact official `@openai/codex@0.164.0-darwin-arm64` distribution, first verifying its Codex executable matches the existing pin byte-for-byte. Keep the version and path unchanged.

Doctor now checks for the adjacent host as well as the version banner. Both code and design review adapters reject runtime error events even if a later `turn.completed` and a plausible verdict exist. The host must demonstrably read a source file inside the existing jail before rerunning independent reviews. No sandbox, credential isolation or review gate is relaxed.

### 190. Checkpoint validates the Git destination and bounds bytes before parsing (Nov 2, 2026; independent local review)

The focused security review of 18d177e found that a symlinked .git redirects checkpoint writes into another repository, and checkRepository reads unbounded spec content before the checkpoint's bounded reader runs. Refuse symlink Git markers and unrelated gitdir files before any Git write; a genuine linked worktree must have the reciprocal gitdir pointer. Capture bounded planning files first, enforce the aggregate limit incrementally, and validate the entire captured spec history including gaps and earlier invalid versions. Preserve the private index and no-filter commit path. Regression tests must reproduce both failures before the fix and verify a foreign repository remains unchanged.
