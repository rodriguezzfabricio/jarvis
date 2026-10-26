# Credits

Jarvis's skills borrow from other open-source work (decision 31). Each borrowed piece is listed here with its source and license, and each skill that adapts one says so in its opening lines.

## superpowers

- **Source:** https://github.com/obra/superpowers, by Jesse Vincent.
- **License:** MIT (notice below).
- **Used in:**
  - `build`: adapted from `test-driven-development` (the red-green-refactor cycle, "no production code without a failing test first", its rationalizations list), `verification-before-completion` (no completion claims without fresh verification) and the implementer prompt and status contract from `subagent-driven-development` and `executing-plans`.
  - `debug`: adapted from `systematic-debugging` (root cause before fixes, the four phases, one hypothesis at a time, the stop after 3 failed fixes) together with the test-first and verification rules above.
- **What changed:** the skills were rewritten for Jarvis's task sessions. A session runs unattended under `dontAsk`, so "ask your human partner" became a status in the result notes. The session never commits (the runner does), runs one plain shell command per call (decision 68), never touches protected checks (decision 15), and its notes are claims that the runner's checks confirm or refute (decision 49). Escalation goes through the runner's routing table (decision 24) instead of a conversation. superpowers' brainstorming is not used; Jarvis's own intake replaces it (decision 30).

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Compound Engineering

- **Source:** https://github.com/EveryInc/compound-engineering-plugin, by EveryInc.
- **License:** MIT.
- **Used in:**
  - `compound`: the durable-learning test ("would losing it mean rediscovering it?"), one learning per solved problem, and the refresh pass that retires notes that drifted.
  - `sweep`: the pattern of a scheduled sweep that reports and proposes instead of editing.
- **What changed:** ideas only, rewritten for Jarvis; no text or code was copied, so no license notice is reproduced. Learnings go to Jarvis's memory files through the CLI instead of a `docs/solutions/` folder, need a runner-written source (decision 49), and a lesson seen twice becomes a rule the user approves (decision 28).

## gitleaks default rules

- **Source:** https://github.com/gitleaks/gitleaks/blob/v8.28.0/config/gitleaks.toml, by Zachary Rice and the gitleaks contributors.
- **License:** MIT (notice below; also in `packages/cli/src/security/gitleaks-LICENSE`).
- **Used in:** the security pass behind the `security` skill. `packages/cli/src/security/gitleaks.toml` is the default config embedded in the pinned gitleaks 8.28.0 binary (all 217 rules).
- **What changed:** the global `paths` allowlist and three path-scoped rule allowlists were removed, so dependency folders, lockfiles and images are scanned too (backlog 105). Rules and value-based allowlists are unchanged. The runner passes it with `--config`; it is never read from the candidate tree.

```
MIT License

Copyright (c) 2019 Zachary Rice

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ideas only (no text copied)

- **OpenAI, "harness engineering" post:** an `AGENTS.md` of about 100 lines used as a table of contents into `docs/`, which is the system of record, and recurring cleanup agents. Used in `onboard` (the `AGENTS.md` cleanup task) and `sweep`.
- **Claude Code's auto-memory format** (https://code.claude.com/docs/en/memory): a `MEMORY.md` index capped at about 200 lines plus typed notes (`user`, `feedback`, `project`, `reference`). Used in `compound` (decision 27).
