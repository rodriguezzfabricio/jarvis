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
- **`jarvis steer "…"`** (or editing `.jarvis/inbox.md`) leaves a note that the runner reads between tasks.
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

**What it costs.** Sessions can't `git commit`; the runner commits the candidate revision, as architecture §3.4 already says. The runner's own git never runs hooks or `fsmonitor` (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, no global or system config).
*From:* Codex stage 0 review 1, finding 1 (`docs/reviews/stage0-codex-1.md`); live tests, Oct 23; Fabricio, Oct 23.

### 69. Sessions can't read outside their worktree (new; stage 0, after Codex review 1)
Codex found that sandboxed sessions could read the rest of the disk, including the original FreeHire repo and its history (the golden tasks' answers) and sibling eval runs. Now:
- `permissions.blockReadsOutsideWorkingDirectories: true` blocks reads of `/Users` and similar for sandboxed shells. `--restricted` confines the file tools.
- One shared toolchain cache, `~/.jarvis-work/cache`, is reopened for reading and writing (`allowRead`, `allowWrite`). Go, npm and pnpm are pointed at it through environment variables. It holds packages, not answers.
- Writes to `.git/hooks`, `.git/config` and `.claude/` inside the worktree are denied as a second layer.
- Snapshots fail closed on credential-looking content anywhere in the tree, unless a person allowlists the file as a fixture (`allowSecretsIn`). They also remove symlinks pointing outside the snapshot, redact quoted multi-line values, and strip user:password from non-local credential URLs.
- Settings are valid only if they're *exactly* what the builder produces for the trusted context (worktree, Jarvis home, cache, socket, allowlist). A swapped protected path or a widened rule is refused before it reaches disk.

All of this is verified by the live probe. Tightens decisions 12, 13 and 15.
*From:* Codex stage 0 review 1, findings 2, 5 and 7; live tests, Oct 23.

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

**Stage 0's proof is now:**
- every remaining §9 item resolved,
- the Codex review findings fixed and re-reviewed,
- the ntfy button and publish-box test done,
- baselines recorded for tasks 1, 2 and 11 (at least one run each to start stage 1; the second repeat may finish during stage 1).

Supersedes those parts of architecture §8 and §9.
*From:* Codex stage 0 review 1 ("remaining for stage 0"); Fabricio, Oct 23.

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
- **By absolute path:** `~/.npm-global/bin/codex`, pinned at codex-cli 0.163.0. Never through `PATH`, because a wrapper owns `codex` there (decision 58).
- **Isolated in two places:**
  - A Jarvis-owned `CODEX_HOME` (`~/.jarvis/codex-home`) that contains only a symlink to the login file `~/.codex/auth.json`, so the credential isn't copied.
  - An empty `HOME` (`~/.jarvis/codex-home/home`). Codex also reads the cross-tool skills folder `~/.agents/skills` (4,193 skills on this Mac, including gstack) from the real home, whatever `CODEX_HOME` says.
  - With both, none of Fabricio's skills, config, rules, memories or plugins load. A trivial call used about 15.8k input tokens, against about 25.5k with only `CODEX_HOME` isolated and about 53k with neither. `--ignore-user-config` and `--ignore-rules` alone still loaded the skills.
  - Stdin is `/dev/null`, because `codex exec` otherwise waits for more input.
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
