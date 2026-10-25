import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { runSession, type SessionOutcome } from "../proc/session.ts";

/**
 * Anthropic's sandbox runtime (the sandbox Claude Code uses), pinned in package.json, used as a library.
 * The runner spawns the wrapped command itself, so the exit code and any terminating signal come from
 * its own child, never from the srt CLI, whose interrupt handling turns a payload SIGTERM into exit 0
 * (Codex stage 0 review 5). Invalid configs are refused by the library's own schema.
 *
 * The wrapper is built in a child process that sees none of the runner's environment (see wrap.ts), and
 * the library's shared temp folder (/tmp/claude) is write-denied: every run gets its own TMPDIR, so
 * a daemon that outlives one sandbox can't reach another's scratch files (Codex stage 0 review 16).
 */
export interface SrtPolicy {
  /** Readable despite denyRead (the checkout, the check scripts, the toolchain cache). */
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  allowedDomains?: string[];
  /** Lets tests bind and reach local ports (all of them: loopback is all-or-nothing). Off by default. */
  allowLocalBinding?: boolean;
  /** Unix sockets the sandbox may connect to, by real path. None by default. */
  allowUnixSockets?: string[];
}

export function srtConfig(p: SrtPolicy) {
  return SandboxRuntimeConfigSchema.parse({
    network: { allowedDomains: p.allowedDomains ?? [], deniedDomains: [], allowUnixSockets: p.allowUnixSockets ?? [], allowLocalBinding: p.allowLocalBinding === true },
    filesystem: { denyRead: p.denyRead, allowRead: p.allowRead, allowWrite: p.allowWrite, denyWrite: SHARED_TMP },
  });
}

/** The library's default shared temp folder, writable by every sandbox unless denied. */
const SHARED_TMP = ["/tmp/claude", "/private/tmp/claude"];
const WRAP = fileURLToPath(new URL("./wrap.ts", import.meta.url));

/** The wrapped command, built where the library sees only PATH, HOME and this run's TMPDIR. */
function wrap(r: SandboxedRun): Promise<string> {
  const env = { PATH: r.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), ...(r.env.TMPDIR ? { CLAUDE_CODE_TMPDIR: r.env.TMPDIR } : {}) };
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [WRAP], { env, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`sandbox wrapper failed: ${stderr || err.message}`)) : resolve(stdout),
    );
    child.stdin?.end(JSON.stringify({ config: srtConfig(r.policy), command: r.command }));
  });
}

export interface SandboxedRun {
  policy: SrtPolicy;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  killGraceMs?: number;
  maxOutputBytes?: number;
}

/** Runs a shell command inside the sandbox. `code` is 0 only if the sandboxed command itself exited 0. */
export async function runSandboxed(r: SandboxedRun): Promise<SessionOutcome> {
  const wrapped = await wrap(r);
  return runSession({
    bin: "/bin/sh",
    args: ["-c", wrapped],
    cwd: r.cwd,
    env: r.env,
    timeoutMs: r.timeoutMs,
    ...(r.stdoutPath ? { stdoutPath: r.stdoutPath } : {}),
    ...(r.stderrPath ? { stderrPath: r.stderrPath } : {}),
    ...(r.killGraceMs !== undefined ? { killGraceMs: r.killGraceMs } : {}),
    ...(r.maxOutputBytes !== undefined ? { maxOutputBytes: r.maxOutputBytes } : {}),
  });
}
