import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * System temp folders (decision 95): other processes' scratch files live there, including other
 * Claude Code sessions' and credentials tools leave behind, and a sandbox allows reads outside its
 * denied regions. Every sandbox that runs agent or candidate code denies them: task sessions
 * (harness/claude/settings.ts) and the protected gate (checks/gate.ts). Both spellings, because
 * macOS's /tmp and /var are symlinks into /private.
 */
export const SYSTEM_TEMP_ROOTS = ["/private/tmp", "/tmp", "/private/var/folders", "/var/folders", "/private/var/tmp", "/var/tmp"] as const;

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** The real path of this process's own temp folder ($TMPDIR), if it exists. */
export function defaultHostTmpDir(): string | undefined {
  const t = tmpdir();
  return existsSync(t) ? realpathSync(t) : undefined;
}

/** The temp roots a sandbox may not read: the system ones plus the runner's $TMPDIR when it lies elsewhere. */
export function tempRoots(hostTmpDir: string | undefined = defaultHostTmpDir()): string[] {
  const roots: string[] = [...SYSTEM_TEMP_ROOTS];
  if (hostTmpDir !== undefined && !roots.some((r) => under(hostTmpDir, r))) roots.push(hostTmpDir);
  return roots;
}
