import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { register, type RunCommandOptions } from "../../packages/cli/src/commands/run.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup(extra: RunCommandOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "cmd-run-")); roots.push(root);
  const probe = vi.fn(async () => ({ ok: true })), run = vi.fn(async () => ({ status: "complete" as const, done: ["T1"], blocked: [] })), output = vi.fn();
  const program = new Command().exitOverride();
  register(program, { jarvisHome: root, cwd: root, env: { JARVIS_PROJECT: "env-project" }, probe, run, output, ...extra });
  return { root, program, probe, run, output };
}
it("requires the same explicit project or environment selection as steer", async () => {
  const f = setup({ env: {} }); await expect(f.program.parseAsync(["run"], { from: "user" })).rejects.toThrow(/project/); expect(f.probe).not.toHaveBeenCalled();
});
it("probes before running and gives --project precedence", async () => {
  const f = setup(); await f.program.parseAsync(["run", "--project", "chosen"], { from: "user" });
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ projectId: "chosen", projectDir: join(f.root, "projects/chosen"), repoPath: f.root }));
  expect(f.probe.mock.invocationCallOrder[0]).toBeLessThan(f.run.mock.invocationCallOrder[0]!); expect(f.output).toHaveBeenCalledWith(expect.stringContaining("complete"));
});
it("refuses an unattended run when the live canary fails", async () => {
  const run = vi.fn(); const f = setup({ probe: async () => ({ ok: false }), run }); await expect(f.program.parseAsync(["run"], { from: "user" })).rejects.toThrow(/canary/); expect(run).not.toHaveBeenCalled();
});
it("does not spawn a detached runner when its canary fails", async () => {
  const spawn = vi.fn(); const f = setup({ probe: async () => ({ ok: false }), spawn }); await expect(f.program.parseAsync(["run", "--detach"], { from: "user" })).rejects.toThrow(/canary/); expect(spawn).not.toHaveBeenCalled();
});
it("detaches the same entry point with a private project log and prints pid and path", async () => {
  const spawn = vi.fn(() => ({ pid: 12345, unref: vi.fn(), once: (event: string, cb: () => void) => { if (event === "spawn") queueMicrotask(cb); } }));
  const f = setup({ spawn, entrypoint: "/runner/cli.ts" }); await f.program.parseAsync(["run", "--detach"], { from: "user" });
  const [bin, args, options] = spawn.mock.calls[0]! as unknown as [string, string[], { detached: boolean; stdio: unknown[] }];
  expect(bin).toBe(process.execPath); expect(args).toEqual(["/runner/cli.ts", "run", "--project", "env-project"]); expect(options.detached).toBe(true); expect(options.stdio[0]).toBe("ignore");
  expect(f.run).not.toHaveBeenCalled(); expect(f.output).toHaveBeenCalledWith(expect.stringMatching(/12345.*runner-.*\.log/));
});
it("reports detached spawn errors instead of a false success", async () => {
  const f = setup({ spawn: () => ({ pid: undefined, unref: () => {}, once: (event: string, cb: (error?: Error) => void) => { if (event === "error") queueMicrotask(() => cb(new Error("spawn refused"))); } }) });
  await expect(f.program.parseAsync(["run", "--detach"], { from: "user" })).rejects.toThrow("spawn refused"); expect(f.output).not.toHaveBeenCalled();
});
it("rejects traversal project ids before the probe", async () => {
  const f = setup(); await expect(f.program.parseAsync(["run", "--project", "../escape"], { from: "user" })).rejects.toThrow(/project id/); expect(f.probe).not.toHaveBeenCalled();
});
