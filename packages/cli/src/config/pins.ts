import type { ScannerPins } from "../security/scanners.ts";
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
      args: ["scan", "--config", "@rules", "--metrics=off", "--disable-version-check", "--disable-nosem", "--json", "--oss-only", "--no-secrets-validation", "--no-git-ignore", "--x-ignore-semgrepignore-files", "--jobs=1", "."],
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
