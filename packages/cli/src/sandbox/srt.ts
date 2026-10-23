import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { runSession, type SessionOutcome } from "../proc/session.ts";

/**
 * Anthropic's sandbox runtime (the sandbox Claude Code uses), pinned in package.json, used as a library.
 * The runner spawns the wrapped command itself, so the exit code and any terminating signal come from
 * its own child, never from the srt CLI, whose interrupt handling turns a payload SIGTERM into exit 0
 * (Codex stage 0 review 5). Invalid configs are refused by the library's own schema.
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

export function srtConfig(p: SrtPolicy) {
  return SandboxRuntimeConfigSchema.parse({
    network: { allowedDomains: p.allowedDomains ?? [], deniedDomains: [], allowUnixSockets: [], allowLocalBinding: p.allowLocalBinding === true },
    filesystem: { denyRead: p.denyRead, allowRead: p.allowRead, allowWrite: p.allowWrite, denyWrite: [] },
  });
}

// The library keeps one global sandbox; run one sandboxed command at a time.
let queue: Promise<unknown> = Promise.resolve();

export interface SandboxedRun {
  policy: SrtPolicy;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  killGraceMs?: number;
}

/** Runs a shell command inside the sandbox. `code` is 0 only if the sandboxed command itself exited 0. */
export function runSandboxed(r: SandboxedRun): Promise<SessionOutcome> {
  const job = queue.then(async () => {
    await SandboxManager.initialize(srtConfig(r.policy));
    try {
      const wrapped = await SandboxManager.wrapWithSandbox(r.command);
      return await runSession({
        bin: "/bin/sh",
        args: ["-c", wrapped],
        cwd: r.cwd,
        env: r.env,
        timeoutMs: r.timeoutMs,
        ...(r.stdoutPath ? { stdoutPath: r.stdoutPath } : {}),
        ...(r.stderrPath ? { stderrPath: r.stderrPath } : {}),
        ...(r.killGraceMs !== undefined ? { killGraceMs: r.killGraceMs } : {}),
      });
    } finally {
      await SandboxManager.reset();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
