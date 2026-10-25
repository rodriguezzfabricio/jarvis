// Shared fixture for the setup run tests (tests/unit/setup-run-*.test.ts). Each test file calls
// `installSetupHooks()`, which stubs fetch for every test and removes the homes the test made.
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { pinnedClaudeBin } from "../../../packages/cli/src/config/pins.ts";
import type { Action, Message, Notifier } from "../../../packages/cli/src/notify/notifier.ts";
import type { NtfyOptions } from "../../../packages/cli/src/notify/ntfy.ts";
import type { SecretsWriter } from "../../../packages/cli/src/broker/secrets.ts";
import type { SetupDeps } from "../../../packages/cli/src/setup/setup.ts";
import { InterruptedError, type Tty } from "../../../packages/cli/src/setup/tty.ts";

/** The rejection of a promise, or undefined: a mismatch then fails as a plain assertion. */
export async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  return undefined;
}

export const PLUGIN = fileURLToPath(new URL("../../../plugin", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
export const SENTINEL = "SENTINEL-c0ffee-TOKEN-0123456789";
const dirs: string[] = [];
/** The fetch stub of the running test (a live binding). */
export let fetchSpy: ReturnType<typeof vi.fn>;
export function installSetupHooks(): void {
  beforeEach(() => { fetchSpy = vi.fn(async () => { throw new Error("setup must not reach the network"); }); vi.stubGlobal("fetch", fetchSpy); });
  afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
}

/** A scripted terminal: ordinary answers and hidden answers come from separate queues; running out is Ctrl-C. */
export function fakeTty(lines: string[], hidden: string[]) {
  const calls: { kind: "ask" | "hidden"; prompt: string }[] = [];
  const tty: Tty = {
    ask: async (prompt) => { calls.push({ kind: "ask", prompt }); const v = lines.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    askHidden: async (prompt) => { calls.push({ kind: "hidden", prompt }); const v = hidden.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    close: () => {},
  };
  return { tty, calls, lines, hidden };
}
export function fakeSecrets() {
  const stored = new Map<string, { value: string; brokerOnly: boolean }>();
  const backend: SecretsWriter = { location: "the fake secrets backend", prepare: vi.fn(), set: vi.fn((key: string, value: string, meta: { brokerOnly: boolean }) => { stored.set(key, { value, ...meta }); }) };
  return { backend, stored };
}
export function fakeNotifier() {
  const sent: { message: Message; actions: readonly Action[] }[] = [];
  const configs: NtfyOptions[] = [];
  const notifier: Notifier = { send: async (message, actions) => { sent.push({ message, actions }); }, poll: async () => [] };
  return { sent, configs, createNotifier: (config: NtfyOptions) => { configs.push(config); return notifier; } };
}
export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "jarvis-setup-")); dirs.push(home);
  return home;
}
export function deps(home: string, tty: Tty, extra: Partial<SetupDeps> = {}) {
  const out: string[] = [];
  const claude = pinnedClaudeBin(home);
  const d: SetupDeps = {
    home, tty, print: (text) => { out.push(text); }, pluginSource: PLUGIN, repoRoot: REPO,
    exists: (p) => p === claude || existsSync(p), exec: () => "2.1.309 (Claude Code)", ...extra,
  };
  return { d, out, text: () => out.join("\n") };
}
export const TASTE = ["Linear, Things, Stripe", "A generic AI landing page", "serious", "", "Papyrus", "macOS, iOS"];
/** The answers for a complete first run: github stored, vercel stored, neon skipped, cloudflare stored, expo skipped, oauth stored, taste saved. */
export function fullAnswers(token = SENTINEL) {
  return {
    lines: ["y", "vercel", "", "y", "n", "y", "y", ...TASTE],
    hidden: [token, `${token}-vercel`, `${token}-cf`, `${token}-oauth-id`, `${token}-oauth-secret`],
  };
}
export function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name); const st = lstatSync(path);
    if (st.isDirectory()) out.push(...filesUnder(path)); else if (st.isFile()) out.push(path);
  }
  return out;
}
/** The saved state; a missing file reads as no steps, so a wrong count fails as an assertion. */
export const state = (home: string) => (existsSync(join(home, ".jarvis", "setup-state.json")) ? JSON.parse(readFileSync(join(home, ".jarvis", "setup-state.json"), "utf8")) : { steps: {} }) as { steps: Record<string, { status: string; detail: string; provider?: string; secrets?: { key: string; tier: string; brokerOnly: boolean }[] }> };
