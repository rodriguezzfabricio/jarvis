import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runApprovals } from "../../packages/cli/src/commands/run-approvals.ts";
import type { Action, Message, Notifier, ReplyMessage } from "../../packages/cli/src/notify/notifier.ts";
import { shortTmp } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });
function setup() {
  const root = shortTmp("j-approve-"); roots.push(root);
  const ledger = Ledger.open(join(root, "project"));
  const configPath = join(root, "notify.json");
  writeFileSync(configPath, JSON.stringify({ baseUrl: "https://notify.example.invalid", topic: "fake-topic", replyTopic: "fake-reply" }));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  let now = 100_500;
  let replies: ReplyMessage[] = [];
  const sent: { message: Message; actions: readonly Action[] }[] = [];
  const notifier: Notifier = { send: vi.fn(async (message, actions) => { sent.push({ message, actions }); }), poll: vi.fn(async () => { const batch = replies; replies = []; return batch; }) };
  const warnings: string[] = [];
  const make = (extra: Partial<Parameters<typeof runApprovals>[0]> = {}) => runApprovals({ configPath, project: "test", ledger, broker,
    taskAllowlists: [[], []], createNotifier: () => notifier, now: () => now, warn: (text) => warnings.push(text), timeoutMs: 20, pollMs: 50, ...extra });
  const request = () => broker.handle({ op: "spend", payload: { description: "fake request, private payload stays local" } });
  const reply = (text: string, time: number | undefined = 102, id = "reply") => { replies.push({ id, text, ...(time !== undefined ? { time } : {}) }); };
  const button = (answer = "approve") => { const a = sent.find((s) => s.actions.length)!.actions[0]!; return `${answer}:${a.requestId}:${a.nonce}`; };
  const approvals = () => ledger.entries().filter((e) => e.kind === "approval");
  return { root, ledger, broker, configPath, notifier, sent, warnings, make, request, reply, button, approvals, advance: () => { now += 1000; } };
}

it.each(["approve", "reject"])("sends two buttons and records exactly the pending payload's %s", async (answer) => {
  const s = setup(); const p = await s.request(); const run = s.make();
  await run.tick();
  expect(s.sent[0]!.actions.map((a) => a.answer)).toEqual(["approve", "reject"]);
  expect(s.sent[0]!.actions[0]!.nonce).toMatch(/^[a-f0-9]{64}$/);
  expect(s.sent[0]!.actions[0]!.requestId).toBe(p.approvalId);
  expect(s.sent[0]!.message.text).not.toContain("private payload");
  expect(Buffer.byteLength(s.sent[0]!.message.text)).toBeLessThan(4096);
  s.reply(s.button(answer)); await run.tick();
  expect(s.approvals()).toHaveLength(1);
  expect(s.approvals()[0]!.data).toMatchObject({ approvalId: p.approvalId, payloadHash: p.payloadHash, decision: answer, by: "ntfy" });
  expect(s.sent.at(-1)!.message.text).toMatch(/Got it/);
  s.reply(s.button(answer), 103, "replay"); await run.tick();
  s.reply(s.button(answer), 103, "reply"); await run.tick();
  expect(s.approvals()).toHaveLength(1);
  expect(s.sent.filter((m) => m.actions.length)).toHaveLength(1);
  expect(s.ledger.entries().filter((e) => e.kind === "notify" && (e.data as { phase: string }).phase === "answer")).toHaveLength(1);
  await run.close();
});

it.each(["bare", "nonce", "unknown", "project", "early", "same-second", "missing-time", "malformed", "defaults", "terminal"])("ignores and records a %s reply", async (fault) => {
  const s = setup(); const p = await s.request(); const run = s.make(); await run.tick();
  let text = s.button(), time: number | undefined = 102;
  if (fault === "bare") text = "approve";
  if (fault === "nonce") text = `approve:${p.approvalId}:forged`;
  if (fault === "unknown") text = text.replace(p.approvalId!, "unknown");
  if (fault === "project") {
    const foreign = new Broker({ ledger: s.ledger, project: "foreign", adapters: [], secrets: { get: () => undefined } });
    const other = await foreign.handle({ op: "data.delete", payload: { description: "fake other project" } });
    text = text.replace(p.approvalId!, other.approvalId!);
  }
  if (fault === "early") time = 99;
  if (fault === "same-second") time = 100;
  if (fault === "missing-time") time = undefined;
  if (fault === "malformed") text += ":extra";
  if (fault === "defaults") text = s.button("defaults");
  if (fault === "terminal") s.broker.decide(p.approvalId!, "reject", "terminal");
  if (fault === "missing-time") vi.mocked(s.notifier.poll).mockResolvedValueOnce([{ id: "missing", text }]);
  else s.reply(text, time, `fault-${fault}`);
  await run.tick();
  expect(s.approvals().filter((e) => (e.data as { by: string }).by === "ntfy")).toHaveLength(0);
  expect(s.ledger.entries().some((e) => e.kind === "notify" && (e.data as { phase: string }).phase === "ignored")).toBe(true);
  await run.close();
});

it("polls during an active session and stops cleanly", async () => {
  vi.useFakeTimers(); const s = setup(); const run = s.make(); run.start();
  await vi.advanceTimersByTimeAsync(1);
  await s.request(); await vi.advanceTimersByTimeAsync(50);
  s.reply(s.button()); await vi.advanceTimersByTimeAsync(50);
  expect(s.approvals()).toHaveLength(1);
  await run.close(); const calls = vi.mocked(s.notifier.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(s.notifier.poll).toHaveBeenCalledTimes(calls);
});

it.each(["send", "poll"] as const)("a failed %s never approves or blocks and can recover", async (method) => {
  const s = setup(); await s.request();
  vi.mocked(s.notifier[method]).mockRejectedValueOnce(new Error("fake-reply transport failure"));
  const run = s.make(); await expect(run.tick()).resolves.toBeUndefined();
  expect(s.approvals()).toHaveLength(0);
  expect(s.warnings.join("\n")).not.toContain("fake-reply");
  await run.tick(); s.reply(s.button()); await run.tick();
  expect(s.approvals()).toHaveLength(1); await run.close();
});

it.each(["send", "poll"] as const)("a hung %s and a late completion cannot hold shutdown or approve", async (method) => {
  const s = setup(); await s.request();
  let finish: (value: never) => void = () => {};
  vi.mocked(s.notifier[method]).mockImplementationOnce(() => new Promise<never>((resolve) => { finish = resolve; }));
  const run = s.make(); await run.tick(); await run.close();
  finish((method === "send" ? undefined : [{ id: "late", text: s.button(), time: 102 }]) as never);
  await Promise.resolve(); expect(s.approvals()).toHaveLength(0);
  expect(s.warnings.join("\n")).toMatch(/timed out/);
});

it("notifications off says terminal-only once and leaves the request pending", async () => {
  const s = setup(); rmSync(s.configPath); await s.request(); const run = s.make();
  await run.tick(); await run.tick(); await run.close();
  expect(s.warnings).toHaveLength(1); expect(s.warnings[0]).toMatch(/terminal-only.*jarvis approve/);
  expect(s.approvals()).toHaveLength(0); expect(s.notifier.poll).not.toHaveBeenCalled();
});

it.each(["notify.example.invalid", "NOTIFY.EXAMPLE.INVALID:443", "*.invalid", "notify.example.invalid."])("refuses a task allowlist that could expose the reply host: %s", (domain) => {
  const s = setup(); expect(() => s.make({ taskAllowlists: [[domain]] })).toThrow(/allowlist|domain/i);
  expect(s.notifier.send).not.toHaveBeenCalled(); expect(s.notifier.poll).not.toHaveBeenCalled();
});

it("resumes a sent request without a second notification, with durable replay protection", async () => {
  const s = setup(); await s.request(); const run = s.make(); await run.tick(); await run.close();
  const restart = s.make(); s.reply(s.button()); await restart.tick(); await restart.close();
  const again = s.make(); s.reply(s.button(), 103, "again"); await again.tick(); await again.close();
  expect(s.approvals()).toHaveLength(1);
  expect(s.sent.filter((m) => m.actions.length)).toHaveLength(1);
});

it("flushes a request created just before the run ends", async () => {
  const s = setup(); const run = s.make(); await run.tick(); await s.request();
  await run.close();
  expect(s.sent.filter((m) => m.actions.length)).toHaveLength(1);
  const polls = vi.mocked(s.notifier.poll).mock.calls.length;
  await run.tick(); await run.close();
  expect(s.notifier.poll).toHaveBeenCalledTimes(polls);
});

it("a ledger failure while recording a transport timeout rejects the tick without an uncaught timer error", async () => {
  const s = setup(); await s.request();
  vi.mocked(s.notifier.poll).mockImplementationOnce(() => new Promise(() => {}));
  const append = s.ledger.append.bind(s.ledger);
  vi.spyOn(s.ledger, "append").mockImplementation((input) => {
    if ((input.data as { phase?: string }).phase === "approval-error") throw new Error("ledger fault");
    return append(input);
  });
  const run = s.make();
  await expect(run.tick()).rejects.toThrow("ledger fault");
  await run.close();
});

it("caps approval messages below 4 KB before handing them to an adapter", async () => {
  const s = setup(); const project = "😀".repeat(2500);
  const broker = new Broker({ ledger: s.ledger, project, adapters: [], secrets: { get: () => undefined } });
  await broker.handle({ op: "spend", payload: { description: "fake" } });
  const run = s.make({ project, broker }); await run.tick();
  expect(Buffer.byteLength(s.sent[0]!.message.text)).toBeLessThan(4096);
  await run.close();
});

it("flushes a request created while the last poll is in flight", async () => {
  const s = setup();
  let release: (messages: ReplyMessage[]) => void = () => {};
  vi.mocked(s.notifier.poll).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const run = s.make({ timeoutMs: 1000 });
  const active = run.tick();
  await vi.waitFor(() => expect(s.notifier.poll).toHaveBeenCalledOnce());
  await s.request();
  const closing = run.close();
  release([]);
  await active; await closing;
  expect(s.sent.filter((m) => m.actions.length)).toHaveLength(1);
});

it("bounds shutdown across many individually slow sends", async () => {
  vi.useFakeTimers(); const s = setup();
  for (let i = 0; i < 4; i++) await s.broker.handle({ op: "spend", payload: { description: `fake ${i}` } });
  vi.mocked(s.notifier.send).mockImplementation(() => new Promise((resolve) => { setTimeout(resolve, 15); }));
  const run = s.make({ timeoutMs: 20 });
  const active = run.tick();
  await vi.advanceTimersByTimeAsync(1);
  let done = false;
  const closing = run.close().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(21);
  expect(done).toBe(true);
  await closing; await active;
  const calls = vi.mocked(s.notifier.send).mock.calls.length;
  await vi.advanceTimersByTimeAsync(100);
  expect(s.notifier.send).toHaveBeenCalledTimes(calls);
});
