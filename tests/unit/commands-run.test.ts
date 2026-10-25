import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { caffeinate, register, type RunCommandOptions } from "../../packages/cli/src/commands/run.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup(extra: RunCommandOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cmd-run-"))); roots.push(root);
  mkdirSync(join(root, ".git")); // a checkout marker: the project root (decision 90)
  const probe = vi.fn(async () => ({ ok: true })), run = vi.fn(async () => ({ status: "complete" as const, done: ["T1"], blocked: [] })), output = vi.fn();
  const keepAwake = vi.fn();
  const program = new Command().exitOverride();
  register(program, { jarvisHome: root, cwd: root, env: { JARVIS_PROJECT: "env-project" }, probe, run, output, keepAwake, ...extra });
  return { root, program, probe, run, output, keepAwake };
}
const fakeSpawn = () => vi.fn(() => ({ pid: 12345, unref: vi.fn(), once: (event: string, cb: () => void) => { if (event === "spawn") queueMicrotask(cb); } }));

it("derives the project id from the checkout without --project or JARVIS_PROJECT (decision 90)", async () => {
  const f = setup({ env: {} }); await f.program.parseAsync(["run"], { from: "user" });
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ projectId: projectId(f.root), repoPath: f.root }));
});
it("probes before running and gives --project precedence", async () => {
  const f = setup(); await f.program.parseAsync(["run", "--project", "chosen"], { from: "user" });
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ projectId: "chosen", projectDir: join(f.root, "projects/chosen"), repoPath: f.root }));
  expect(f.probe.mock.invocationCallOrder[0]).toBeLessThan(f.run.mock.invocationCallOrder[0]!); expect(f.output).toHaveBeenCalledWith(expect.stringContaining("complete"));
});
it("keeps the Mac awake for this runner's pid, before the loop starts", async () => {
  const f = setup(); await f.program.parseAsync(["run"], { from: "user" });
  expect(f.keepAwake).toHaveBeenCalledWith(process.pid);
  expect(f.keepAwake.mock.invocationCallOrder[0]).toBeLessThan(f.run.mock.invocationCallOrder[0]!);
});
it("refuses an unattended run when the live canary fails", async () => {
  const run = vi.fn(); const f = setup({ probe: async () => ({ ok: false }), run }); await expect(f.program.parseAsync(["run"], { from: "user" })).rejects.toThrow(/canary/); expect(run).not.toHaveBeenCalled();
});
it("does not spawn a detached runner when its canary fails", async () => {
  const spawn = vi.fn(); const f = setup({ probe: async () => ({ ok: false }), spawn }); await expect(f.program.parseAsync(["run", "--detach"], { from: "user" })).rejects.toThrow(/canary/); expect(spawn).not.toHaveBeenCalled();
});
it("does not spawn a detached runner without a production composition, and doesn't probe", async () => {
  const spawn = vi.fn(); const probe = vi.fn(async () => ({ ok: true }));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cmd-run-"))); roots.push(root); mkdirSync(join(root, ".git"));
  const program = new Command().exitOverride();
  register(program, { jarvisHome: root, cwd: root, env: { JARVIS_PROJECT: "p" }, probe, spawn, output: vi.fn() });
  await expect(program.parseAsync(["run", "--detach"], { from: "user" })).rejects.toThrow(/composition/);
  expect(spawn).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
});
it("detaches the same entry point with a private project log and prints pid and path", async () => {
  const spawn = fakeSpawn();
  const f = setup({ spawn, entrypoint: "/runner/cli.ts" }); await f.program.parseAsync(["run", "--detach"], { from: "user" });
  const [bin, args, options] = spawn.mock.calls[0]! as unknown as [string, string[], { detached: boolean; stdio: unknown[] }];
  expect(bin).toBe(process.execPath); expect(args).toEqual(["/runner/cli.ts", "run", "--project", "env-project"]); expect(options.detached).toBe(true); expect(options.stdio[0]).toBe("ignore");
  expect(f.run).not.toHaveBeenCalled(); expect(f.keepAwake).not.toHaveBeenCalled(); expect(f.output).toHaveBeenCalledWith(expect.stringMatching(/12345.*runner-.*\.log/));
});
it("passes an explicit session plan to the run and to a detached runner", async () => {
  const f = setup(); await f.program.parseAsync(["run", "--plan", "onboard"], { from: "user" });
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ planKind: "onboard" }));
  const spawn = fakeSpawn();
  const g = setup({ spawn, entrypoint: "/runner/cli.ts" }); await g.program.parseAsync(["run", "--detach", "--plan", "sweep"], { from: "user" });
  expect((spawn.mock.calls[0]! as unknown as [string, string[]])[1]).toEqual(["/runner/cli.ts", "run", "--project", "env-project", "--plan", "sweep"]);
});
it("reads no plan by default and refuses an unknown plan kind before the probe", async () => {
  const f = setup(); await f.program.parseAsync(["run"], { from: "user" });
  expect((f.run.mock.calls[0] as unknown[])[0]).not.toHaveProperty("planKind");
  const g = setup(); await expect(g.program.parseAsync(["run", "--plan", "../x"], { from: "user" })).rejects.toThrow(/--plan/); expect(g.probe).not.toHaveBeenCalled();
});
it("reports detached spawn errors instead of a false success", async () => {
  const f = setup({ spawn: () => ({ pid: undefined, unref: () => {}, once: (event: string, cb: (error?: Error) => void) => { if (event === "error") queueMicrotask(() => cb(new Error("spawn refused"))); } }) });
  await expect(f.program.parseAsync(["run", "--detach"], { from: "user" })).rejects.toThrow("spawn refused"); expect(f.output).not.toHaveBeenCalled();
});
it("rejects traversal project ids before the probe", async () => {
  const f = setup(); await expect(f.program.parseAsync(["run", "--project", "../escape"], { from: "user" })).rejects.toThrow(/project id/i); expect(f.probe).not.toHaveBeenCalled();
});
it("caffeinate runs the absolute pin with -i -w <pid> on macOS only", () => {
  const spawn = vi.fn(() => ({ pid: 1, unref: vi.fn(), once: vi.fn() }));
  caffeinate(4242, "darwin", spawn);
  expect(spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-w", "4242"], expect.objectContaining({ detached: true, stdio: "ignore" }));
  spawn.mockClear(); caffeinate(4242, "linux", spawn); expect(spawn).not.toHaveBeenCalled();
});
