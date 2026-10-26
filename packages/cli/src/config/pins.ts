import type { ScannerPins } from "../security/scanners.ts";
import type { ImpeccablePin } from "../lanes/impeccable.ts";
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
  return join(home, ".local", "share", "claude", "versions", CLAUDE_CODE_VERSION);
}

export function pinnedCodexBin(home: string = homedir()): string {
  return join(home, ".npm-global", "bin", "codex");
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
