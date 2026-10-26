import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ReplyInbox, recordAnswer } from "../../packages/cli/src/notify/replies.ts";
import { shortTmp } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
async function setup(project = "test") {
  const root = shortTmp("j-replies-"); roots.push(root);
  const ledger = Ledger.open(join(root, "ledger"));
  const broker = new Broker({ ledger, project, adapters: [], secrets: { get: () => undefined } });
  const pending = await broker.handle({ op: "spend", payload: { description: "fake" } });
  const inbox = new ReplyInbox(ledger, { approvalProject: "test" });
  return { ledger, broker, pending, inbox };
}

it.each(["project", "broker-project", "no-request", "unsent", "missing-time", "before-send", "not-pending", "legacy", "nonce"])("enforces %s even with a registered nonce", async (fault) => {
  const s = await setup(fault === "broker-project" ? "other" : "test");
  const id = fault === "no-request" ? "no-such-request" : s.pending.approvalId!;
  const r = s.inbox.register(id, "approval", fault === "legacy" ? undefined : fault === "project" ? "other" : "test");
  if (fault !== "unsent" && fault !== "legacy") s.inbox.sent(id, 100_500);
  if (fault === "not-pending") s.broker.decide(id, "reject", "terminal");
  const reply = { id: "r", text: `approve:${id}:${fault === "nonce" ? "forged" : r.nonce}`, ...(fault === "missing-time" ? {} : { time: fault === "before-send" ? 100 : 101 }) };
  const result = s.inbox.accept(reply);
  expect(result.status).toBe("ignored");
  expect(s.ledger.entries().at(-1)!.data).toMatchObject({ phase: "ignored" });
  expect(s.inbox.pending()).toHaveLength(0);
});

it("the generic intake inbox cannot bypass a bound approval's send-time check", async () => {
  const s = await setup(); const r = s.inbox.register(s.pending.approvalId!, "approval", "test");
  const generic = new ReplyInbox(s.ledger);
  expect(generic.accept({ id: "forged", text: `approve:${r.requestId}:${r.nonce}`, time: 101 }).status).toBe("ignored");
});

it("recovers a counted approval after broker.decide but before its recorded marker", async () => {
  const s = await setup(); const r = s.inbox.register(s.pending.approvalId!, "approval", "test"); s.inbox.sent(r.requestId, 100_500);
  const answer = s.inbox.accept({ id: "valid", text: `approve:${r.requestId}:${r.nonce}`, time: 101 });
  expect(answer.status).toBe("counted");
  s.broker.decide(r.requestId, "approve", "ntfy");
  const inbox = new ReplyInbox(s.ledger, { approvalProject: "test" });
  expect(inbox.pending()).toHaveLength(1);
  recordAnswer(s.ledger, inbox.pending()[0]!, s.broker);
  expect(inbox.pending()).toHaveLength(0);
  expect(s.ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(1);
});

it("records project binding and refuses a broker deciding another project's request", async () => {
  const s = await setup();
  expect(s.ledger.entries()[0]!.data).toMatchObject({ project: "test" });
  const other = new Broker({ ledger: s.ledger, project: "other", adapters: [], secrets: { get: () => undefined } });
  expect(() => other.decide(s.pending.approvalId!, "approve", "ntfy")).toThrow(/project/);
});

it("claims a nonce once even before the broker answer is recorded", async () => {
  const s = await setup(); const r = s.inbox.register(s.pending.approvalId!, "approval", "test"); s.inbox.sent(r.requestId, 100_500);
  const text = `approve:${r.requestId}:${r.nonce}`;
  expect(s.inbox.accept({ id: "first", text, time: 101 }).status).toBe("counted");
  expect(s.inbox.accept({ id: "second", text, time: 102 }).status).toBe("ignored");
  expect(s.inbox.pending()).toHaveLength(1);
});

it("passes over steer notes and intake taps without a trace, so the inbox that owns them still reads them", async () => {
  const s = await setup();
  const before = s.ledger.entries().length;
  expect(s.inbox.accept({ id: "steer-1", text: "a fake steer note", time: 101 })).toEqual({ status: "ignored", reason: "not-approval" });
  expect(s.inbox.accept({ id: "intake-1", text: "defaults:intake-1-fake:nonce", time: 101 })).toEqual({ status: "ignored", reason: "not-approval" });
  expect(s.ledger.entries()).toHaveLength(before);
  expect(new ReplyInbox(s.ledger).accept({ id: "steer-1", text: "a fake steer note" }).status).toBe("counted");
  // Approval-shaped faults are still recorded: a bare word, or Use defaults on an approval request.
  const r = s.inbox.register(s.pending.approvalId!, "approval", "test"); s.inbox.sent(r.requestId, 100_500);
  expect(s.inbox.accept({ id: "bare", text: "approve", time: 101 })).toEqual({ status: "ignored", reason: "invalid" });
  expect(s.inbox.accept({ id: "kind", text: `defaults:${r.requestId}:${r.nonce}`, time: 101 })).toEqual({ status: "ignored", reason: "wrong-answer" });
  expect(s.ledger.entries().filter((e) => (e.data as { phase?: string }).phase === "ignored")).toHaveLength(2);
});

it("a phone inbox recovers only its own project-bound intents", async () => {
  const s = await setup();
  const generic = new ReplyInbox(s.ledger);
  const r = generic.register("legacy", "approval");
  generic.accept({ id: "old", text: `approve:legacy:${r.nonce}` });
  generic.accept({ id: "steer", text: "a fake steer note" });
  expect(s.inbox.pending()).toHaveLength(0);
});
