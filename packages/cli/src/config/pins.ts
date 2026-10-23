import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Exact versions Jarvis is tested with (decisions 57, 66). Never "or newer".
 * Binaries are always called by absolute path, never through PATH (decision 58).
 */
export const CLAUDE_CODE_VERSION = "2.1.309";
export const CODEX_VERSION = "0.163.0";

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
