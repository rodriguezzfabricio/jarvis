# Research notes: Default house stack

Raw findings from a research agent, Oct 23, 2026. These fed `docs/01-decisions.md`. Claims marked secondary or unverified in the text should be checked before relying on them.

---

JARVIS HOUSE STACK: RESEARCH BRIEF (checked 2026-10-23)

Recommendation: use TypeScript everywhere and React for every UI. Server data goes in Postgres via Drizzle, and Better Auth handles login. The toolchain is pnpm, Biome, Vitest and Playwright. Python (uv, FastAPI, Ruff, pytest) is the one supported second ecosystem. Every default deploy target can be set up without a card. Jarvis must ask before anything commercial, anything going to an app store, code signing, or metered LLM calls.

Main data points
- GitHub Octoverse 2025 (data Sep 2024 to Aug 2025): in Aug 2025 TypeScript became the #1 language on GitHub by monthly contributors (2.64M, +66% YoY). GitHub credits AI and the move to typed languages, and cites a 2025 study where 94% of LLM compile errors were type-check failures. Python still powers nearly half of new AI repos (582k, +50.7%).
- Stack Overflow 2026 (published 6 Oct 2026, 30k+ respondents): JavaScript 62.0%, Python 58.0%, TypeScript 43.8%. PostgreSQL 57.9%, SQLite 42.1%. Claude Code is the most-used coding agent (66% of agent users), then Copilot (59%). The 2026 report has no framework or tool tables, so framework figures below come from SO 2025 (49k+ respondents).
- What Claude Code picks when not told (Amplifying study, Feb 2026, 2,430 responses): Vercel 100% for JS deploys, Postgres 58%, Drizzle (100% on Opus 4.6), shadcn/ui 90%, Vitest 59%, pnpm over npm. It wrote its own auth 48% of the time. These are exactly the silent assumptions Jarvis should pin down.
- AI app builder defaults:
  - v0: Next.js, Tailwind, shadcn/ui.
  - Lovable: TanStack Start for new apps since 13 May 2026 (React + Vite before that), Postgres, no framework choice, no native mobile.
  - Netlify's AI builder: TanStack Start.
  - Anthropic's web-artifacts skill: React, TypeScript, Vite, Tailwind, shadcn/ui.
  - Google AI Studio: React frontend with a Node runtime, Firebase, deploys to Cloud Run.
  - Replit: Postgres plus an ORM for web, Expo/React Native for mobile.
  - Bolt: Expo for mobile.
- A caveat on npm numbers: weekly npm downloads (12–18 Oct 2026 vs the same week in 2025) are inflated by AI builders and CI. The typescript package grew 1.9x and vite 3.3x, so read growth figures relative to those, not as market share.

1. DEFAULTS BY CATEGORY

Shared baseline for all JS/TS work:
- TypeScript in strict mode, pinned to 6.0.x (see Risks).
- Node 24 LTS, pnpm 12, Biome 2 for lint and format, Vitest 5 for unit tests, Playwright for e2e, Zod for validation.
- No monorepo by default. Use pnpm workspaces plus Turborepo only when two or more deployable apps share code.

Why the baseline:
- Package managers (SO 2025): npm 56.8%, Yarn 21.1%, pnpm 13.4% (53.9% admired), Bun 5.5%.
- State of JS 2025 (13,002 respondents): Vitest was the most-adopted tool (+14 points) with 97% satisfaction; Playwright also gained +14 points; Vite had 98% satisfaction.
- npm weekly downloads:
  - vitest 77.5M vs jest 25.8M (a year ago 16.9M vs 32.8M).
  - @playwright/test 46.6M vs cypress 3.2M.
  - turbo 17.5M (3.2x YoY) vs nx 5.7M (flat).
- Biome is one binary for lint and format, which means fewer config files for agents to get wrong. Next.js 16 removed `next lint` and names Biome or ESLint as the replacement.

| Category | Default | Why (data) | Alternative |
|---|---|---|---|
| Web app | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui. Postgres on Neon via Drizzle. Better Auth. Vitest + Playwright. Deploy to Vercel Hobby for personal projects, Netlify Free for commercial ones. | Next.js: SO 2025 20.8% (React 44.7%); State of JS 2025 59% usage; State of React 2025 80% have used it; npm 41.1M/wk (3.1x YoY). It is v0's default. Since 16.2 it ships version-matched docs and an AGENTS.md. Vercel's eval (Jan 2026): agents passed 53% with no docs, 79% with a skill plus explicit instructions, and 100% with the AGENTS.md docs index. Top agents score 97% pass@4 on Next.js evals (Oct 2026). Tailwind 78% usage (State of React 2025). | Python: Django + HTMX on Render Free, with Neon (Django SO 2025 12.6%). |
| API/backend | Hono 4, Zod, Drizzle, Postgres (Neon serverless driver), Better Auth, Vitest. Deploy to Cloudflare Workers Free. | hono 45.2M/wk (18.6x YoY); 95% satisfaction (State of JS 2025, #3 overall). The same code runs on Node, Bun, Workers and Vercel. Claude Code picked Express 0 of 119 times. Workers Free needs no card and its limits docs say nothing against commercial use. | Python: FastAPI, Pydantic v2, SQLAlchemy 2/SQLModel, Alembic, pytest, uv; deploy to Render Free. FastAPI SO 2025 14.8% (+5 points YoY). PyPI, last 30 days: about 382M downloads vs Flask 136M, Django 41M. |
| Mobile | Expo (SDK 57 until Expo Go for SDK 58 is in the stores, or SDK 58 with development builds), Expo Router, NativeWind, React Native Reusables. Talks to the Hono API. Better Auth Expo plugin. Jest (jest-expo) + React Native Testing Library. Maestro for e2e. EAS Build, Submit and Update. | expo 7.1M/wk (3.8x YoY), react-native 9.0M. Replit and Bolt both build mobile with Expo. Expo ships agent skills (expo-upgrade). Expo's docs recommend Maestro for e2e. Top-10k non-game iOS apps: React Native 1,350 vs Flutter 1,184 (Appfigures, Dec 2025, via Quash). | Flutter (Dart). SO 2024: 9.4% vs React Native 8.4%; no comparable 2025 data exists. |
| Desktop (macOS + Windows) | Tauri 2.12, Vite, React, shadcn/ui. SQLite via tauri-plugin-sql. Vitest, plus WebdriverIO's @wdio/tauri-service for e2e. GitHub Releases via tauri-action, with the Tauri updater. | Installers about 3–15 MB vs 50–150 MB for Electron; idle RAM 20–100 MB vs 100–300 MB (Digital Applied, Jun 2026). @tauri-apps/api 2.0M/wk (7.4x YoY) vs electron 5.0M (3.0x). The deciding point under the no-money rule: Tauri's updater signs with a free keypair you generate, while Electron's macOS auto-update requires a signed app (Apple program $99/yr). | Python: PySide6 (Qt) packaged with Briefcase or PyInstaller. For JS-only teams: Electron Forge. |
| CLI | TypeScript on Node 24, commander, @clack/prompts, bundled with tsdown. Vitest, with e2e tests that spawn the CLI. Publish to npm. Optional single binary via `bun build --compile` attached to GitHub Releases. | commander 313.6M/wk. Same toolchain as everything else. Publishing is free. | Python: Typer + uv (`uvx` / `uv tool install`), Ruff, pytest, publish to PyPI. uv SO 2025: 9.5% used, 74.2% admired. |
| AI/LLM apps | Vercel AI SDK (`ai` v7) inside the Next.js app, or in Hono for a headless service. Postgres + pgvector. Zod for structured output. Evals written as Vitest tests. Local development against Ollama or free-tier API keys. | ai 18.4M/wk (4.9x YoY). Keeps one language and one deploy, with streaming UI helpers. | Python: FastAPI + Pydantic AI (about 5.4M PyPI downloads / 30 days) + uv. Choose this when the product is mostly ML or data work. |

2. HEAD-TO-HEADS (as of Oct 2026)

Next.js vs Vite + React vs TanStack Start
- Pick Next.js as the default. It has the most training data, first-party agent tooling (AGENTS.md docs, DevTools MCP, the next-dev-loop skill) and is v0's default.
- Its costs: State of React 2025 sentiment is only 27% positive vs 17% negative. It churns a lot; Next.js itself now writes "This is NOT the Next.js you know" into AGENTS.md. And it had a CVSS 10 RSC vulnerability, React2Shell, in Dec 2025.
- Use a Vite + React SPA for dashboards behind a login and as the UI inside Tauri.
- TanStack Start reached 1.0 on 13 Oct 2026 and is now 7.2M/wk (71x YoY, mostly Lovable). Lovable and Netlify default to it. Re-evaluate it as the default around mid-2027.

Tauri vs Electron
- Tauri: smaller apps, less memory, and free signed updates.
- Pick Electron if the user won't touch Rust, or needs identical Chromium rendering on every OS. Tauri uses each system's webview: WebKit on macOS, WebView2 on Windows.

Expo/React Native vs Flutter
- Expo reuses TypeScript, React and Tailwind skills, and can share Zod schemas and the API client with the web app. Agent builders have standardized on it.
- Flutter is healthy (Flutter's Q2 2026 survey: 83% trust Flutter; Canonical now leads desktop) but adds a second language and UI model.

Postgres (Supabase/Neon) vs SQLite/libSQL
- Use Postgres for any server app: SO 2026 57.9% usage, SO 2025 65.5% admired.
- Use SQLite (SO 2026 42.1%) for CLI, desktop, local mobile data and tests.
- Host on Neon by default: 100 free projects, no inactivity pausing, no card.
- Use Supabase only for its bundled auth, storage or realtime, because free projects pause after 1 week idle and you get two.
- Turso/libSQL is fine (100 databases, 5 GB, no card), but Turso's Rust rewrite was not production-ready as of Apr 2026.

Better Auth vs Clerk vs Supabase Auth
- Pick Better Auth. It is an MIT library that keeps users in your own Postgres and has no MAU billing. It took over Auth.js in Sep 2025, which now recommends Better Auth for new projects, and it joined Vercel in Jul 2026. Downloads: 7.8M/wk (19.5x YoY) vs @clerk/nextjs 1.7M. It also directly fixes Claude Code's habit of writing its own auth.
- Clerk has the best developer experience (50k retained users free, no card), but MFA and passkeys are excluded on free and it becomes a paid dependency.
- Supabase Auth (50k MAU free) only makes sense if Supabase is already the database.

Drizzle vs Prisma
- Pick Drizzle: schema in TypeScript, no codegen step, works at the edge. Downloads are 18.3M vs 11.7M/wk (a year ago 2.3M vs 5.5M).
- But Drizzle's stable release is 0.45.x while 1.0 is at RC.5. Pin 0.45 and plan one migration.
- Prisma 7 (Nov 2025) removed its Rust engine. Today the `latest` tag on npm points the prisma CLI to 8.0.0-rc.27 while @prisma/client is 7.10.1. That kind of version mismatch breaks agents.

FastAPI vs Node backends for AI apps
- Use TypeScript and the AI SDK when AI is a feature inside a web product.
- Use FastAPI when Python libraries are the core (data pipelines, evals, local models).
- Avoid running both in v1 unless the project needs it.

pnpm vs npm vs bun
- Pick pnpm. Its strict node_modules catches undeclared dependencies that agents add, and workspaces are built in.
- It also has security defaults: pnpm 11 (Apr 2026) waits 24h before installing a new release (minimumReleaseAge), and build scripts need an allowlist.
- npm 12 (Jul 2026) now also blocks install scripts by default, so the gap is narrowing; npm stays the fallback.
- Bun (owned by Anthropic since Dec 2025; 5.5% in SO 2025, 21% runtime usage in State of JS 2025): use it only for `bun build --compile`.

3. FREE-TIER DEPLOY TARGETS (checked 23 Oct 2026)

| Platform | Card at signup | Free limits | Gotchas |
|---|---|---|---|
| Vercel Hobby | No (Render's own Apr 2026 comparison says so) | 100 GB transfer, 1M function invocations, 4 CPU-hours, 1M CDN requests, 100 deploys/day, 200 projects | Personal, non-commercial use only. "Commercial" includes a paid employee or consultant writing the code, so coworkers' work projects count. Over a limit, the feature waits up to 30 days, and you can't buy more on Hobby. |
| Netlify Free | No (Netlify, Nov 2024) | 300 credits/month. A production deploy costs 15 credits; bandwidth 20/GB; compute 10/GB-hour; 2 per 10k requests | When credits run out the site pauses until the next cycle. 300 credits is at most 20 production deploys if nothing else uses credits. Commercial use was explicitly allowed (2024 post). |
| Cloudflare Workers Free | No | 100k requests/day, 10 ms CPU per request, 100 Workers. Static assets free and unlimited. D1: 5 GB, 5M rows read and 100k written per day. KV: 100k reads/day. R2: 10 GB-month | Over the daily cap you get Error 1027 (fail open or closed, set per route). 10 ms CPU is tight for server rendering. Next.js runs there via vinext (beta) or OpenNext. R2 may need a payment method (unconfirmed, so treat it as "ask first"). |
| Supabase Free | Not stated (normally none) | 2 active projects, 500 MB database, 5 GB egress, 50k MAU, 1 GB storage, 500k edge function calls | Pauses after 1 week idle. Over quota it can go read-only, return HTTP 402, or pause. |
| Neon Free | No (stated) | 100 projects; per project 100 CU-hours, 1 GB storage (20 GB total), 5 GB egress, 10 branches; autoscale to 2 CU | Scales to zero after 5 minutes, so expect cold starts. Compute suspends when CU-hours run out; writes block at the storage cap. |
| Render Free | No (Render, Apr 2026) | 750 instance-hours/month; spins down after 15 minutes idle (about 1 minute cold start); Postgres 1 GB | The free Postgres is deleted 30 days after creation (14-day grace), one per workspace, no backups. Render says not to use it for production. Overage is billed if a card is on file. |
| Fly.io | Not needed to start the trial, required after it | No free tier for new organizations. Trial is 2 machine-hours or 7 days, whichever comes first | Not a free target. The smallest machine costs $2.19 per 30 days. |
| Railway | Not stated; the docs say Railway now requires a post-paid card, so treat it as likely | $5 trial for 30 days, then $1/month credit. Free per service: 0.5 GB RAM, 1 vCPU, 0.5 GB volume | $1 does not cover an always-on service plus a database. Without GitHub verification, network access is limited. |
| Expo EAS Free | Not stated | 15 Android + 15 iOS builds/month, low priority, 45-minute timeout. EAS Update for 1k MAU. 60 CI minutes. Hosting: 100k requests | Store accounts cost money: Apple Developer $99/year, Google Play $25 one-time. Replit cannot use EAS. |
| GitHub Releases + Actions | No | No limit on release size or bandwidth; each file under 2 GiB; up to 1,000 assets per release. Actions are free on public repos; private repos get 2,000 minutes/month, and macOS minutes cost about 10x Linux | Unsigned apps trigger Gatekeeper and SmartScreen warnings. Apple notarization needs the $99/year program. Azure Artifact Signing for Windows is $9.99/month and available to individuals in the US and Canada only. |

4. RISKS

- Consolidation: Vercel now has Next.js and Better Auth (Jul 2026). Cloudflare bought VoidZero (Vite, Vitest, Rolldown, Oxc, Vite+) in Jun 2026 and pledged to keep them MIT plus a $1M independent fund. Anthropic owns Bun. The Drizzle team joined PlanetScale in Mar 2026 and says Drizzle stays independent. Everything is still MIT or Apache; watch for changes that favor the owner's hosting.
- Tailwind Labs laid off 75% of its engineers in Jan 2026. Revenue is down about 80% and docs traffic fell 40% as people use AI instead. Vercel and Google AI Studio stepped in as sponsors. Tailwind is fine for now but thinly staffed.
- Next.js churn: v16 made params async, replaced middleware with proxy.ts, changed revalidateTag's signature and introduced Cache Components. With no docs, agents passed only 53% on new APIs. Keep the AGENTS.md block, pin minor versions, and apply security patches automatically (React2Shell).
- Fresh releases and version traps that will catch agents today:
  - prisma CLI `latest` is an 8.0 RC while @prisma/client is 7.10.1.
  - Drizzle 1.0 RC vs 0.45 stable.
  - TypeScript 7.0 (the Go port, Jul 2026): tools built on the compiler API stay on TS 6 until 7.1, so templates should pin 6.0.x.
  - Expo SDK 58 shipped 21 Oct 2026, and the Expo Go app for it isn't in the stores yet.
  - Tailwind v4 uses CSS-first config, while training data is full of v3's tailwind.config.js.
  - Also new: Vite 8 (Rolldown), Vitest 5, ESLint 10 (flat config only), Electron 45, Next 16.4, pnpm 12.
- Install-script blocking: pnpm's build allowlist and npm 12's scripts-off default make packages with native installs (esbuild, sharp, better-sqlite3, electron) skip their install step. Jarvis must run `pnpm approve-builds` and commit the allowlist. pnpm's 24h minimumReleaseAge also blocks installing same-day releases.
- Node's docs say Corepack won't ship with future Node versions, so install pnpm explicitly and set the `packageManager` field.
- Free-tier traps: Vercel's commercial definition (ask "is this commercial?" before picking a host), Supabase idle pausing, Render deleting the database after 30 days, Netlify credits running out, and Cloudflare's 10 ms CPU limit.
- Money beyond hosting: LLM API calls are metered spend. So are store fees, code signing and custom domains. Jarvis should gate all of them and default AI development to Ollama or free-tier keys with hard spend caps.
- Agent habits: left alone, Claude Code writes its own auth, feature flags and caching, so list the chosen libraries in AGENTS.md. Tauri's capability/permission files and Rust compile cycles commonly trip agents: keep logic in TypeScript plus official plugins, give Jarvis a Tauri skill, and use @wdio/tauri-service because tauri-driver doesn't support macOS.
- On the watch list: Vite+ 1.0 (MIT, Oct 2026) bundles oxlint, oxfmt, Vitest and Rolldown and could replace Biome. oxlint downloads grew 30x YoY. Revisit in 2027.

Sources:
- Stack Overflow 2026: https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/ and https://survey.stackoverflow.co/2026/technology
- Stack Overflow 2025: https://survey.stackoverflow.co/2025/technology
- GitHub Octoverse 2025: https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/
- State of JS 2025: https://2025.stateofjs.com/en-US/awards/ and https://www.infoq.com/news/2026/03/state-of-js-survey-2025
- State of React 2025: https://devclass.com/development/2026/02/18/as-the-default-ui-for-ai-generated-apps-react-is-here-to-stay/4091379 and https://certificates.dev/blog/breaking-down-state-of-react-2025-results
- npm downloads: api.npmjs.org; PyPI downloads: pypistats.org
- Claude Code default picks: https://amplifying.ai/research/claude-code-picks
- Next.js agent tooling and evals: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals, https://nextjs.org/blog/next-16-2-ai, https://nextjs.org/blog/next-16-3-ai-improvements, https://nextjs.org/blog/next-16
- Lovable and TanStack Start: https://docs.lovable.dev/introduction/faq, https://tanstack.com/blog/lovable-partnership, https://tanstack.com/blog/tanstack-start-1-0
- AI builders: https://v0.app/docs, https://ai.google.dev/gemini-api/docs/aistudio-build-mode.md.txt, https://docs.replit.com/replitai/building-mobile-apps, https://support.bolt.new/concepts/faq.md
- Vercel: https://vercel.com/docs/plans/hobby and https://vercel.com/docs/limits/fair-use-guidelines
- Netlify: https://www.netlify.com/pricing/ and https://www.netlify.com/blog/introducing-netlify-free-plan.md
- Cloudflare: https://developers.cloudflare.com/workers/platform/pricing/ and https://developers.cloudflare.com/workers/platform/limits/
- Supabase: https://supabase.com/pricing
- Neon: https://neon.com/pricing
- Render: https://render.com/docs/free
- Fly.io: https://docs.fly.io/about/pricing
- Railway: https://docs.railway.com/pricing/plans
- Expo: https://expo.dev/pricing and https://expo.dev/blog/how-to-upgrade-to-sdk-58.md
- GitHub: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- Electron: https://www.electronjs.org/docs/latest/api/auto-updater
- Tauri: https://v2.tauri.app/plugin/updater/ and https://v2.tauri.app/distribute/sign/macos/
- Clerk: https://clerk.com/pricing
- Better Auth: https://www.better-auth.com/blog/authjs-joins-better-auth and https://better-auth.com/blog/better-auth-joins-vercel
- Drizzle and PlanetScale: https://planetscale.com/blog/drizzle-joins-planetscale
- Cloudflare and VoidZero: https://www.intelligentcio.com/me/2026/06/05/cloudflare-acquires-voidzero/ and https://infoq.com/news/2026/10/cloudflare-viteplus-stable
- npm 12: https://www.infoq.com/news/2026/08/npm-12-released/
- Tailwind Labs layoffs: https://www.devclass.com/2026/01/08/tailwind-labs-lays-off-75-percent-of-its-engineers-thanks-to-brutal-impact-of-ai/
- React2Shell: https://www.bleepingcomputer.com/news/security/critical-react2shell-flaw-in-react-nextjs-lets-hackers-run-javascript-code/
- Flutter: https://flutter.dev/blog/flutter-q2-2026-survey and https://quashbugs.com/blog/flutter-vs-react-native-statistics
- Tauri vs Electron sizes: https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026
- Windows signing: https://devclass.com/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/
- Free-tier card comparison: https://render-www.onrender.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026

Version tags and release dates come from registry.npmjs.org as of 2026-10-23.