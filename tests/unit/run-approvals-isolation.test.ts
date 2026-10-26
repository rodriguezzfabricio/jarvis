import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { runApprovals } from "../../packages/cli/src/commands/run-approvals.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Notifier } from "../../packages/cli/src/notify/notifier.ts";
import { shortTmp } from "../helpers.ts";

// Backlog 99: the reply path must be out of every task session's reach. Allowlists name exact public
// hosts, but a protected check that may bind local ports reaches every loopback port (sandbox/srt.ts),
// and a phone can't reach this Mac's loopback anyway: a loopback notifier keeps approvals terminal-only.

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });
function setup(baseUrl: string) {
  const root = shortTmp("j-approve-i-"); roots.push(root);
  const ledger = Ledger.open(join(root, "project"));
  const configPath = join(root, "notify.json");
  writeFileSync(configPath, JSON.stringify({ baseUrl, topic: "fake-topic", replyTopic: "fake-reply" }));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  const notifier: Notifier = { send: vi.fn(async () => {}), poll: vi.fn(async () => []) };
  const warnings: string[] = [];
  const make = (taskAllowlists: readonly (readonly string[])[] = [[]]) => runApprovals({ configPath, project: "test", ledger, broker, taskAllowlists,
    createNotifier: () => notifier, warn: (text) => warnings.push(text), timeoutMs: 50, pollMs: 60_000 });
  return { broker, notifier, warnings, make, configPath };
}

it.each(["http://127.0.0.1:8080", "http://127.1.2.3", "http://localhost:2586", "http://ntfy.localhost", "http://[::1]:8080", "https://0.0.0.0", "http://2130706433", "http://[::ffff:127.0.0.1]"])(
  "keeps approvals terminal-only for a loopback notifier (%s), without refusing the run", async (baseUrl) => {
    const s = setup(baseUrl); await s.broker.handle({ op: "spend", payload: { description: "fake" } });
    const run = s.make(); run.start(); await run.tick(); await run.close();
    expect(s.notifier.send).not.toHaveBeenCalled(); expect(s.notifier.poll).not.toHaveBeenCalled();
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/Phone approvals are off for this run: the notifier in .* is on this Mac's loopback.*terminal-only/);
    expect(s.warnings[0]).toContain(s.configPath);
  });

it.each(["https://ntfy.sh", "https://ntfy.example.com", "https://192.168.1.20"])("uses a notifier that only the runner can reach (%s)", async (baseUrl) => {
  const s = setup(baseUrl); await s.broker.handle({ op: "spend", payload: { description: "fake" } });
  const run = s.make(); await run.tick(); await run.close();
  expect(s.notifier.send).toHaveBeenCalled(); expect(s.warnings).toEqual([]);
});

it.each([["ntfy.sh", "https://ntfy.sh"], ["sh", "https://ntfy.sh"], ["openai.com", "https://ntfy.openai.com:8443"], ["192.168.1.20", "https://192.168.1.20"]])(
  "refuses the run when an allowlist entry (%s) reaches the notifier host %s", (domain, baseUrl) => {
    const s = setup(baseUrl);
    expect(() => s.make([[], [domain]])).toThrow(/task allowlist exposes the notification host/);
    expect(s.notifier.send).not.toHaveBeenCalled();
  });

it("the off notice for a missing config still says terminal-only once", async () => {
  const s = setup("https://ntfy.sh"); rmSync(s.configPath);
  const run = s.make(); await run.tick(); await run.close();
  expect(s.warnings).toEqual([expect.stringMatching(/no valid notifier configuration at .*terminal-only \(jarvis approve/)]);
});

it("refuses a run that names no session allowlists at all", () => {
  const s = setup("https://ntfy.sh");
  expect(() => s.make([])).toThrow(/allowlists are required/);
});
