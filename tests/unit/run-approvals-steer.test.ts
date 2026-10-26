import { readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runApprovals } from "../../packages/cli/src/commands/run-approvals.ts";
import { ReplyInbox, recordAnswer } from "../../packages/cli/src/notify/replies.ts";
import { ingestSteerNotes } from "../../packages/cli/src/runner/inbox.ts";
import type { Message, Notifier, ReplyMessage, Action } from "../../packages/cli/src/notify/notifier.ts";
import { shortTmp } from "../helpers.ts";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });
function setup() {
  const root = shortTmp("j-phone-steer-"); roots.push(root); const ledger = Ledger.open(join(root, "project"));
  const configPath = join(root, "notify.json"); writeFileSync(configPath, JSON.stringify({ baseUrl: "https://notify.example.invalid", topic: "fake-send", replyTopic: "fake-reply" }));
  const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
  let replies: ReplyMessage[] = [];
  const sent: { topic: string; message: Message; actions: readonly Action[] }[] = [];
  const run = () => runApprovals({ ledger, broker, project: "test", configPath, taskAllowlists: [[]], now: () => 1_000_000,
    createNotifier: (options): Notifier => ({ send: async (message, actions) => { sent.push({ topic: options.topic, message, actions }); }, poll: async () => { const batch = replies; replies = []; return batch; } }), warn: () => {} });
  return { ledger, broker, sent, run, reply: (...messages: ReplyMessage[]) => { replies.push(...messages); } };
}
it("routes phone notes into the steer inbox once, including restart and replay", async () => {
  const s = setup(); const run = s.run(); const note = { id: "note-1", text: "Use blue for T2" };
  s.reply(note); await run.tick(); await run.close();
  expect(existsSync(join(s.ledger.dir, "inbox"))).toBe(true);
  expect(s.ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(0);
  expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toMatchObject([{ data: { note: note.text } }]);
  const again = s.run(); s.reply(note); await again.tick(); await again.close();
  expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toHaveLength(0);
  expect(s.ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
});
it("never consumes intake taps, malformed approval text, or its own refusal notices as steer", async () => {
  const s = setup(); const run = s.run();
  s.reply({ id: "i", text: "defaults:intake-test:nonce" }, { id: "bad", text: "approve:broken" }, { id: "echo", text: "Not counted: tap time could not be verified; tap again." });
  await run.tick(); await run.close();
  expect(s.ledger.entries().filter((e) => (e.data as { id?: string }).id === "i")).toHaveLength(0);
  expect(s.ledger.entries().filter((e) => (e.data as { answer?: string }).answer === "steer")).toHaveLength(0);
  expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toHaveLength(0);
});
it("sends a short refusal on the reply topic without the request, payload or nonce", async () => {
  const s = setup(); await s.broker.handle({ op: "spend", payload: { description: "PRIVATE FAKE PAYLOAD" } });
  const run = s.run(); await run.tick(); const a = s.sent[0]!.actions[0]!;
  s.reply({ id: "early", text: `approve:${a.requestId}:${a.nonce}`, time: 1000 }); await run.tick();
  const refusal = s.sent.find((e) => e.topic === "fake-reply");
  expect(refusal).toBeDefined(); expect(refusal!.message.text).toMatch(/^Not counted:.*tap again/);
  expect(refusal?.message.text).not.toContain(a.requestId); expect(refusal?.message.text).not.toContain(a.nonce); expect(refusal?.message.text).not.toContain("PRIVATE");
  expect(refusal?.actions).toEqual([]); expect(s.ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(0);
  s.reply({ id: "later", text: `approve:${a.requestId}:${a.nonce}`, time: 1001 }); await run.tick();
  expect(s.ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(1); await run.close();
});
it("answers only taps that carry this project's nonce: the reply topic is shared across projects", async () => {
  const s = setup(); const pending = await s.broker.handle({ op: "spend", payload: { description: "fake" } });
  const run = s.run(); await run.tick(); const a = s.sent[0]!.actions[0]!;
  s.reply({ id: "other-project", text: `approve:6f1d2c3b-0000-4000-8000-000000000000:${"a".repeat(64)}`, time: 2000 },
    { id: "forged", text: `approve:${a.requestId}:${"b".repeat(64)}`, time: 2000 });
  await run.tick();
  expect(s.sent.filter((e) => e.topic === "fake-reply")).toEqual([]);
  expect(s.ledger.entries().filter((e) => (e.data as { phase?: string }).phase === "ignored").map((e) => (e.data as { reason: string }).reason)).toEqual(["unknown-request", "unknown-nonce"]);
  s.broker.decide(pending.approvalId!, "reject", "terminal");
  s.reply({ id: "late", text: `approve:${a.requestId}:${a.nonce}`, time: 2000 }); await run.tick();
  expect(s.sent.filter((e) => e.topic === "fake-reply").map((e) => e.message.text)).toEqual(["Not counted: this request already has an answer."]);
  await run.close();
});

it("replays a note after a crash between inbox submission and its recorded marker without duplicate application", async () => {
  const s = setup(); const run = s.run(); const transact = s.ledger.transact.bind(s.ledger);
  const spy = vi.spyOn(s.ledger, "transact").mockImplementation((fn) => transact((entries, add) => fn(entries, (input) => {
    if ((input.data as { phase?: string }).phase === "recorded") throw new Error("marker fault"); return add(input);
  })));
  s.reply({ id: "crash", text: "Use green" }); await expect(run.tick()).rejects.toThrow("marker fault"); spy.mockRestore(); await run.close();
  const inboxDir = join(s.ledger.dir, "inbox"); expect(readdirSync(inboxDir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  ingestSteerNotes(s.ledger.dir, s.ledger);
  const restart = s.run(); await restart.tick(); await restart.close();
  expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toHaveLength(0);
  expect(s.ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
});
it("recovers a phone note intent before submission and refuses an oversized note without disabling taps", async () => {
  const s = setup(); const inbox = new ReplyInbox(s.ledger, { approvalProject: "test", steerInbox: true });
  expect(inbox.accept({ id: "intent", text: "Please use green" }).status).toBe("counted");
  const run = s.run(); s.reply({ id: "huge", text: "x".repeat(16385) });
  const error = await run.tick().then(() => undefined, (e: unknown) => e); expect(error).toBeUndefined();
  expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toHaveLength(1);
  expect(new ReplyInbox(s.ledger, { approvalProject: "test" }).pending()).toHaveLength(0);
  await run.close();
});
it("a failed inbox write stays pending and never sends a received confirmation", async () => {
  const s = setup(); writeFileSync(join(s.ledger.dir, "inbox"), "not a directory");
  const run = s.run(); s.reply({ id: "failure", text: "Use blue" }); await expect(run.tick()).rejects.toThrow();
  expect(s.sent).toHaveLength(0); expect(new ReplyInbox(s.ledger, { approvalProject: "test" }).pending()).toHaveLength(1);
  rmSync(join(s.ledger.dir, "inbox")); const answer = new ReplyInbox(s.ledger, { approvalProject: "test" }).pending()[0]!;
  recordAnswer(s.ledger, answer, s.broker); expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toHaveLength(1); await run.close();
});
it("recovers the stable inbox item after a crash left its temporary file", async () => {
  const s = setup(); const inbox = new ReplyInbox(s.ledger, { approvalProject: "test", steerInbox: true });
  const answer = inbox.accept({ id: "partial", text: "Use orange" }); expect(answer.status).toBe("counted");
  if (answer.status !== "counted") throw new Error("missing intent");
  const { mkdirSync } = await import("node:fs"); const dir = join(s.ledger.dir, "inbox"); mkdirSync(dir);
  writeFileSync(join(dir, `.notify-${answer.seq}.tmp`), "partial");
  const run = s.run(); await expect(run.tick()).resolves.toBeUndefined(); await run.close();
  expect(ingestSteerNotes(s.ledger.dir, s.ledger).entries).toHaveLength(1);
});
it("refuses a symlinked inbox before recovering temporary files", async () => {
  const s = setup(); const { symlinkSync, readFileSync, mkdirSync } = await import("node:fs");
  const outside = join(s.ledger.dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, ".notify-1.tmp"), "keep");
  symlinkSync(outside, join(s.ledger.dir, "inbox"));
  const inbox = new ReplyInbox(s.ledger, { approvalProject: "test", steerInbox: true }); inbox.accept({ id: "symlink", text: "Use blue" });
  const run = s.run(); await expect(run.tick()).rejects.toThrow(/director/); await run.close();
  expect(existsSync(join(outside, ".notify-1.tmp"))).toBe(true);
  expect(readFileSync(join(outside, ".notify-1.tmp"), "utf8")).toBe("keep");
});
