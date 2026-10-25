import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, appendFileSync, createWriteStream } from "node:fs";
import { isAbsolute } from "node:path";
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
  /** Combined stdout and stderr bytes captured before the session is stopped (Codex stage 0 review 16). */
  maxOutputBytes?: number;
  /**
   * Called synchronously at spawn with the session's process group ID, before the payload exists: the
   * group's leader is a hold (HOLD_SHELL) that execs `bin` only after this returns true. False or a
   * throw closes the hold's pipe and kills the group, so the payload never runs; a throw is rethrown
   * once the group is gone. The runner records the group's identity here.
   */
  onSpawn?: (groupId: number) => boolean;
  /** Called once, and only once every process in the group is gone; never while any of it is alive. */
  onGroupExit?: (groupId: number) => void;
}

export interface SessionOutcome {
  code: number | null;
  timedOut: boolean;
  /** Output passed `maxOutputBytes`: capture stopped there and the session was stopped. */
  overflowed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** Output could not be captured; the session was stopped. */
export class EvidenceCaptureError extends Error {}
/** The session process could not be started at all (missing binary, EAGAIN, permissions). */
export class SessionStartError extends Error {}

/** The hold, by absolute path, with no environment of its own beyond the session's (Codex review 19). */
export const HOLD_SHELL = "/bin/sh";
const HOLD_ENV = "/usr/bin/env";
/** Variables the shell adds for the programs it starts; removed unless the session set them itself. */
const SHELL_ADDED = ["PWD", "SHLVL", "OLDPWD", "_"] as const;

/**
 * Blocks on fd 3 until the parent writes a line, then execs `bin` with its argv unchanged (same PID, so
 * the group's identity holds). EOF (the parent closed or died) exits 125 without running anything.
 */
function holdArgs(spec: SessionSpec): string[] {
  if (!isAbsolute(spec.bin) || spec.bin.includes("=")) throw new SessionStartError(`a held session needs an absolute binary path without '=': ${spec.bin}`);
  try { accessSync(spec.bin, constants.X_OK); } catch (e) { throw new SessionStartError(`could not start ${spec.bin}: ${(e as Error).message}`); }
  const unset = SHELL_ADDED.filter((name) => !Object.hasOwn(spec.env, name)).flatMap((name) => ["-u", name]).join(" ");
  return ["-c", `read _ <&3 || exit 125; exec 3<&-; exec ${HOLD_ENV} ${unset} "$@"`, "jarvis-hold", spec.bin, ...spec.args];
}

export async function runSession(spec: SessionSpec): Promise<SessionOutcome> {
  const started = Date.now();
  const grace = spec.killGraceMs ?? 10_000;
  const open = spec.openSink ?? ((p: string) => createWriteStream(p, { mode: 0o600 }));
  // Its own process group, so shutdown reaches everything the session started (Bash children too).
  // With onSpawn, the payload is exec'd by a hold only after onSpawn approves it (never before).
  const hold = spec.onSpawn ? holdArgs(spec) : undefined;
  const child = (hold
    ? spawn(HOLD_SHELL, hold, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe", "pipe"], detached: true })
    : spawn(spec.bin, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true })) as unknown as ChildProcessWithoutNullStreams;
  const release = (child.stdio as unknown[])[3] as Writable | undefined;
  release?.on("error", () => { /* the hold is gone; the exit handler reports it */ });
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
  let overflowed = false;
  let captured = 0;
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
    // Counted as it arrives: past the cap, stop capturing and stop the session, rather than store
    // whatever a case prints before its timeout.
    if (spec.maxOutputBytes !== undefined)
      source.on("data", (d: Buffer) => {
        captured += d.length;
        if (captured > spec.maxOutputBytes! && !overflowed) {
          overflowed = true;
          for (const s of [child.stdout, child.stderr]) s.unpipe();
          shutdown(); // the files are ended with the session, as usual
        }
      });
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

  let observerError: unknown;
  if (spec.onSpawn && child.pid !== undefined) {
    let accepted = false;
    try {
      accepted = spec.onSpawn(child.pid) === true;
    } catch (e) {
      observerError = e;
    }
    // A refused group never ran its payload: close the hold (it exits on EOF) and kill the group.
    if (!accepted) {
      shuttingDown = true;
      release?.destroy();
      killGroup("SIGKILL");
    } else release?.end("\n");
  }

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
  // Only an empty group counts as exited; one still alive past cleanup stays recoverable by the runner.
  if (child.pid !== undefined && spec.onGroupExit && !groupAlive()) {
    try {
      spec.onGroupExit(child.pid);
    } catch (e) {
      observerError ??= e; // reported after the output files are complete
    }
  }
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
  if (observerError !== undefined) throw observerError;
  if (sinkError) throw new EvidenceCaptureError(`could not capture session output: ${sinkError.message}`);
  return { code, timedOut, overflowed, durationMs: Date.now() - started, stdout, stderr };
}
