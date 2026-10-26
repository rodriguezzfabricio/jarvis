import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { register, type PreparedRun, type RunCommandOptions } from "../../packages/cli/src/commands/run.ts";
import type { RunLoopOptions, RunLoopResult } from "../../packages/cli/src/runner/loop.ts";

// The run's lifetime bounds what it hosts: the broker comes down when the loop returns or throws, and the
// finished notification follows (architecture §3.4: "send notifications …; stop the broker; exit").
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

function setup(loop: (o: RunLoopOptions) => Promise<RunLoopResult>, extra: Partial<PreparedRun> = {}, seams: RunCommandOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cmd-run-host-"))); roots.push(root);
  mkdirSync(join(root, ".git"));
  const order: string[] = [];
  const options = { marker: "loop options" } as unknown as RunLoopOptions;
  const close = vi.fn(async () => { order.push("close"); });
  const finished = vi.fn(async (result: RunLoopResult | undefined) => { order.push(`finished:${result?.status ?? "error"}`); });
  const prepareRun = vi.fn(async () => { order.push("prepare"); return { loop: options, close, finished, ...extra }; });
  const runLoop = vi.fn(async (o: RunLoopOptions) => { order.push("loop"); return loop(o); });
  const output = vi.fn();
  const program = new Command().exitOverride();
  register(program, { jarvisHome: root, cwd: root, env: { JARVIS_PROJECT: "p" }, probe: async () => ({ ok: true }), prepareRun, runLoop, output, keepAwake: () => {}, ...seams });
  return { program, order, options, close, finished, prepareRun, runLoop, output };
}
const complete: RunLoopResult = { status: "complete", done: ["T1"], blocked: [] };

it("runs the prepared loop, then stops what the run hosts, then sends the finished notice", async () => {
  const f = setup(async () => complete);
  await f.program.parseAsync(["run"], { from: "user" });
  expect(f.runLoop).toHaveBeenCalledWith(f.options);
  expect(f.order).toEqual(["prepare", "loop", "close", "finished:complete"]);
  expect(f.finished).toHaveBeenCalledWith(complete);
  expect(f.output).toHaveBeenCalledWith(expect.stringContaining("complete"));
});

it("stops what the run hosts when the loop throws, says the run stopped, and keeps the error", async () => {
  const f = setup(async () => { throw new Error("ledger failed verification"); });
  await expect(f.program.parseAsync(["run"], { from: "user" })).rejects.toThrow("ledger failed verification");
  expect(f.order).toEqual(["prepare", "loop", "close", "finished:error"]);
  expect(f.finished).toHaveBeenCalledWith(undefined);
});

it("still sends the finished notice when closing fails, and reports the close error", async () => {
  const f = setup(async () => complete, { close: async () => { throw new Error("socket removal failed"); } });
  await expect(f.program.parseAsync(["run"], { from: "user" })).rejects.toThrow("socket removal failed");
  expect(f.order).toEqual(["prepare", "loop", "finished:complete"]);
});

it("hosts nothing in the parent of a detached run: only the detached runner prepares", async () => {
  const spawn = vi.fn(() => ({ pid: 1, unref: vi.fn(), once: (event: string, cb: () => void) => { if (event === "spawn") queueMicrotask(cb); } }));
  const f = setup(async () => complete, {}, { spawn, entrypoint: "/runner/cli.ts" });
  await f.program.parseAsync(["run", "--detach"], { from: "user" });
  expect(spawn).toHaveBeenCalled();
  expect(f.prepareRun).not.toHaveBeenCalled();
  expect(f.order).toEqual([]);
});

it("prepares nothing when the live canary fails", async () => {
  const f = setup(async () => complete, {}, { probe: async () => ({ ok: false }) });
  await expect(f.program.parseAsync(["run"], { from: "user" })).rejects.toThrow(/canary/);
  expect(f.prepareRun).not.toHaveBeenCalled();
});
