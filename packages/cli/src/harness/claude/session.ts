import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
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
}

export interface SessionOutcome {
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export class EvidenceCaptureError extends Error {}

export async function runSession(spec: SessionSpec): Promise<SessionOutcome> {
  const started = Date.now();
  const open = spec.openSink ?? ((p: string) => createWriteStream(p, { mode: 0o600 }));
  const child = spawn(spec.bin, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let sinkError: Error | undefined;
  const sinks: Promise<void>[] = [];
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
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
      stop();
    });
    source.pipe(sink);
    sinks.push(finished(sink).catch((e: Error) => void (sinkError ??= e)));
  };
  attach(child.stdout, spec.stdoutPath, (s) => (stdout += s));
  attach(child.stderr, spec.stderrPath, (s) => (stderr += s));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, spec.timeoutMs);

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      stderr += `\n${String(err)}`;
      resolve(null);
    });
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timer);
  // Evidence is parsed from these files, so wait until every byte is on disk.
  await Promise.all(sinks);
  if (sinkError) throw new EvidenceCaptureError(`could not capture session output: ${sinkError.message}`);
  return { code, timedOut, durationMs: Date.now() - started, stdout, stderr };
}
