# Harness assumptions

Each piece of scaffolding, the weakness it covers, and how to tell when it can go (decision 29).

| Scaffolding | Covers | Remove when |
|---|---|---|
| Live canary probe in `jarvis doctor` (decision 59) | Claude Code silently drops a whole `--settings` file when one value is invalid, so a written file isn't proof the protections are on | Claude Code fails loudly on invalid settings in `-p` mode *and* exposes the effective sandbox config in `init`. Keep the probe anyway as a smoke test. |
| Positive controls in the probe | A dropped settings file plus `dontAsk` refuses everything, which would otherwise look like "everything blocked = safe" | Never; it's what makes the probe meaningful |
| `realpath` for socket and sandbox paths | The macOS sandbox matches only real paths (`/tmp` → `/private/tmp`) | Claude Code resolves symlinks itself (re-test on each pin) |
| Built-in-plugin filter in the probe | 2.1.309 lists `…@builtin` plugins in `init` even with `--setting-sources project` | Not a weakness: keep it, re-check the format on each pin |
| Clean child environment (decision 58) | Wrappers and shell profiles can reroute or rebill a session | Never |
| ntfy answer confirmations and first-answer-wins (decision 50) | The iOS ntfy app gives no feedback after a button tap, so people tap repeatedly | The ntfy iOS app shows tap feedback; keep first-answer-wins regardless |
