# Red-team review: Claude Fable 5.1

Oct 23, 2026. An independent review of `00-brief.md`, `01-decisions.md` and `02-golden-tasks.md` by a model that did not write them. Findings are the reviewer's; the response and resulting changes are in `01-decisions.md`.

---

# Jarvis plan review

## 1. Verdict

The plan is a good literature review that has been mistaken for a product plan. Its best parts (research-before-asking, defaults on every question, "done" decided outside the model, fresh session per task) are right and well sourced. But built exactly as written it would not deliver the one thing Fabricio asked for: a vague line in, a product he likes out, overnight, on his subscriptions. The single biggest risk is that the autonomy promise rests on `claude -p` / `codex exec` running for hours on Claude Pro/Max and ChatGPT Plus, and both draw from 5-hour and weekly caps (verified; see F1), while the hard stops forbid the only metered alternative. Second is scope: three harnesses, a sync tool, a conformance suite, a credential vault, a routing table, a memory system and 14 evaluated skills before the first useful run. One strength worth keeping verbatim: decisions 5–9 (research → story map → ranked questions with defaults → EARS spec).

## 2. Findings, ranked

### Critical

**F1. Overnight runs on subscriptions will stall, and the runner doesn't handle it.**
Where: `01-decisions.md` D3, D14; brief "Away mode".
Why: Claude Code docs: `claude -p` on a subscription uses the same rolling 5-hour window and weekly cap as interactive use; `--bare` needs `ANTHROPIC_API_KEY` and "will become the default for `-p`". OpenAI restored the 5-hour Codex cap for Plus on Aug 25, 2026 (Pro $100/$200 exempt). So on Pro or Plus, a multi-session night hits the window in one to two hours and a nightly habit hits the weekly cap by midweek; every Jarvis run also eats his daytime budget. DeepSeek is per-token, so every DSH run is "spending money," which D12 forbids. D14 mentions usage caps but has no rate-limit handling.
Fix: runner must treat `api_retry` with `error: rate_limit` as "sleep until reset, keep state," not a failure or a retry. State plainly in the brief: overnight requires Max 5x/20x or ChatGPT Pro, or a pre-approved DeepSeek budget per run (the budget *is* the money approval). Add a "bare-mode cliff" note: the day bare becomes the `-p` default, the subscription headless path dies; fallback is an API key, which is a money decision he should make now, not at 3 a.m.

**F2. New projects on the house stack need accounts Jarvis cannot create.**
Where: D33, D13, D12 (bullet 5 "adding a paid service or API key"); D36 has no setup step.
Why: Walk "habit tracker": Next.js + Neon + Better Auth + Vercel. Neon, Vercel, an OAuth client for Better Auth, an email provider for magic links each need a signup with email verification. The credential wrappers (D13) assume secrets exist. The run stalls at the first `DATABASE_URL`, or worse, the agent "solves" it with SQLite and a hand-rolled auth (the 48% habit D33 cites).
Fix: a one-time `jarvis setup` that provisions and stores the house-stack accounts (and issues preview-scoped tokens only); default local dev to SQLite/local Postgres via Docker; the prod DB and prod deploy are the gated step, run by him in the morning.

**F3. "Come back to a deployed app" contradicts hard stop #3.**
Where: brief "How it's used" vs D12 "deploying where real users are"; D11 Challenge class.
Fix: define "where real users are" as production promotion only. Preview/staging deploys are autonomous and require only preview-scoped tokens (so a prompt-injected `vercel --prod` fails for lack of a token, not because a regex caught it). Let him pre-approve prod at intake for personal apps.

**F4. Product taste is unbounded; the veto arrives after the night is spent.**
Where: D10, D11 (Taste class), D19, pending design outline; brief "Jarvis supplies product direction."
Why: In away mode every product question, including the design direction, resolves to a model default after 15 minutes. Nothing in the plan makes those defaults *his*: memory (D27–28) is empty on day one and only learns after corrections. A design veto in the morning means rebuilding the UI.
Fix: (a) a one-time 10-minute taste intake stored as `user` memory notes: apps he admires, platforms he lives on, colors/fonts he hates, "serious vs playful"; (b) make the design direction the one question Jarvis always asks, with three static HTML mockups attached; (c) a `mockup-first` mode for greenfield runs: night one produces spec + three mockups + walking skeleton on the default direction; night two builds. Cheaper than a rebuild.

### High

**F5. Hard stops enforced by hooks are the weakest exactly where parity matters.**
Where: D12, D21, D22.
Why: Verified: Codex skips any hook whose hash changed until re-trusted; `--dangerously-bypass-hook-trust` trusts every hook in the repo for that run; DSH bridges are experimental with no block counter. "Sending messages to real people" is an outcome, not a command: `curl` to Gmail's API, a Go binary, a test fixture that hits a real SMTP host all bypass a command-pattern hook. Non-bare `claude -p` also runs a cloned repo's `.claude/settings.json` hooks and `.mcp.json` servers without any trust prompt (docs confirm), which cuts both ways.
Fix: make the primary safety layer harness-independent: no sending/deploy/payment credentials exist in the sandbox at all, plus deny-by-default egress with a per-project allowlist (registries, docs, localhost). Hooks become the second layer, not the first. Run `-p` with explicit `--settings` and `--strict-mcp-config`, and a dedicated config dir, so friends' `~/.claude` junk doesn't load.

**F6. DSH is a developer preview and should not be a v1 target.**
Where: D20–23, D36 step 5.
Why: README says "developer preview… THERE WILL BE COMPATIBILITY-BREAKING CHANGES" (verified). rulesync emits DSH rules/mcp/skills only, not hooks or subagents (verified). No dollar cap. Every parity claim about DSH rests on an experimental bridge plus Jarvis-written adapters. Among people he'd share with, Claude Code + Codex cover the market (SO 2026: 66% / 59%).
Fix: Claude Code first, Codex second, DSH as a community adapter behind the conformance suite later.

**F7. The test set contains zero greenfield products.**
Where: `02-golden-tasks.md` task 9; brief "Evaluation."
Why: Task 9 is a thin client on an existing API. The brief's core claim ("shouldn't need to know what to specify," "build anything") is untested. No desktop, CLI or API-only task either.
Fix: add two one-line greenfield ideas (one web, one Expo or Tauri) with his own 1–5 "would I use this" rating as the primary metric.

**F8. Planted-regression tasks leak the answer.**
Where: `02-golden-tasks.md` "How every task runs" #1 (fresh git worktree), tasks 3–5.
Why: Worktrees share the object store. The "undone" fix commit remains reachable via `git reflog`, `git log --all`, or `git fsck`; D15 says history is sealed but the isolation method doesn't seal it. Cursor's 63% retrieval figure (research/02 #8) is exactly this.
Fix: `git clone --depth 1` of the starting commit into a fresh repo with no remotes, network denied.

**F9. Tiering vanished between the Oct 22 brief and the decisions.**
Where: Oct 22 brief "The thinking step" tiers 0/1/2 vs D5–D9 (job story, day-after-launch, 3 failure reasons, story map, umbrella test, assumptions, ≤7 questions, spec, reader check, confirmation) applied to every task.
Why: task 5 ("citizenship filter misses jobs") should go straight to reproduce → fix. Heavy specs took as long to review as writing code (brief, Böckeler).
Fix: restore the size gate: tier 0 (one-sentence, reversible, tested) skips intake; tier 1 does assumptions + spec; tier 2 does the full walk.

### Medium

**F10. "Same behavior" undermined by subscription policy and sandbox differences.** D13 says "OS sandbox with allowlist," but Claude Code (Seatbelt config), Codex (`--sandbox workspace-write`, network off by default) and DSH each have different allowlist semantics; the parity promise needs the allowlist in Jarvis's own egress proxy, not three configs. Also DSH's "real Claude Code child via Agent SDK" (research/04 §1) is metered or blocked under Anthropic's 2026 subscription terms (verified), so cross-harness subagents must never cross subscriptions.

**F11. The routing table is premature.** D24 cites Cursor's $1,339 vs $10,565 swarm numbers, irrelevant on a laptop and a subscription. On subscriptions the only real signal is cap consumption. Start with one strong model everywhere plus a cheap explorer, measure, then downgrade roles.

**F12. No feedback or steering channel.** D3's runner has no way to accept "stop, I meant X" at 11 p.m.; D10 says later input is "decided and logged." Add a `.jarvis/inbox.md` the runner reads between tasks and a `jarvis steer` command; a requirement change triggers re-plan, not a logged assumption.

**F13. Stuck at 3 a.m. wastes the night.** D3's repair budget of 2 marks a task blocked. If that task is the walking skeleton, everything downstream is blocked too. Rule: on a blocked skeleton, try the next alternative from the decision log once, then always leave a tagged last-green commit and a runnable state.

**F14. Mobile QA is mis-measured.** D18 and task 9 verify Expo via "web screenshots through Playwright." That tests React DOM, not native behavior. Research/05 names Maestro; use it on the iOS simulator (Mac has Xcode).

**F15. Architecture rests on one vendor article from yesterday.** D2 cites the Oct 22, 2026 "fold subagents" piece (one customer, "2x faster"), while the Oct 22 brief's Anthropic source shows a planner/builder/evaluator trio was the difference between a broken and working app. Cheap to revisit since skills are files; don't hard-code "subagents only for three jobs" into the runner.

**F16. Keychain-only secrets break the "any OS" requirement.** D13. Use a pluggable backend (env file in v1).

### Low

- D20 `CLAUDE.md` with `@AGENTS.md`: unnecessary for new repos since 2.1.277 reads AGENTS.md natively; keep only for existing repos with a CLAUDE.md.
- D14 "warn above 25 agents" is Claude Workflows' threshold; irrelevant for a 2–4 worker laptop.
- D8's CLARITI 22→37% is one arXiv preprint; fine as motivation, not as a cap.
- D34 "known traps" list is a maintenance chore for an intern; auto-generate from `pnpm outdated` plus the stack skill's eval.

## 3. Scenario walk: "Build me a habit tracker app" (away mode, Claude Pro)

1. **Research (D5):** build-vs-buy spike finds hundreds of habit apps; the rubric's "do it manually" option scores well. The spike is built for components (auth, email), not for "what should this product be." → **Break: no product-pattern research.**
2. **Story map + questions (D6–D8):** platform, sign-in, sync, reminders, design direction. He's gone; after 15 minutes, defaults (D10). → **Break (F4): direction is the model's, unchecked.**
3. **Spec + confirmation (D9):** unconfirmed, proceeds. Fine.
4. **Design stage (pending):** picks direction B; tokens file; lint. → **Break: veto costs a rebuild (F4).**
5. **Scaffold (D33):** needs `DATABASE_URL`, Better Auth OAuth client. → **Break (F2): no accounts; agent improvises or stalls.**
6. **Build loop (D3):** ~90 minutes in, `rate_limit`. Runner counts failures, burns the repair budget, marks tasks blocked. → **Break (F1).**
7. **Review (D17):** `codex exec` reviewer on ChatGPT Plus hits its own 5-hour cap. → **Break (F1).**
8. **QA (D16/D18):** axe "zero serious" plus three viewports on a half-built app; blocked again.
9. **Ship (D12):** deploy is a hard stop. → **Break (F3): no deployed app in the morning.**
10. **Report (D19):** "7 tasks blocked, 2 unconfirmed Taste decisions, nothing deployed." He vetoes the color scheme. No defined path from veto to next run (F12).

For the recruiter request (task 2) the same breaks apply plus: Gmail OAuth app in Testing mode expires tokens after 7 days (research/06), so the "send" leg can only be a stub; that's fine for the test but means the real product's last mile is always manual.

## 4. Cut list and smallest useful v1

Cut or postpone: DSH and the DSH hook bridge (D20–23); `jarvis sync`, rulesync, nightly conformance suite (D20, D22); routing table (D24); credential vault + Keychain wrappers (D13) in favor of "no credentials present"; memory automation, compound, sweeps, expiry checks (D27–29); cost "keep rate" (D26); teach-me mode (D32); workflow API port (D3 "later"); semgrep/osv (keep gitleaks); 14 skills × 3 evals (D30) → 4 skills; morning-report demo video.

**v1 (Claude Code, Mac, his repos, one week):**
- `AGENTS.md` (~100 lines) + 4 skills: `intake` (assumptions → ≤5 questions with defaults, including the design pick with three mockups → EARS spec, tiered per F9), `build` (one task per session, test-first, worktree), `verify` (gates + fresh-context reviewer subagent + Playwright screenshots), `ship` (preview deploy; prod is his).
- `jarvis run`: a ~200-line script looping over `features.json`, calling `claude -p --settings jarvis.json --permission-mode acceptEdits --allowedTools …`, running `jarvis gate`, repair budget 2, rate-limit sleep, `REPORT.md`.
- Safety: Claude Code's sandbox with network allowlist; Stop hook runs gates; PreToolUse denylist for `push --force`, `rm -rf`, `drizzle-kit push`, `--prod`; no send/deploy/payment tokens in the environment.
- Three test tasks: #1, #2, one greenfield with UI. Metrics: his 1–5 rating, veto count, blocked tasks, wall time, tokens.

## 5. Test-plan gaps

- No greenfield product, desktop, CLI or API-only task (F7); "builds everything" is unmeasured.
- Isolation leaks the answer (F8).
- Task 1's rubric is the same AI's expected answer (research/06 §5): circular. Fabricio should grade whether those are the questions he'd want.
- "How many times you'd have had to step in" is zero by construction in away mode. Replace with veto rate, his rating, and 7-day keep rate.
- 10 tasks × 2 runs × 3 harnesses = 60 long agentic runs plus 42 skill evals on subscription caps: infeasible on Pro (F1). Run 3 tasks until build step 5.
- Nothing tests cap pause/resume, steering mid-run, or the design reviewer against a known-generic UI (a negative control is needed).
- Tasks 6 and 9 rely on an LLM judge ("looks native," "doesn't look AI-generated"), which D16 itself ranks lowest. Add mechanical checks (F-design below).
- "Cost" is unmeasurable on subscriptions; record tokens and cap consumption instead.

**On the pending design outline:** tokens-plus-lint stops off-palette colors but not the actual tells, which are structural: hero + three cards + CTA, Inter/Roboto everywhere, purple gradients, emoji icons, identical rounded-card grids, "Welcome to your dashboard" copy, onboarding tours. Make those mechanical (font-family count, gradient and emoji detection, DOM-shape repetition, copy length) and keep the screenshot judge for the rest, on a different model family than the builder. The outline is 80% visual style and 20% UX; his words were "less friction, less reading." Add per-app "taps to core action," first-run and empty states, error/loading states, and Nielsen's heuristics (already in the Oct 22 brief). Tokens must drive both Tailwind and NativeWind from one `tokens.json`. Move the direction pick into intake (F4).

## 6. Strongest alternative

**Claude Code native + superpowers + a thin loop.** Claude Code already ships every autonomy primitive the runner reimplements: `/goal` exit conditions, `/loop` and scheduled tasks, Workflows, worktrees, the sandbox and allowlist, auto mode, agent memory. superpowers (MIT, 16 harnesses incl. Codex, an evals repo, 1.3k tokens loaded) covers build, debug, TDD and review. Jarvis then is: AGENTS.md, an `intake-with-defaults` skill replacing superpowers' brainstorming, a Stop gate, a reviewer subagent, and a 200-line loop. It is what research/03 §4 says every lab engineer actually runs.

Honest comparison: it beats the plan for the first one to two months on time-to-value, bugs and his ability to understand it. It does not give cross-harness parity or DSH, and it inherits the bare-mode cliff (F1). The plan's thin core becomes worth building only when Codex parity is attempted and superpowers' interaction model actually fights the loop; extract it then, from a working system, rather than designing it now from research notes. I'd take the alternative as v1 and treat decisions 20–24 as the v2 roadmap.

## 7. Three changes first

1. **Re-scope v1** to Claude Code + Mac + his repos with the four skills and the loop above; make the runner rate-limit-aware and write the subscription/money reality into the brief (F1, F6, F9).
2. **Invert the safety model**: no credentials in the sandbox, deny-by-default egress, preview-scoped tokens, prod promotion as the one gate; add `jarvis setup` for accounts (F2, F3, F5).
3. **Fix the test set and the taste gap**: fresh-clone isolation, two greenfield ideas, his 1–5 rating and veto rate as primary metrics, the design pick as an always-asked question with mockups, and a negative-control UI for the design reviewer (F4, F7, F8).

Sources checked: [Claude Code headless docs](https://code.claude.com/docs/zh-CN/headless), [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes), [Claude Code usage limits summary (Sep 30, 2026)](https://www.morphllm.com/claude-code-usage-limits), [OpenAI restores 5-hour Codex limit for Plus (Aug 25, 2026)](https://www.notebookcheck.net/OpenAI-abruptly-restores-harsh-5-hour-Codex-and-Work-limits-for-ChatGPT-Plus.1378377.0.html), [Anthropic third-party subscription crackdown timeline](https://falcao.org/posts/anthropic-claude-access-crackdown-ecosystem-fallout/), [Codex hooks docs](https://learn.chatgpt.com/docs/hooks), [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), [rulesync](https://github.com/dyoshikawa/rulesync), [Anthropic: when to fold subagents (Oct 22, 2026)](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop).