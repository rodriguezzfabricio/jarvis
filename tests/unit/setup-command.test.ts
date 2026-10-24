import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import type { SecretsWriter } from "../../packages/cli/src/broker/secrets.ts";
import { register } from "../../packages/cli/src/setup/command.ts";
import { InterruptedError, type Tty } from "../../packages/cli/src/setup/tty.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cli(lines: string[], hidden: string[], withTty = true, existingHome?: string) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "jarvis-setup-cli-")); if (!existingHome) dirs.push(home);
  const out: string[] = []; const codes: number[] = []; const closed = vi.fn();
  const tty: Tty = {
    ask: async () => { const v = lines.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    askHidden: async () => { const v = hidden.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    close: closed,
  };
  const stored = new Map<string, string>();
  const secrets: SecretsWriter = { location: "fake", prepare: () => {}, set: (k, v) => { stored.set(k, v); } };
  const sent: string[] = [];
  const program = new Command(); program.exitOverride();
  const claude = pinnedClaudeBin(home);
  register(program, {
    home, print: (t) => { out.push(t); }, setExitCode: (c) => { codes.push(c); }, secrets,
    ...(withTty ? { tty } : { stdinIsTTY: false }),
    exists: (p) => p === claude || existsSync(p), exec: () => "2.1.309 (Claude Code)",
    createNotifier: () => ({ send: async (m) => { sent.push(m.text); }, poll: async () => [] }),
  });
  return { home, out, codes, closed, stored, sent, run: (...args: string[]) => program.parseAsync(args, { from: "user" }) };
}

it("registers jarvis setup: a complete run exits 0 and --send-test sends once", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
  const c = cli(["n", "", "", "", "", "", "n"], []);
  await c.run("setup", "--send-test");
  expect(c.codes).toEqual([0]);
  expect(c.sent).toHaveLength(1);
  expect(c.closed).toHaveBeenCalled();
  expect(existsSync(join(c.home, ".jarvis", "setup-state.json"))).toBe(true);
});

it("an interruption exits 130 and says how to resume; repeated --redo values are all honoured", async () => {
  const c = cli(["y"], []);
  await c.run("setup");
  expect(c.codes).toEqual([130]);
  expect(c.out.join("\n")).toMatch(/run jarvis setup again/i);
  expect(c.closed).toHaveBeenCalled();
  const steps = JSON.parse(readFileSync(join(c.home, ".jarvis", "setup-state.json"), "utf8")).steps;
  expect(Object.keys(steps).sort()).toEqual(["claude", "secrets"]);
});

it("refuses to run without a terminal", async () => {
  const c = cli([], [], false);
  await expect(c.run("setup")).rejects.toThrow(/terminal/i);
  expect(existsSync(join(c.home, ".jarvis"))).toBe(false);
});

it("accepts --redo more than once", async () => {
  const first = cli(["n", "", "", "", "", "", "n"], []);
  await first.run("setup");
  const lines = ["n", ""];
  const again = cli(lines, [], true, first.home);
  await again.run("setup", "--redo", "accounts.github", "--redo", "accounts.neon");
  expect(again.codes).toEqual([0]);
  expect(lines).toEqual([]);
  const text = again.out.join("\n");
  expect(text).toMatch(/GitHub/); expect(text).toMatch(/Neon/);
  expect(text).toMatch(/accounts\.cloudflare: skipped earlier/);
});
