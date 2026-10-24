import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream } from "node:fs";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

/** Starts one `claude -p` session and captures its raw output. Resolves only after output files are flushed. */
export interface SessionSpec {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** When set, stdout/stderr are streamed to these files instead of kept in memory. */
  stdoutPath?: string;
  stderrPath?: string;
  /** Test seam: how an output file is opened. */
  openSink?: (path: string) => Writable;
  /** How long a child gets after SIGTERM before SIGKILL (default 10 s). */
  killGraceMs?: number;
}

export interface SessionOutcome {
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** Output could not be captured; the session was stopped. */
export class EvidenceCaptureError extends Error {}
/** The session process could not be started at all (missing binary, EAGAIN, permissions). */
export class SessionStartError extends Error {}

export async function runSession(spec: SessionSpec): Promise<SessionOutcome> {
  const started = Date.now();
  const grace = spec.killGraceMs ?? 10_000;
  const open = spec.openSink ?? ((p: string) => createWriteStream(p, { mode: 0o600 }));
  // Its own process group, so shutdown reaches everything the session started (Bash children too).
  const child = spawn(spec.bin, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // the group is already gone
    }
  };
  let stdout = "";
  let stderr = "";
  let sinkError: Error | undefined;
  let spawnError: Error | undefined;
  let timedOut = false;
  const sinks: Promise<void>[] = [];
  const sinkStreams: NodeJS.WritableStream[] = [];
  const timers: NodeJS.Timeout[] = [];

  const groupAlive = () => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const cleanupGroup = async () => {
    if (!groupAlive()) return;
    killGroup("SIGTERM");
    const killAt = Date.now() + grace;
    while (groupAlive() && Date.now() < killAt) await new Promise((res) => setTimeout(res, 50));
    if (groupAlive()) killGroup("SIGKILL");
    const giveUp = Date.now() + 5_000;
    while (groupAlive() && Date.now() < giveUp) await new Promise((res) => setTimeout(res, 50));
  };

  // One idempotent shutdown path: SIGTERM now, SIGKILL after a bounded grace period.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    killGroup("SIGTERM");
    timers.push(setTimeout(() => killGroup("SIGKILL"), grace));
  };

  const attach = (source: NodeJS.ReadableStream, path: string | undefined, keep: (s: string) => void) => {
    if (!path) {
      source.on("data", (d: Buffer) => keep(d.toString()));
      return;
    }
    const sink = open(path);
    // Errors are handled from the moment the file is opened: stop the session, fail explicitly.
    sink.on("error", (e: Error) => {
      sinkError ??= e;
      shutdown();
    });
    source.pipe(sink);
    sinkStreams.push(sink);
    sinks.push(finished(sink).catch((e: Error) => void (sinkError ??= e)));
  };
  attach(child.stdout, spec.stdoutPath, (s) => (stdout += s));
  attach(child.stderr, spec.stderrPath, (s) => (stderr += s));

  timers.push(
    setTimeout(() => {
      timedOut = true;
      shutdown();
    }, spec.timeoutMs),
  );

  // React to the leader's *exit*, not to its pipes closing: a background descendant can hold the
  // inherited stdout/stderr open indefinitely (backlog #10, Codex stage 0 review 5).
  // Registered at spawn, so a close that happens before we look is never missed.
  const closed = new Promise<void>((res) => child.once("close", () => res()));
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(null);
    });
    child.on("exit", (c) => resolve(c));
  });
  for (const t of timers) clearTimeout(t);
  // The leader is gone; anything else in its group (background servers, watchers, a descendant that
  // ignores SIGTERM) gets the same bounded TERM -> KILL, and we wait until the group is empty
  // before returning, so nothing outlives the session (Codex review 4).
  await cleanupGroup();
  // The group is gone, so the pipes close; wait briefly for the last bytes, then stop waiting.
  if (!spawnError) {
    await Promise.race([closed, new Promise<void>((res) => setTimeout(res, 5_000).unref())]);
    child.stdout.destroy();
    child.stderr.destroy();
    // A destroyed source never ends its pipe, so end the files ourselves: a process outside the group
    // (a setsid daemon) that still holds the pipes must not keep the session waiting forever.
    for (const sink of sinkStreams) sink.end();
  }
  // Evidence is parsed from these files, so wait until every byte is on disk.
  await Promise.all(sinks);
  if (spawnError) {
    const msg = `could not start ${spec.bin}: ${spawnError.message}`;
    if (spec.stderrPath) {
      try {
        appendFileSync(spec.stderrPath, `\n[runner] ${msg}\n`);
      } catch {
        // the diagnostic is still in the error
      }
    }
    throw new SessionStartError(msg);
  }
  if (sinkError) throw new EvidenceCaptureError(`could not capture session output: ${sinkError.message}`);
  return { code, timedOut, durationMs: Date.now() - started, stdout, stderr };
}
