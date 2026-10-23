import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
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
}

export interface SessionOutcome {
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export async function runSession(spec: SessionSpec): Promise<SessionOutcome> {
  const started = Date.now();
  const child = spawn(spec.bin, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const sinks: WriteStream[] = [];
  if (spec.stdoutPath) {
    const s = createWriteStream(spec.stdoutPath, { mode: 0o600 });
    child.stdout.pipe(s);
    sinks.push(s);
  } else child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  if (spec.stderrPath) {
    const s = createWriteStream(spec.stderrPath, { mode: 0o600 });
    child.stderr.pipe(s);
    sinks.push(s);
  } else child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
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
  await Promise.all(sinks.map((s) => finished(s)));
  return { code, timedOut, durationMs: Date.now() - started, stdout, stderr };
}
