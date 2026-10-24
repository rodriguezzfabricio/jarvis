#!/bin/sh
# Jarvis installer (architecture §8 stage 7). POSIX sh, safe to run again.
#
# What it does, in order:
#   1. checks macOS, Node 24 and pnpm
#   2. checks the pinned Claude Code and Codex (it never downloads or installs either)
#   3. installs dependencies with `pnpm install --frozen-lockfile`
#   4. writes a `jarvis` launcher into <prefix>/bin (default ~/.local/bin)
#   5. adds this checkout as a Claude Code plugin marketplace and installs the jarvis plugin (user scope)
#   6. runs `jarvis doctor` (not --live)
#
# It never uses sudo, never touches credentials and never changes your everyday `claude` or `codex`.
# --dry-run prints what it would change and changes nothing.

set -eu

CLAUDE_VERSION="2.1.309" # keep in sync with packages/cli/src/config/pins.ts
CODEX_VERSION="0.164.0"  # keep in sync with packages/cli/src/config/pins.ts
MARKER="# jarvis launcher, written by scripts/install.sh"

DRY_RUN=0
OFFLINE=0
PLUGIN=1
DOCTOR=1
PREFIX=""
NODE_BIN=""

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

  --dry-run       print what would change, change nothing
  --prefix DIR    install the jarvis launcher into DIR/bin (default: ~/.local)
  --node PATH     the Node 24 binary to use (default: node on PATH)
  --offline       pass --offline to pnpm (only after an earlier online install on this machine)
  --no-plugin     skip installing the Claude Code plugin
  --no-doctor     skip running jarvis doctor at the end
  -h, --help      show this help
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --offline) OFFLINE=1 ;;
    --no-plugin) PLUGIN=0 ;;
    --no-doctor) DOCTOR=0 ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a directory"; PREFIX=$2; shift ;;
    --prefix=*) PREFIX=${1#--prefix=} ;;
    --node) [ $# -ge 2 ] || die "--node needs a path"; NODE_BIN=$2; shift ;;
    --node=*) NODE_BIN=${1#--node=} ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# Runs a command that changes something, or prints it under --dry-run. $1 is how to show it.
run() {
  shown=$1
  shift
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: $shown"
  else
    say "running: $shown"
    "$@"
  fi
}

# Single-quotes a string for a shell script.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

[ -n "${HOME:-}" ] || die "HOME is not set"
[ "$(id -u)" -ne 0 ] || die "don't run the installer as root or with sudo; it only writes to your own folders"
[ -n "$PREFIX" ] || PREFIX="$HOME/.local"
case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path" ;; esac

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
[ -f "$REPO/packages/cli/src/cli.ts" ] || die "can't find the Jarvis checkout next to this script ($REPO)"
if [ "$DRY_RUN" -eq 1 ]; then say "Dry run: nothing will be changed."; fi
say "Jarvis checkout: $REPO"

# 1. Platform, Node, pnpm ------------------------------------------------------------------------
step "Checking macOS, Node 24 and pnpm"
[ "$(uname -s)" = "Darwin" ] || die "Jarvis v1 runs on macOS only (found $(uname -s))"
say "ok    macOS $(sw_vers -productVersion 2>/dev/null || echo '')"

if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null) || die "Node 24 not found on PATH. Install it (for example: brew install node@24), or pass --node /path/to/node"
fi
case "$NODE_BIN" in /*) ;; *) die "--node must be an absolute path (the launcher calls it by that path)" ;; esac
[ -x "$NODE_BIN" ] || die "not an executable: $NODE_BIN"
NODE_VERSION=$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null) || die "could not run $NODE_BIN"
case "$NODE_VERSION" in
  24.*) say "ok    node $NODE_VERSION ($NODE_BIN)" ;;
  *) die "Jarvis needs Node 24; $NODE_BIN is $NODE_VERSION. Install Node 24 or pass --node /path/to/node24" ;;
esac

PNPM_BIN=$(command -v pnpm 2>/dev/null) || die "pnpm not found on PATH. Node 24 ships corepack: run 'corepack enable pnpm' (or 'brew install pnpm')"
say "ok    pnpm ($PNPM_BIN)"

# 2. Pinned binaries (checked, never installed) ----------------------------------------------------
step "Checking pinned Claude Code $CLAUDE_VERSION and codex-cli $CODEX_VERSION"
CLAUDE_BIN="$HOME/.local/share/claude/versions/$CLAUDE_VERSION"
CLAUDE_OK=0
if [ -x "$CLAUDE_BIN" ]; then
  CLAUDE_REPORTED=$("$CLAUDE_BIN" --version 2>/dev/null || true)
  case "$CLAUDE_REPORTED" in
    "$CLAUDE_VERSION "*) CLAUDE_OK=1; say "ok    $CLAUDE_BIN ($CLAUDE_REPORTED)" ;;
    *) warn "$CLAUDE_BIN reports '$CLAUDE_REPORTED', expected $CLAUDE_VERSION" ;;
  esac
else
  warn "pinned Claude Code not found at $CLAUDE_BIN"
  warn "install it yourself (the README says how: 'claude install $CLAUDE_VERSION'), then run this installer again"
fi
CODEX_BIN="$HOME/.npm-global/bin/codex"
if [ -x "$CODEX_BIN" ]; then
  CODEX_REPORTED=$("$CODEX_BIN" --version 2>/dev/null || true)
  case "$CODEX_REPORTED" in
    *"$CODEX_VERSION"*) say "ok    $CODEX_BIN ($CODEX_REPORTED)" ;;
    *) warn "$CODEX_BIN reports '$CODEX_REPORTED', pinned $CODEX_VERSION; reviews fall back to the Claude reviewer" ;;
  esac
else
  warn "codex-cli not found at $CODEX_BIN (optional: reviews fall back to the Claude reviewer)"
fi

# 3. Dependencies -----------------------------------------------------------------------------------
step "Installing dependencies (pnpm install --frozen-lockfile)"
PNPM_FLAGS="--frozen-lockfile"
if [ "$OFFLINE" -eq 1 ]; then PNPM_FLAGS="$PNPM_FLAGS --offline"; fi
# shellcheck disable=SC2086 # PNPM_FLAGS is a fixed list of flags
run "(cd $REPO && pnpm install $PNPM_FLAGS)" sh -c 'cd "$1" && shift && exec "$@"' sh "$REPO" "$PNPM_BIN" install $PNPM_FLAGS

# 4. The jarvis launcher -----------------------------------------------------------------------------
step "Linking the jarvis command into $PREFIX/bin"
LAUNCHER="$PREFIX/bin/jarvis"
if [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
  if [ -f "$LAUNCHER" ] && grep -qF "$MARKER" "$LAUNCHER" 2>/dev/null; then
    say "found an earlier Jarvis launcher; it will be rewritten"
  else
    die "$LAUNCHER exists and was not written by this installer; move it away or pass --prefix"
  fi
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would write $LAUNCHER: exec $NODE_BIN $REPO/packages/cli/src/cli.ts"
else
  mkdir -p "$PREFIX/bin"
  TMP_LAUNCHER="$LAUNCHER.tmp.$$"
  {
    printf '#!/bin/sh\n%s\n' "$MARKER"
    printf 'exec %s %s "$@"\n' "$(quote "$NODE_BIN")" "$(quote "$REPO/packages/cli/src/cli.ts")"
  } >"$TMP_LAUNCHER"
  chmod 755 "$TMP_LAUNCHER"
  mv -f "$TMP_LAUNCHER" "$LAUNCHER"
  say "wrote $LAUNCHER"
fi
case ":${PATH:-}:" in
  *":$PREFIX/bin:"*) ;;
  *) warn "$PREFIX/bin is not on your PATH. Add this line to ~/.zshrc, then open a new terminal:"
     warn "  export PATH=\"$PREFIX/bin:\$PATH\"" ;;
esac

# 5. The Claude Code plugin ---------------------------------------------------------------------------
# The pinned Claude Code runs with a clean environment (decision 58), so a CLAUDE_CONFIG_DIR or
# provider variable in your shell can't redirect where the plugin is installed.
claude_clean() {
  env -i HOME="$HOME" USER="${USER:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    SHELL="${SHELL:-/bin/sh}" PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$CLAUDE_BIN" "$@"
}
step "Installing the Jarvis plugin into Claude Code (user scope)"
if [ "$PLUGIN" -eq 0 ]; then
  say "skipped (--no-plugin)"
elif [ "$CLAUDE_OK" -eq 0 ]; then
  warn "skipped: the pinned Claude Code $CLAUDE_VERSION is missing; install it, then run this installer again"
else
  MARKETS=$(claude_clean plugin marketplace list --json 2>/dev/null) || MARKETS=""
  PLUGINS=$(claude_clean plugin list --json 2>/dev/null) || PLUGINS=""
  if [ -z "$MARKETS" ] || [ -z "$PLUGINS" ]; then
    warn "skipped: could not list Claude Code plugins with $CLAUDE_BIN"
  else
    MARKET_PATH=$(printf '%s' "$MARKETS" | "$NODE_BIN" -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const m = JSON.parse(s).find((x) => x && x.name === "jarvis");
        process.stdout.write(m ? String(m.path ?? m.installLocation ?? "?") : "");
      });')
    INSTALLED=$(printf '%s' "$PLUGINS" | "$NODE_BIN" -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const p = JSON.parse(s).find((x) => x && x.id === "jarvis@jarvis" && x.scope === "user");
        process.stdout.write(p ? (p.enabled === false ? "disabled" : "enabled") : "");
      });')
    if [ -n "$MARKET_PATH" ] && [ "$MARKET_PATH" != "$REPO" ]; then
      warn "a Claude Code marketplace named 'jarvis' already points at $MARKET_PATH; leaving it alone."
      warn "to use this checkout instead: $CLAUDE_BIN plugin marketplace remove jarvis, then run this installer again"
    else
      if [ -z "$MARKET_PATH" ]; then
        run "$CLAUDE_BIN plugin marketplace add $REPO --scope user (clean environment)" claude_clean plugin marketplace add "$REPO" --scope user
      else
        say "marketplace 'jarvis' already points at this checkout"
      fi
      case "$INSTALLED" in
        enabled) say "plugin jarvis@jarvis already installed and enabled" ;;
        disabled) say "plugin jarvis@jarvis is installed but disabled; enable it with: $CLAUDE_BIN plugin enable jarvis@jarvis" ;;
        *) run "$CLAUDE_BIN plugin install jarvis@jarvis --scope user (clean environment)" claude_clean plugin install jarvis@jarvis --scope user ;;
      esac
    fi
  fi
fi

# 6. Doctor ---------------------------------------------------------------------------------------------
step "Running jarvis doctor (not --live)"
DOCTOR_STATUS=0
if [ "$DOCTOR" -eq 0 ]; then
  say "skipped (--no-doctor)"
elif [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would run: $LAUNCHER doctor"
else
  (cd "$REPO" && "$LAUNCHER" doctor) || DOCTOR_STATUS=$?
fi

step "Done"
if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run finished. Run without --dry-run to install."
  exit 0
fi
if [ "$DOCTOR_STATUS" -ne 0 ]; then
  say "Jarvis is installed, but doctor reported FAIL lines above. Fix them before the first run (see the README's Troubleshooting)."
fi
say "Next: jarvis doctor --live (uses a little plan usage), then open a project in Claude Code and type /jarvis <request>."
