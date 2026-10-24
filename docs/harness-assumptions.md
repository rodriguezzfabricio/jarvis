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
| The sandbox denial record required by the probe's network check | curl's `000` can't tell a policy denial from a DNS or TLS failure | Never; it's the evidence that the policy, not luck, blocked the host |
| Private per-run toolchain cache | Sessions can write the cache, so a shared one carries data between runs | A runner-managed read-only mirror plus a private overlay gives the same isolation faster |
| `__CF_USER_TEXT_ENCODING` allowed in the review runner's environment test (decision 66) | macOS adds it to every started process, even under `env -i`; the runner supplies only four keys | Never on macOS; re-check the observed set on each macOS update, and allow nothing else |
| Avoiding compound shell commands in sessions (stage 3 build and debug skills: one plain command per call; repeated work goes in a `.jarvis/scratch/` script run with `sh`) | Under `dontAsk`, Claude Code refuses some compound commands (`for` loops) even when sandboxed | A Claude Code version auto-allows sandboxed compound commands (re-test on each pin) |
| `jarvis decide --by user` trusts its caller (decision 85) | Firmness holds only if a session never claims to be Fabricio; the skills record `--by user` only for answers they received from an intake round | `--by user` checks the ledger for the intake answer it cites |
