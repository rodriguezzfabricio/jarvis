import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Anthropic's sandbox runtime (`srt`, the sandbox Claude Code uses), pinned in package.json.
 * The runner uses it for anything it executes from a task's code (checks), so agent-written tests
 * never run with the runner's own access. Unlike Claude Code, srt refuses an invalid config loudly.
 */
export interface SrtPolicy {
  /** Readable despite denyRead (the checkout, the check scripts, the toolchain cache). */
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  allowedDomains?: string[];
  /** Lets tests bind and reach local ports (all of them: loopback is all-or-nothing). Off by default. */
  allowLocalBinding?: boolean;
}

export function srtSettings(p: SrtPolicy): object {
  return {
    network: { allowedDomains: p.allowedDomains ?? [], deniedDomains: [], allowUnixSockets: [], allowLocalBinding: p.allowLocalBinding === true },
    filesystem: { denyRead: p.denyRead, allowRead: p.allowRead, allowWrite: p.allowWrite, denyWrite: [] },
  };
}

export function writeSrtSettings(path: string, p: SrtPolicy): void {
  writeFileSync(path, `${JSON.stringify(srtSettings(p), null, 2)}\n`, { mode: 0o600 });
}

/** [executable, ...args] that run `command` (a shell string) inside the sandbox. */
export function srtCommand(settingsPath: string, command: string): [string, ...string[]] {
  const req = createRequire(import.meta.url);
  const pkg = req.resolve("@anthropic-ai/sandbox-runtime/package.json");
  const bin = (req(pkg) as { bin: Record<string, string> }).bin.srt as string;
  return [process.execPath, join(dirname(pkg), bin), "--settings", settingsPath, "-c", command];
}
