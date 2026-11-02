import type { ScannerPins } from "../security/scanners.ts";
import type { ImpeccablePin } from "../lanes/impeccable.ts";
import type { DependencyPins } from "../release/dependency-pins.ts";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Exact versions Jarvis is tested with (decisions 57, 66). Never "or newer".
 * Binaries are always called by absolute path, never through PATH (decision 58).
 */
export const CLAUDE_CODE_VERSION = "2.1.309";
export const CODEX_VERSION = "0.164.0";

export function pinnedClaudeBin(home: string = homedir()): string {
  return join(home, ".local", "share", "claude", "pinned-bundles", CLAUDE_CODE_VERSION, "claude.app", "Contents", "MacOS", "claude");
}

export function pinnedCodexBin(home: string = homedir()): string {
  return join(home, ".local", "share", "codex", "versions", CODEX_VERSION, "codex");
}

/**
 * The Go toolchain zips sessions may get (decision 123), by `<version>.<os>-<arch>`: the SHA-256 of the module
 * zip as proxy.golang.org serves it (golang.org/toolchain@v0.0.1-<key>.zip). The runner unpacks one only if its
 * bytes hash to this; any other zip, or a version not listed, stops the run. go1.26.10 darwin-arm64 is the zip in
 * jarvis-evals' Go fixture (hidden/go-fixture.sha256 lists the same hash; its go.sum-style hash is
 * h1:SfEWw1me2He9ojf4S+M6xTnGOP6CosVO88yaBsEgjJ0=).
 */
export const GO_TOOLCHAIN_ZIPS: Readonly<Record<string, string>> = {
  "go1.26.10.darwin-arm64": "afb16ae24c172f008db87119f34cf903a295bbad3fa526f7443914b0240b33c7",
};

/**
 * The Rust fixtures sessions may get (decision 164), by `<rust>.<target>`: the SHA-256 of the fixture's file
 * listing (`find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256` inside it), which jarvis-evals
 * keeps as hidden/rust-fixture.sha256. 1.99.1 aarch64-apple-darwin is Rust 1.99.1 (rustup's minimal profile), the
 * Tauri CLI 2.12.3 release binary and the vendored crates of a Tauri 2.12 menu-bar app template: 12,683 files.
 */
export const RUST_FIXTURES: Readonly<Record<string, string>> = {
  "1.99.1.aarch64-apple-darwin": "48d046bbf175d48fd2de34b1c3b6ddd03361dd2017110f16b57f774b9785f226",
};

/** Full model IDs, never aliases (decision 61). */
export const MODELS = {
  strong: "claude-opus-5-5",
  fast: "claude-sonnet-5-5",
  cheap: "claude-haiku-5-5",
} as const;

/** A full Claude model ID such as claude-sonnet-5-5 or claude-haiku-4-5-20251001. */
export const FULL_MODEL_ID = /^claude-[a-z]+-\d+(-\d+)*(-\d{8})?$/;

/** Disk floor (decision 63). */
export const DISK_FLOOR_BYTES = 20 * 1024 ** 3;
export const DISK_SINGLE_WRITER_BYTES = 40 * 1024 ** 3;

/** Maestro for iOS QA flows (decision 18); doctor checks it. */
export function pinnedMaestroBin(home: string = homedir()): string {
  return join(home, ".maestro", "bin", "maestro");
}

/**
 * Impeccable's native engine (decisions 54, 124), never its npm launcher, which can download an engine.
 * This runner-owned copy is the source: installing the design checks copies it into the protected
 * fixtures after checking this hash, because a gate case can't read the home folder.
 */
export const IMPECCABLE_ENGINE_VERSION = "0.1.16";
export const IMPECCABLE_ENGINE_SHA256 = "5c00c3130b961f3aa1066f04ed0e1f58e87808ad153efa00f1c44184800084f2";
export function pinnedImpeccable(home: string = homedir()): ImpeccablePin {
  return {
    bin: join(home, ".jarvis-work", "cache", "impeccable", IMPECCABLE_ENGINE_VERSION, "impeccable"),
    version: IMPECCABLE_ENGINE_VERSION,
    sha256: IMPECCABLE_ENGINE_SHA256,
  };
}

/**
 * Deploy provider CLIs (decision 157), run only by the broker's deploy adapters, outside the sandbox and with a
 * token. Empty until Fabricio picks Vercel or Netlify and installs one exact version: the release step refuses a
 * provider with no pin here, and one whose CLI at pinnedProviderBin doesn't report exactly that version.
 */
export const PROVIDER_CLI_PINS: Readonly<Partial<Record<"vercel" | "netlify", { version: string }>>> = {};
export function pinnedProviderBin(provider: "vercel" | "netlify", home: string = homedir()): string {
  return join(home, ".npm-global", "bin", provider);
}

/** Reviewed offline scanner policy; database downloads happen explicitly outside the gate. */
export function pinnedSecurityScanners(osvDatabaseDir?: string): ScannerPins {
  return {
    gitleaks: {
      bin: "/opt/homebrew/bin/gitleaks", version: "8.28.0",
      args: ["dir", "--ignore-gitleaks-allow", "--gitleaks-ignore-path=/dev/null", "--redact=100", "--report-format=json", "--report-path=@report", "--no-banner", "--no-color", "--log-level=fatal", "."],
    },
    semgrep: {
      bin: "/opt/homebrew/bin/semgrep", version: "1.182.0",
      rulesFile: fileURLToPath(new URL("../security/rules/", import.meta.url)),
      args: ["scan", "--config", "@rules", "--metrics=off", "--disable-version-check", "--disable-nosem", "--json", "--oss-only", "--no-secrets-validation", "--no-git-ignore", "--x-ignore-semgrepignore-files", "--jobs=1", "--max-target-bytes=0", "."],
      env: { SSL_CERT_FILE: "/etc/ssl/cert.pem" },
    },
    "osv-scanner": {
      bin: "/opt/homebrew/bin/osv-scanner", version: "2.7.0",
      args: ["scan", "source", "--offline", "--offline-vulnerabilities", "--x-plugins=vulnmatch/osvlocal", "--config=/dev/null", "--format=json", "--recursive", "--no-ignore", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust", "."],
      env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: "$JARVIS_FIXTURES/security/osv-db" },
      ...(osvDatabaseDir ? { databaseDir: osvDatabaseDir } : {}),
    },
  };
}

/**
 * The interpreter the npm provider CLIs (PROVIDER_CLI_PINS) start under (decision 161): the runner's own Node, by
 * absolute path, never `node` through PATH. The adapters run every provider process with `PATH=/usr/bin:/bin`, where
 * npm's `#!/usr/bin/env node` launcher finds no node, so they start `<this> <pinned bin> <args>` instead.
 * Recommended pins once one is installed: Vercel CLI 48.0.0, Netlify CLI 23.0.0 (chosen offline by the s5-adapters
 * lane; neither installed nor checked against a real account yet, backlog 195). SHA-256 source, when recorded: the exact
 * npm tarball (https://registry.npmjs.org/vercel/-/vercel-48.0.0.tgz, .../netlify-cli/-/netlify-cli-23.0.0.tgz), its
 * bytes checked against the registry's `dist.integrity` (backlog 196). None is recorded here yet, and none is invented.
 */
export function pinnedProviderNode(): string {
  return process.execPath;
}

/**
 * The release build's dependency step (decision 173): the Node that starts the package manager, and npm or pnpm as
 * a script file that Node runs, all by absolute path, never `npm`, `pnpm`, `npx` or Corepack's launcher through PATH
 * (Corepack downloads whatever a package.json declares). `version` is what `<node> <bin> --version` prints; the step
 * refuses a project whose `packageManager` declares any other version, and the worker inside the sandbox checks the
 * printed version again before installing. Read on Fabricio's Mac on Nov 1, 2026: Homebrew's node@24 keg and its
 * bundled npm, and the pnpm Corepack had already cached for this repo's own `packageManager`. The pnpm copy lives in
 * a cache Corepack may clear (backlog 238 moves it under the runner's own cache with a hash).
 */
export const DEPENDENCY_NODE_VERSION = "24.21.0";
export const DEPENDENCY_NPM_VERSION = "11.19.0";
export const DEPENDENCY_PNPM_VERSION = "11.7.0";
export function pinnedDependencyTools(home: string = homedir()): DependencyPins {
  const nodeRoot = `/opt/homebrew/Cellar/node@24/${DEPENDENCY_NODE_VERSION}`;
  const npmRoot = join(nodeRoot, "lib", "node_modules", "npm");
  const pnpmRoot = join(home, ".cache", "node", "corepack", "v1", "pnpm", DEPENDENCY_PNPM_VERSION);
  return {
    node: join(nodeRoot, "bin", "node"),
    nodeVersion: DEPENDENCY_NODE_VERSION,
    npm: { bin: join(npmRoot, "bin", "npm-cli.js"), root: npmRoot, version: DEPENDENCY_NPM_VERSION },
    pnpm: { bin: join(pnpmRoot, "bin", "pnpm.mjs"), root: pnpmRoot, version: DEPENDENCY_PNPM_VERSION },
  };
}

/**
 * Render's deploy tools (decision 163): Render has no provider CLI, so the broker pushes with this Git and this SSH, by
 * absolute path, never through PATH (and never `/usr/bin/git`, the xcrun shim that picks whichever developer folder is
 * selected). `version` is the exact line `git --version` and `ssh -V` print, read on Fabricio's Mac on Oct 31, 2026
 * (Xcode's Git, macOS's OpenSSH). An Xcode or macOS update that changes either fails closed: the adapter refuses before
 * reading a deploy key, and doctor's `deploy.render` says which differs; update the line here after checking it.
 */
export const RENDER_TOOL_PINS: { readonly git: { bin: string; version: string }; readonly ssh: { bin: string; version: string } } = {
  git: { bin: "/Applications/Xcode.app/Contents/Developer/usr/bin/git", version: "git version 2.50.1 (Apple Git-155)" },
  ssh: { bin: "/usr/bin/ssh", version: "OpenSSH_10.2p1, LibreSSL 3.3.6" },
};
