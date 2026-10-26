import { EventEmitter } from "node:events";
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestBroker } from "../../packages/cli/src/broker/client.ts";
import type { SignalHost } from "../../packages/cli/src/broker/host.ts";
import { prepareProductionRun, type ComposeOptions } from "../../packages/cli/src/commands/run-compose.ts";
import type { PreparedRun } from "../../packages/cli/src/commands/run.ts";
import type { Action, Message, Notifier, ReplyMessage } from "../../packages/cli/src/notify/notifier.ts";
import { createE2EProject, type E2EProject } from "../integration/e2e-helpers.ts";

// Backlog 99: `jarvis run` sends the broker's pending requests to the phone and polls the reply topic
// for as long as the run lasts; closing the run stops the broker first, then flushes and stops the poller.

const projects: E2EProject[] = [];
const prepared: PreparedRun[] = [];
afterEach(async () => {
  for (const p of prepared.splice(0)) await p.close();
  projects.splice(0).forEach((p) => p.cleanup());
});
class FakeHost extends EventEmitter implements SignalHost {
  readonly pid = 4242;
  kill() { return true; }
}
function project(baseUrl?: string): E2EProject {
  const p = createE2EProject({ scenario: "happy", approveChecks: true }); projects.push(p);
  if (baseUrl) writeFileSync(join(p.jarvisHome, "notify.json"), JSON.stringify({ baseUrl, topic: "fake-out-topic", replyTopic: "fake-in-topic" }), { mode: 0o600 });
  return p;
}
/** A phone that taps Approve on every approval it receives, once, after the send. */
function phone() {
  const sent: { message: Message; actions: readonly Action[] }[] = [];
  const tapped = new Set<string>();
  let polls = 0;
  const notifier: Notifier = {
    send: async (message, actions) => { sent.push({ message, actions }); },
    poll: async () => {
      polls++;
      const taps: ReplyMessage[] = [];
      for (const action of sent.flatMap((s) => s.actions)) {
        if (action.answer !== "approve" || tapped.has(action.requestId)) continue;
        tapped.add(action.requestId);
        taps.push({ id: `tap-${action.requestId}`, text: `approve:${action.requestId}:${action.nonce}`, time: Math.floor(Date.now() / 1000) + 2 });
      }
      return taps;
    },
  };
  return { sent, polls: () => polls, createNotifier: () => notifier };
}
async function prepare(p: E2EProject, extra: Partial<ComposeOptions> = {}): Promise<PreparedRun> {
  const run = await prepareProductionRun({ projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath },
    { home: p.home, preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass" as const, signals: new FakeHost(), warn: () => {}, ...extra });
  prepared.push(run);
  return run;
}
const runDir = (p: E2EProject) => join(p.jarvisHome, "run");
const sockets = (p: E2EProject) => existsSync(runDir(p)) ? readdirSync(runDir(p)).filter((n) => n.endsWith(".sock")) : [];
const bound = (p: E2EProject) => join(realpathSync(runDir(p)), sockets(p).find((n) => n.startsWith(".b-"))!);

describe("jarvis run approves from the phone", () => {
  it("polls while the run is up; close stops the broker, flushes the last request and records the phone's answer through the broker", async () => {
    const p = project("https://example.invalid"); const device = phone();
    const run = await prepare(p, { createNotifier: device.createNotifier });
    await vi.waitFor(() => expect(device.polls()).toBeGreaterThan(0)); // started by the run, not by a test tick
    const res = await requestBroker(bound(p), { op: "email.send", payload: { to: "jane@example.com", subject: "Fake hello", body: "Fake body" } });
    expect(res.status).toBe("pending");
    prepared.splice(prepared.indexOf(run), 1); await run.close();
    expect(sockets(p)).toEqual([]);
    const buttons = device.sent.filter((s) => s.actions.length);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.actions.map((a) => [a.answer, a.requestId])).toEqual([["approve", res.approvalId], ["reject", res.approvalId]]);
    const approvals = p.ledger.entries().filter((e) => e.kind === "approval").map((e) => e.data);
    expect(approvals).toEqual([expect.objectContaining({ approvalId: res.approvalId, payloadHash: res.payloadHash, decision: "approve", by: "ntfy" })]);
    expect(device.sent.at(-1)!.message.text).toMatch(/^Got it: Approve/);
    const polls = device.polls(); await run.close(); await new Promise((r) => setTimeout(r, 20));
    expect(device.polls()).toBe(polls);
  });

  it.each(["https://ntfy.openai.com", "https://chatgpt.com"])("refuses the run before hosting the broker when a reviewer session could reach the notifier host (%s)", async (baseUrl) => {
    const p = project(baseUrl); const device = phone();
    await expect(prepare(p, { createNotifier: device.createNotifier })).rejects.toThrow(/allowlist/);
    expect(sockets(p)).toEqual([]);
    expect(device.polls()).toBe(0); expect(device.sent).toEqual([]);
  });

  it("without a notifier, says once that approvals stay terminal-only, and runs", async () => {
    const p = project(); const warnings: string[] = [];
    const run = await prepare(p, { warn: (w) => warnings.push(w) });
    const res = await requestBroker(bound(p), { op: "email.send", payload: { to: "jane@example.com", subject: "Fake hello", body: "Fake body" } });
    expect(res.status).toBe("pending");
    expect(warnings.filter((w) => /Phone approvals are off/.test(w))).toHaveLength(1);
    expect(warnings.find((w) => /Phone approvals are off/.test(w))).toMatch(/terminal-only \(jarvis approve/);
    expect(run.loop.runBranch).toBe(p.runBranch);
  });
});
