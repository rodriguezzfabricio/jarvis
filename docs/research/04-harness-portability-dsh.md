# Research notes: Harness portability and DSH

Raw findings from a research agent, Oct 23, 2026. These fed `docs/01-decisions.md`. Claims marked secondary or unverified in the text should be checked before relying on them.

---

JARVIS CROSS-HARNESS BRIEF (researched 2026-10-23 from official docs and source; "undocumented" means I found no official statement)

Changes since yesterday's brief:
(a) Claude Code now reads AGENTS.md natively.
(b) Codex hooks are not "approved once". Trust is tied to each hook's hash, so a hook is skipped again whenever it changes.
(c) Hooks DO run in `codex exec` (confirmed from source).
(d) The Codex desktop app merged into the ChatGPT desktop app on July 9.
(e) Codex dropped Chat Completions providers. Only `wire_api="responses"` works now.
(f) Codex docs moved from developers.openai.com/codex to learn.chatgpt.com (the old pages redirect).

==================================================
1. DSH IDENTIFICATION (high confidence)
==================================================
DSH = DeepSeek Harness, DeepSeek AI's official open-source agent harness.
- Repo: https://github.com/deepseek-ai/deepseek-harness (MIT; HEAD 22ddee3, 2026-10-23)
- Docs: https://deepseek-harness.github.io/deepseek-harness/
- npm `@deepseek-ai/dsh`: latest 0.2.1-rc.2, next 0.2.1-rc.3
- The README calls it a developer preview and says "THERE WILL BE COMPATIBILITY-BREAKING CHANGES."

Why it matches the user's description:
- `npx @deepseek-ai/dsh web` starts a Web UI at http://127.0.0.1:3080.
- You paste the API key under Settings > Models; it is stored in `$DSH_HOME/.credentials.yaml`. `DEEPSEEK_API_KEY` also works (README; https://docs.requesty.ai/integrations/deepseek-harness).
- It also ships a desktop app (`apps/desktop`), plus `tui`, `acp`, `sdk` (stdio JSON-RPC) and a Python SDK.
- It runs on the Cordis plugin framework. Configuration lives in profiles at `~/.dsh/profiles/<p>/cordis.patch.yml`.

Not to be confused with: Hmbown/DeepSeek-TUI or holasoymalva/deepseek-cli (third-party tools).

Capabilities (each from the repo README for that package):
- **Tools:** file read/write/edit, shell, persistent terminal, LSP, web search/fetch. Sandboxing uses bwrap/Landlock on Linux, Seatbelt on macOS, a restricted token on Windows (`packages/sandbox`).
- **Instruction files:** reads both AGENTS.md and CLAUDE.md, plus `*.local.md` overlays.
  - Loads files from the project root down to the working directory; deeper files load when a read/write/edit reaches that directory.
  - User-global files: `$DSH_HOME/AGENTS.md`, then `~/.agents/AGENTS.md`.
  - A CLAUDE.md identical to its AGENTS.md is shown only once. Budget is 64 KiB per chain.
  - `@path` imports and `.claude/rules/` are NOT interpreted (`packages/context/agent-instructions/README.md`).
- **Skills:** `<name>/SKILL.md` or a flat `<name>.md` in `.dsh/skills`, `.agents/skills`, custom directories, `~/.dsh/skills`, `~/.agents/skills`. It does NOT read `.claude/skills`. Honors `disable-model-invocation` and `user-invocable`; the user can type `/name` to invoke one (`packages/skill/skill-filesystem`, `tool-skill`).
- **Slash commands and plugins:** the only slash commands are skills invoked with `/name`. Plugins are Cordis bundles, plus an experimental "Custom plugin indexes" bundle that adds a Discover tab (`docs/user/guide/plugin-market.md`).
- **Subagents:** in-process (fresh or forked from the parent's history), or out-of-process through ACP, a real Codex child (app-server protocol), a real Claude Code child (Agent SDK), or another DSH runtime.
  - Per-child `provider`/`model`/`reasoningEffort` can be fixed in `agentOptions`.
  - With `modelSelection: true`, the model picks from an allowlist of routes. This works only for in-process and DSH-SDK children; Codex, Claude Code and ACP children reject it (`packages/subagent/tool-subagent/README.md`).
  - Also has a `workflow` tool for scripted fan-out and an experimental agent-team.
- **MCP client:** stdio and Streamable HTTP, configured in Cordis YAML. It does not read `.mcp.json`. MCP prompts are unsupported (`packages/mcp/mcp-client`).
- **Hooks:** no native shell-hook system. Two experimental, opt-in bridges replay an existing hooks.json:
  - Claude Code bridge: 7 events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop).
  - Codex bridge: 5 events.
  - Only command handlers run; exit 2 blocks.
  - Gaps: `stop_hook_active` is always false and there is no cap on consecutive blocks; `continue:false` is not honored; `updatedInput` is ignored; `transcript_path` is empty; the Codex bridge passes non-shell tool input only as `{command}` (`packages/experimental/hooks-claude-code`, `hooks-codex`).
- **Headless:** `dsh --profile headless [--json] [--session-id] [--permission-mode] "task"` (`docs/cli-help.md`). No dollar cap documented.
- **Browser:** experimental providers for Playwright MCP, Chrome DevTools MCP and Stagehand.
- **Models:** DeepSeek by default (efforts off/low/high/max), plus Anthropic, OpenAI, Bedrock, Vertex, Azure and any OpenAI-compatible endpoint.
- **Built-in AGENTS.md support:** yes, as above.

==================================================
2. CAPABILITY MATRIX
==================================================
The ChatGPT desktop app's Codex mode is what used to be the Codex desktop app (https://learn.chatgpt.com/docs/whats-new, https://learn.chatgpt.com/codex/app).

**INSTRUCTION FILES**
- **Claude Code CLI and Desktop**
  - Reads CLAUDE.md, `.claude/CLAUDE.md`, CLAUDE.local.md, `~/.claude/CLAUDE.md`, managed policy files, and `.claude/rules/*.md` (rules can be scoped to paths).
  - Ancestor files load at start; subdirectory files load lazily.
  - `@path` imports work, up to 4 hops.
  - AGENTS.md is read natively from v2.1.277. The default setting (`claude-md-or-agents-md`) reads AGENTS.md ONLY if there is no CLAUDE.md or CLAUDE.local.md in the working directory or above.
  - `claude-md-and-agents-md` loads both. It is set under `pluginConfigs."cc-plugin-agents-md@builtin"` in user or managed settings only; project settings ignore it.
  - Source: https://code.claude.com/docs/en/memory
- **Codex CLI and app**
  - Each directory contributes at most one file: AGENTS.override.md, then AGENTS.md, then any `project_doc_fallback_filenames`. Files load from the root down to the working directory.
  - Global file lives in `~/.codex` (or `CODEX_HOME`). Total cap is 32 KiB (`project_doc_max_bytes`).
  - CLAUDE.md is read only if you add it to the fallback list. Imports are undocumented.
  - Source: https://learn.chatgpt.com/docs/agent-configuration/agents-md
  - App behavior is undocumented, but the app shares `config.toml` (https://learn.chatgpt.com/codex/models).
- **DSH:** see section 1.

**SKILLS (Agent Skills standard)**
- **Claude Code**
  - Paths: `.claude/skills` (project, its ancestors, nested lazily), `~/.claude/skills`, plugins, `--add-dir`. NOT `.agents/skills`.
  - A skill entry can be a symlink to a directory elsewhere.
  - Extra frontmatter beyond the spec: `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `allowed-tools`, `disallowed-tools`, `disable-model-invocation`, `user-invocable`.
  - Desktop also loads `~/.claude/skills` and skills from the claude.ai account.
  - Sources: https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/desktop
- **Codex**
  - Paths: `$CWD/.agents/skills`, parent directories up to the repo root, `~/.agents/skills`, `/etc/codex/skills`, bundled system skills.
  - Only `name` and `description` are documented. `agents/openai.yaml` holds policy and UI metadata.
  - Invoke with `$skill` or `/skills`. Documented for the CLI, IDE extension and app; `exec` is undocumented.
  - Source: https://learn.chatgpt.com/codex/skills
- **DSH:** `.dsh/skills` and `.agents/skills` (see section 1).

**COMMANDS AND PLUGINS**
- **Claude Code**
  - `.claude/commands` has been merged into skills.
  - Plugins: `.claude-plugin/plugin.json` with skills, commands, agents, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `bin/`, workflows, monitors.
  - Marketplaces use `marketplace.json`. "Mods" are a Claude-only code extension.
  - Source: https://code.claude.com/docs/en/plugins-reference
- **Codex**
  - Custom prompts are deprecated; use skills instead (https://learn.chatgpt.com/docs/custom-prompts).
  - Plugins bundle skills, MCP servers, browser extensions and hooks, and are shared through marketplaces (https://learn.chatgpt.com/codex/plugins). Manifest paths weren't verified.
  - "Agent import" (`/import`) brings in instructions, skills and plugins from Claude Code, Claude Cowork and Cursor.
- **DSH:** `/name` skills and Cordis bundles.

**SUBAGENTS, MODEL AND EFFORT**
- **Claude Code**
  - Definitions: `.claude/agents/*.md`, `~/.claude/agents`, plugins, or `--agents` JSON.
  - Fields include `tools`, `disallowedTools`, `model` (alias, full ID or `inherit`), `effort` (low/medium/high/xhigh/max), `permissionMode`, `skills`, `mcpServers`, `hooks`, `isolation: worktree`, `background`, `maxTurns`.
  - Effort precedence: `CLAUDE_CODE_EFFORT_LEVEL`, then the per-invocation value, then frontmatter, then the session setting.
  - Claude can choose model and effort per invocation. Other routing: `opusplan` (Opus for planning, Sonnet for execution) and a `fallbackModel` chain.
  - There is NO "auto" effort: `/effort auto` just clears the saved level for the active model.
  - Agent teams are experimental and interactive-only.
  - Sources: https://code.claude.com/docs/en/sub-agents, https://code.claude.com/docs/en/model-config, https://code.claude.com/docs/en/agent-teams
- **Codex**
  - Definitions: `.codex/agents/*.toml` and `~/.codex/agents`. Fields: `name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`.
  - A custom agent CANNOT override `sandbox_mode`, `approval_policy`, `model_provider` or `mcp_servers`.
  - `[agents]` sets `default_subagent_model`, `default_subagent_reasoning_effort` and `max_concurrent_threads_per_session`. In source the defaults are 6 threads and depth 1 (`codex-rs/core/src/config/mod.rs`).
  - No automatic routing.
  - Source: https://learn.chatgpt.com/codex/subagents
- **DSH:** see section 1.

**MCP CLIENT**
- **Claude Code:** supported on all surfaces. Tool search is off by default when `ANTHROPIC_BASE_URL` points at a non-Anthropic host (https://code.claude.com/docs/en/feature-availability).
- **Codex:** `[mcp_servers]` in `config.toml`, over stdio or Streamable HTTP with OAuth. "The ChatGPT desktop app, Codex CLI, and IDE extension share this configuration" (https://learn.chatgpt.com/docs/extend/mcp). `codex exec` exits if a required server fails to start.
- **DSH:** yes.

**HOOKS**
- **Claude Code**
  - 33 events. Handler types: command, http, mcp_tool, prompt, agent. Exit 2 blocks.
  - "fires the same hook events wherever it runs: ... the Desktop app, and cloud sessions" (https://code.claude.com/docs/en/hooks).
  - `-p` runs hooks unless `--bare` is set. `--bare` skips hooks, skills, plugins, MCP and CLAUDE.md, and "will become the default for -p" (https://code.claude.com/docs/en/headless).
- **Codex**
  - 12 events: PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt, SessionStart, SessionEnd.
  - Handlers: command and mcp_tool run; prompt and agent are parsed but skipped.
  - Locations: `~/.codex` and `<repo>/.codex` (repo hooks load only if the project is trusted), plugins, `requirements.toml` (managed, "trusted by policy").
  - New or changed hooks are skipped until trusted with `/hooks` (https://learn.chatgpt.com/docs/hooks).
  - The docs say nothing about exec. In source, `codex-rs/exec/tests/suite/hooks.rs` runs a SessionStart hook under `codex exec --dangerously-bypass-hook-trust`, and that flag is global for exec. So hooks run in exec; untrusted ones are skipped.
  - Desktop app: undocumented.
- **DSH:** experimental bridges (see section 1).

**HEADLESS, CLOUD AND BACKGROUND**
- **Claude Code**
  - `claude -p` with `--output-format json|stream-json`, `--json-schema`, `--max-budget-usd`, `--permission-mode`, `--permission-prompts none`, `--worktree`.
  - From v2.1.302, `-p` starts in Manual permission mode.
  - A `-p` run waits for background work, capped at 10 minutes idle by default.
  - Cloud sessions and routines need a claude.ai subscription.
- **Codex**
  - `codex exec` with `--json`, `--output-schema`, `-o`, `--sandbox workspace-write`, `--ephemeral`, `resume`. `--full-auto` was removed. No dollar cap documented (https://learn.chatgpt.com/codex/non-interactive-mode).
  - Codex Cloud supports reusable environments (https://learn.chatgpt.com/codex/cloud).
- **DSH:** headless profile; no cloud.

**DESKTOP APP PARITY**
- **Claude Code Desktop**
  - "reads the same settings files as the CLI"; hooks fire the same.
  - It does not inherit your full shell environment: on macOS it takes PATH but not other exports.
  - Worktree sessions read settings, hooks, skills and `.mcp.json` from the main checkout's root.
  - It requires a claude.ai subscription, though gateway routing can be configured in the app.
- **ChatGPT desktop app (Codex mode):** shares `config.toml`, MCP and models with the CLI. Skills and subagents are documented. Hooks are undocumented.
- **DSH:** the Web UI and desktop app use the same profile system (my inference from the repo, not stated outright).

**BROWSER**
- **Claude Code**
  - Claude in Chrome (`--chrome`) requires `/login` with a claude.ai account. It stays OFF with an API key or token, so it is unusable with DeepSeek (https://code.claude.com/docs/en/chrome).
  - Desktop has a Browser pane with `.claude/launch.json` and `autoVerify`.
- **Codex app:** built-in browser; supports Chrome, Edge, Brave, Opera and Vivaldi.
- **Portable:**
  - Playwright MCP: `--headless`, and `--isolated` or a separate `--user-data-dir` per parallel agent, because "A persistent profile can only be used by one browser instance at a time." Its README also suggests Playwright CLI plus skills as a more token-efficient option (https://github.com/microsoft/playwright-mcp).
  - Chrome DevTools MCP: `--headless --isolated`, `--slim` (https://github.com/ChromeDevTools/chrome-devtools-mcp).

**DEEPSEEK (Oct 2026)**
- **Models**
  - `deepseek-flash` = V4.1-Flash-1017, released 2026-10-17. `deepseek-v4-pro` = V4-Pro-0813.
  - Both: 1M context, 384K max output, tool calls, Responses API and Anthropic API. Image input on flash only.
  - Official CNY prices per 1M tokens, off-peak/peak:
    - flash: cache hit 0.02/0.04, cache miss 1/2, output 4/8
    - pro: cache hit 0.15/0.30, cache miss 4.5/9, output 13.5/27
  - Peak hours are 9–12 and 14–18 Beijing time on weekdays. Concurrency limits: 2,500 (flash) and 500 (pro).
  - Search/Fetch are free through DSH, Claude Code and Codex until 2026-11-01, then 5 CNY per 1,000 requests.
  - Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing. A third-party USD conversion has flash cache-miss input at $0.15/$0.30 (https://www.morphllm.com/deepseek-api).
- **Reasoning**
  - Thinking is on by default at effort `high`. Only `low`, `high` and `max` exist (plus off).
  - Other names are mapped: minimal→low; medium/xhigh→high; ultra→max.
  - When tools are used, `reasoning_content` must be passed back on every request or the API returns a 400 error (https://api-docs.deepseek.com/guides/thinking_mode).
- **Tool-use quality:** V4.1-Flash's per-harness results (https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash):

  | Harness | DeepSWE v1.1 | Terminal-Bench 2.1 |
  |---|---|---|
  | Claude Code | 69.8 | 88.0 |
  | Codex | 65.6 | 84.1 |
  | OpenCode | 65.5 | 85.0 |
  | DSH Minimal | 72.6 | 90.6 |
  | mini-SWE | 74.2 | 90.3 |

  The 1017 release note says it is optimized for DSH (https://api-docs.deepseek.com/news/news261017).
- **DeepSeek in Claude Code**
  - Settings: `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN`; models `deepseek-flash[1m]` (opus/sonnet slots) and `deepseek-flash` (haiku slot and subagents); `CLAUDE_CODE_EFFORT_LEVEL=max`; `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432` (https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/).
  - Names starting `claude-opus` go to v4-pro; other `claude*` names go to flash.
  - The endpoint ignores `cache_control`, `tool_result.is_error`, `disable_parallel_tool_use` and `mcp_servers`. It rejects document blocks and `redacted_thinking` (https://api-docs.deepseek.com/guides/anthropic_api).
  - Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" (https://code.claude.com/docs/en/llm-gateway).
  - You lose Chrome, cloud sessions, Remote Control, and Desktop (unless a gateway is configured).
- **DeepSeek in Codex**
  - `[model_providers.deepseek]` with `base_url="https://api.deepseek.com/"` and `wire_api="responses"` (https://api-docs.deepseek.com/quick_start/agent_integrations/codex/).
  - `wire_api="chat"` now fails with `CHAT_WIRE_API_REMOVED_ERROR` (`codex-rs/model-provider-info/src/lib.rs`).
  - Web search works only with v4-pro.
- **DeepSeek in OpenCode** (DeepSeek lists it as an integration)
  - Reads AGENTS.md, falling back to CLAUDE.md.
  - Skills from `.opencode`, `.claude` and `.agents` skill directories.
  - Markdown agents with `model` plus a pass-through `reasoningEffort`.
  - JS plugins with `tool.execute.before`/`after`. No compatibility with Claude Code hooks is documented.
  - Sources: https://opencode.ai/docs/rules/, /skills/, /agents/, /plugins/

**SYNC TOOLS**
- **rulesync v40.2.0** (https://github.com/dyoshikawa/rulesync). Features: rules, mcp, commands, subagents, skills, hooks, permissions.
  - Claude Code: all of them.
  - Codex CLI: all of them (commands global-only).
  - OpenCode: all of them.
  - DeepSeek Harness: rules, mcp and skills only.
- **ruler 0.3.46, beta** (https://github.com/intellectronica/ruler): rules, MCP, skills, subagents. No hooks, no DSH target.

**AGENT SKILLS STANDARD**
- Spec fields: `name` and `description` are required; `license`, `compatibility`, `metadata` and `allowed-tools` (experimental) are optional (https://agentskills.io/specification).
- Client guidance recommends scanning `<project>/.agents/skills` and `~/.agents/skills`.
- Showcase list (46 entries, from the repo as of Aug 9; https://agentskills.io/clients): Junie, ZeroClaw, Gemini CLI, Autohand, OpenCode, OpenHands, Mux, Cursor, Amp, Letta, Firebender, Goose, GitHub Copilot, VS Code, Claude Code, Claude, ChatGPT & Codex, Piebald, Factory, pi, Databricks Genie Code, Agentman, TRAE, Spring AI, Roo Code, Mistral Vibe, Command Code, Ona, VT Code, Qodo, Laravel Boost, Emdash, Snowflake Cortex Code, Kiro, Workshop, Google AI Edge Gallery, nanobot, fast-agent, bub, Tabnine, Vita, Superconductor, Deep Code, Pulumi Neo, Hermes Agent, OpenClaw.
- DSH implements the format but isn't on the list.

**MAC FOOTPRINT**
- Documented:
  - Codex defaults to 6 concurrent subagent threads with depth 1.
  - Claude: "Start with 3-5 teammates."
  - Playwright: one browser per persistent profile; headless browsers close after 1 hour idle by default.
  - Each worktree is a full checkout and needs its own dependency install. Worktrees created by `-p` runs are not cleaned up automatically (https://code.claude.com/docs/en/worktrees).
- Undocumented (my estimate, not measured on a Mac): a few hundred MB per agent CLI; about 150–500 MB per headless Chromium. Practical limits: roughly 4–6 agents plus 1–2 browsers on 16 GB, roughly 8–12 on 32 GB. The usual bottleneck is builds and tests running in each worktree, not the agents.

==================================================
3. PORTABLE CORE (works in all three plus OpenCode)
==================================================
- **AGENTS.md as the one instruction source.** Keep it under 32 KiB and use no `@imports` (Codex and DSH don't expand them). Make CLAUDE.md a symlink to AGENTS.md: Claude reads a symlinked file once, DSH shows identical content once, Codex ignores CLAUDE.md.
- **Skills** in `.agents/skills/<name>/SKILL.md` using only spec frontmatter, with logic in `scripts/`.
- **Gates as executables** any shell tool can call (`jarvis gate test|lint|review|done`) that exit non-zero and emit JSON.
- **Plain git worktrees, and MCP servers over stdio or HTTP** (the config file differs per harness; the servers are the same).
- **A one-shot headless mode with JSON events:** `claude -p`, `codex exec`, `dsh --profile headless --json`.
- **Subagents with a fixed model and effort per role** (each harness has its own file format).
- **Common hook subset:** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop, using command handlers where exit 2 blocks.
- **Playwright MCP for browser work.**

==================================================
4. PER-HARNESS ADAPTERS (shims needed)
==================================================
- **Skills:** per-skill symlinks in `.claude/skills/<name>` (Claude doesn't scan `.agents`). Claude-only frontmatter (`context: fork`, `model`, `effort`) goes only into generated Claude copies. Codex invocation policy goes in `agents/openai.yaml`.
- **Subagents:** generate `.claude/agents/*.md`, `.codex/agents/*.toml`, and DSH `tool-subagent` `agentOptions`/presets from one routing table (role → provider/model/effort).
  - Effort map:
    - Claude: low/medium/high/xhigh/max
    - Codex: Light (low) through Ultra
    - DeepSeek: low/high/max only, so medium collapses to high
- **Hooks:** a single `jarvis-hook <event>` entrypoint, written into `.claude/settings.json`, `.codex/hooks.json`, and a DSH profile that mounts `hooks-claude-code` pointed at the same JSON.
  - Codex: run `/hooks` trust once, pass `--dangerously-bypass-hook-trust` in exec, or ship `requirements.toml`.
  - The script must normalize payload differences (Codex `tool_input`; DSH bridge gives `{command}` only and an empty transcript path).
  - The Stop gate must limit itself with a counter file, because DSH lacks a loop guard.
- **MCP:** emit `.mcp.json`, `.codex/config.toml`, and DSH YAML. rulesync covers all three.
- **Runner flags:**
  - Claude: `-p --bare` plus explicit `--settings`, `--plugin-dir`, `--mcp-config`, `--agents`. Don't rely on auto-discovery, since `--bare` becomes the default for `-p`.
  - Codex: `exec --sandbox ... -c ...`.
  - DSH: a dedicated Jarvis profile.
  - Budget: only Claude has `--max-budget-usd`. For Codex and DSH, Jarvis must enforce caps itself from usage in the JSON events, plus turn and time limits.
- **Provider:** DeepSeek in Claude Code through environment variables, in Codex through `model_providers`, in DSH natively.

==================================================
5. WHAT CAN'T BE MADE EQUIVALENT
==================================================
- **Identical behavior isn't achievable.** The same DeepSeek model scores 65.5–74.2 on DeepSWE and 84.1–90.6 on Terminal-Bench 2.1 depending only on the harness. Each harness owns its system prompt, edit-tool schema (apply_patch vs str_replace) and compaction. Switching model provider changes the reasoning itself.
- **Hook coverage differs.**
  - Event count: 33 (Claude), 12 (Codex), 7/5 (DSH bridges).
  - Only Claude has prompt/agent/http handler types.
  - Codex re-trusts hooks per hash.
  - DSH bridges are experimental and partial.
  - Hooks in the ChatGPT desktop app are undocumented.
- **No harness routes model or effort by rules.** Claude and DSH can let the model choose per call, which isn't deterministic.
- **Claude-only features:** agent teams, workflows, mods, monitors, Chrome, cloud sessions.
- **Codex-only:** Cloud. Codex subagents can't override sandbox or MCP settings.
- **Claude Code on DeepSeek isn't supported by Anthropic.** It loses Chrome, Desktop (without a gateway) and cloud, and the endpoint ignores `is_error`.
- **DeepSeek has 3 effort levels.** Claude 5.5-series models can't turn thinking off.
- **DSH is a developer preview with breaking changes.**

==================================================
6. RECOMMENDED APPROACH
==================================================
1. **One source, generated outputs.** `jarvis/` YAML holds rules, roles, the routing table, gates, hooks and MCP. `jarvis sync` generates each harness's files; use rulesync as the emitter for rules, MCP, skills, subagents and hooks, plus Jarvis's own adapters for DSH hooks and subagents and for effort mapping. Commit the generated files and fail CI on drift (`jarvis sync --check`).
2. **Enforce in code, not prose.** Instructions say "run `jarvis gate X`". Hooks enforce it where they exist (a PreToolUse denylist; a Stop hook that blocks with exit 2 until `jarvis gate done` passes). The outer runner always re-checks the gates after a run, so "done" is decided by Jarvis, outside the model.
3. **Use an external orchestrator for long autonomous runs.** Jarvis runs a headless session per subtask, each in its own worktree. It picks model and effort from its own table rather than letting the model choose, and keeps state in files (plan, a JSON task ledger) so any harness can resume. Interactive and desktop use read the same files on a best-effort basis.
4. **Pin a primary harness per model family.**
   - Claude Code for Claude models.
   - Codex for OpenAI models.
   - DSH (or Claude Code through DeepSeek's officially documented endpoint) for DeepSeek.
   - The harness moves results as much as the model does, so switching providers inside one harness gives the most comparable behavior.
5. **Measure parity instead of assuming it.** Run a nightly conformance suite of golden repos across the harness × model matrix. Assert gate outcomes, hook-fire logs, skill-load markers, and the subagent model and effort taken from the JSON events.
6. **Pin versions:** Claude Code ≥2.1.277 (AGENTS.md) and ≥2.1.302 (`-p` defaults); an exact DSH rc.
7. **Mac defaults:** concurrency 4; Playwright MCP with `--headless --isolated` per agent or one shared pool, with an idle timeout; a scheduled cleanup for `-p` worktrees; shared package-manager caches.

Local clones used for source checks (scratch, can be deleted):
- /home/claude/deepseek-ai/deepseek-harness
- /home/claude/openai/codex (sparse)
- /home/claude/agentskills/agentskills
- /home/claude/sync/rulesync
- /home/claude/sync/ruler