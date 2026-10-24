import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { ReplyInbox, parseReply, recordAnswer } from "../../packages/cli/src/notify/replies.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-notify-"));
  dirs.push(dir);
  const ledger = Ledger.open(dir);
  return { dir, ledger, inbox: new ReplyInbox(ledger) };
}
/** Runs recordAnswer so that a throw fails as an assertion, not a runner error. */
function recordedMessage(run: () => ReturnType<typeof recordAnswer>): ReturnType<typeof recordAnswer> | undefined {
  let message: ReturnType<typeof recordAnswer> | undefined;
  expect(() => { message = run(); }).not.toThrow();
  return message;
}

describe("reply parsing and durable first answers", () => {
  it("parses buttons and steer notes but refuses bare or malformed control answers", () => {
    expect(parseReply("approve:r:n")).toEqual({ kind: "button", answer: "approve", requestId: "r", nonce: "n" });
    expect(parseReply("Please use blue")).toEqual({ kind: "steer", text: "Please use blue" });
    for (const text of ["approve", "reject", "defaults", "Use defaults", "approve:r", "approve:r:n:extra", "approve::n", "pause:r:n", " "]) {
      expect(parseReply(text).kind).toBe("invalid");
    }
  });
  it("generates random durable nonces and refuses re-registering a request", () => {
    const { dir, ledger, inbox } = setup();
    const first = inbox.register("one", "question");
    const second = inbox.register("two", "approval");
    expect(first.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(first.nonce).not.toBe(second.nonce);
    expect(() => new ReplyInbox(Ledger.open(dir)).register("one", "approval")).toThrow(/already/);
    expect(ledger.entries().length).toBe(2);
  });
  it("counts only the first valid answer, reporting unknown, wrong-kind, reused and later replies", () => {
    const { dir, inbox } = setup();
    const q = inbox.register("q", "question");
    const a = inbox.register("a", "approval");
    expect(inbox.accept({ id: "bad1", text: "defaults:q:unknown" })).toMatchObject({ status: "ignored", reason: "unknown-nonce" });
    expect(inbox.accept({ id: "bad2", text: `approve:q:${q.nonce}` })).toMatchObject({ status: "ignored", reason: "wrong-answer" });
    expect(inbox.accept({ id: "bad3", text: `defaults:unknown:${q.nonce}` })).toMatchObject({ status: "ignored", reason: "unknown-request" });
    const counted = inbox.accept({ id: "ok", text: `defaults:q:${q.nonce}` });
    expect(counted).toMatchObject({ status: "counted", answer: "defaults", requestId: "q", confirmation: { text: "Got it: Use defaults (request q)" } });
    expect(inbox.accept({ id: "ok", text: `defaults:q:${q.nonce}` })).toMatchObject({ status: "ignored", reason: "duplicate" });
    const restarted = new ReplyInbox(Ledger.open(dir));
    expect(restarted.accept({ id: "again", text: `defaults:q:${q.nonce}` })).toMatchObject({ status: "ignored", reason: "already-answered" });
    expect(restarted.accept({ id: "reuse", text: `approve:a:${q.nonce}` })).toMatchObject({ status: "ignored", reason: "reused-nonce" });
    expect(restarted.accept({ id: "first", text: `reject:a:${a.nonce}` })).toMatchObject({ status: "counted", answer: "reject" });
    expect(restarted.accept({ id: "later", text: `approve:a:${a.nonce}` })).toMatchObject({ status: "ignored", reason: "already-answered" });
  });
  it("makes concurrent inbox instances share the ledger's check-and-claim transaction", () => {
    const { dir, inbox } = setup();
    const r = inbox.register("a", "approval");
    const other = new ReplyInbox(Ledger.open(dir));
    expect(inbox.accept({ id: "one", text: `approve:a:${r.nonce}` }).status).toBe("counted");
    expect(other.accept({ id: "two", text: `reject:a:${r.nonce}` }).status).toBe("ignored");
  });
  it("logs ignored answers without copying untrusted bodies or unknown nonces", () => {
    const { dir, ledger, inbox } = setup();
    inbox.accept({ id: "bad", text: "approve:r:untrusted-value" });
    expect(ledger.entries().at(-1)?.data).toMatchObject({ source: "notify", phase: "ignored", reason: "unknown-request" });
    expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain("untrusted-value");
  });
});

describe("recording counted replies", () => {
  it("records defaults as accepted decision and steer as steer, once, including after restart", () => {
    const { dir, ledger, inbox } = setup();
    const q = inbox.register("q", "question");
    const d = inbox.accept({ id: "d", text: `defaults:q:${q.nonce}` });
    const s = inbox.accept({ id: "s", text: "Use the blue design" });
    expect(s).toMatchObject({ status: "counted", answer: "steer", text: "Use the blue design" });
    expect(inbox.pending()).toHaveLength(2);
    recordAnswer(ledger, d);
    recordAnswer(ledger, s);
    recordAnswer(Ledger.open(dir), d);
    recordAnswer(ledger, inbox.accept({ id: "s", text: "Use the blue design" }));
    expect(new ReplyInbox(Ledger.open(dir)).pending()).toEqual([]);
    expect(ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
    expect(ledger.entries().filter((e) => (e.data as Record<string, unknown>).acceptedDefaults === true)).toHaveLength(1);
    expect(ledger.entries().find((e) => (e.data as Record<string, unknown>).acceptedDefaults === true)).toMatchObject({ kind: "decision", data: { confirmed: true } });
  });
  it("routes approvals through Broker.decide, preserving exact-payload enforcement and not executing", async () => {
    const { ledger, inbox } = setup();
    const execute = vi.fn(async () => ({ outcome: "succeeded" as const, detail: {} }));
    const broker = new Broker({ ledger, project: "test", secrets: { get: () => undefined }, adapters: [{ op: "email.send", execute }] });
    const payload = { to: "test@example.com", subject: "Test", body: "Fake message" };
    const pending = await broker.handle({ op: "email.send", payload });
    const r = inbox.register(pending.approvalId!, "approval");
    const accepted = inbox.accept({ id: "reply", text: `approve:${r.requestId}:${r.nonce}` });
    expect(ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(0);
    expect(() => recordAnswer(ledger, accepted)).toThrow(/broker/i);
    expect(inbox.pending()).toHaveLength(1);
    const decide = vi.spyOn(broker, "decide");
    recordAnswer(ledger, accepted, broker);
    expect(decide).toHaveBeenCalledWith(r.requestId, "approve", "ntfy");
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.entries().find((e) => e.kind === "approval")).toMatchObject({ data: { approvalId: r.requestId, payloadHash: pending.payloadHash, op: "email.send" } });
    expect((await broker.handle({ op: "email.send", payload: { ...payload, body: "changed" } })).status).toBe("pending");
    recordAnswer(ledger, accepted, broker);
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it("keeps failed broker recording pending and recovers after a crash after broker.decide", async () => {
    const { dir, ledger, inbox } = setup();
    const broker = new Broker({ ledger, project: "test", secrets: { get: () => undefined }, adapters: [] });
    const p = await broker.handle({ op: "spend", payload: { description: "fake" } });
    const r = inbox.register(p.approvalId!, "approval");
    const accepted = inbox.accept({ id: "answer", text: `reject:${r.requestId}:${r.nonce}` });
    const spy = vi.spyOn(broker, "decide").mockImplementationOnce(() => { throw new Error("fault"); });
    expect(() => recordAnswer(ledger, accepted, broker)).toThrow("fault");
    expect(inbox.pending()).toHaveLength(1);
    spy.mockRestore();
    broker.decide(r.requestId, "reject", "ntfy");
    const restarted = new ReplyInbox(Ledger.open(dir));
    recordAnswer(ledger, restarted.pending()[0]!, broker);
    expect(restarted.pending()).toHaveLength(0);
    expect(ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(1);
  });
  it("refuses fabricated counted results and fails closed when the ledger is tampered", () => {
    const { dir, ledger, inbox } = setup();
    const r = inbox.register("q", "question");
    const accepted = inbox.accept({ id: "answer", text: `defaults:q:${r.nonce}` });
    expect(() => recordAnswer(ledger, { ...accepted, id: "forged" } as typeof accepted)).toThrow(/counted/);
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace('"requestId":"q"', '"requestId":"tampered"'));
    expect(() => inbox.accept({ id: "next", text: `defaults:q:${r.nonce}` })).toThrow();
    expect(() => recordAnswer(ledger, accepted)).toThrow();
  });
});

describe("decision 84 notifier contract", () => {
  it("uses notify for registrations, intents, ignored logs and approval markers", async () => {
    const { ledger, inbox } = setup();
    const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
    const p = await broker.handle({ op: "spend", payload: { description: "fake" } });
    const request = inbox.register(p.approvalId!, "approval");
    inbox.accept({ id: "invalid", text: "approve" });
    const answer = inbox.accept({ id: "valid", text: `approve:${request.requestId}:${request.nonce}` });
    recordAnswer(ledger, answer, broker);
    const bookkeeping = ledger.entries().filter((e) => (e.data as Record<string, unknown>).source === "notify");
    expect(bookkeeping.map((e) => e.kind)).toEqual(["notify", "notify", "notify", "notify"]);
    expect(inbox.pending()).toEqual([]);
  });
  it("keeps defaults and steer business entries separate from notify recorded markers", () => {
    const { ledger, inbox } = setup();
    const r = inbox.register("q", "question");
    recordAnswer(ledger, inbox.accept({ id: "d", text: `defaults:q:${r.nonce}` }));
    recordAnswer(ledger, inbox.accept({ id: "s", text: "Use blue" }));
    expect(ledger.entries().filter((e) => e.kind === "decision")).toHaveLength(1);
    expect(ledger.entries().find((e) => e.kind === "steer")?.data).toMatchObject({ note: "Use blue" });
    expect(ledger.entries().find((e) => e.kind === "steer")?.data).not.toHaveProperty("text");
    const markers = ledger.entries().filter((e) => (e.data as Record<string, unknown>).phase === "recorded");
    expect(markers.map((e) => e.kind)).toEqual(["notify", "notify"]);
    expect(inbox.pending()).toEqual([]);
  });
  it.each(["answer", "ignored"] as const)("does not append when replaying an %s transport id", (kind) => {
    const { ledger, inbox } = setup();
    const r = inbox.register("q", "question");
    const message = { id: "replay", text: kind === "answer" ? `defaults:q:${r.nonce}` : "approve" };
    inbox.accept(message);
    const before = ledger.entries();
    expect(inbox.accept(message)).toEqual({ status: "ignored", reason: "duplicate" });
    expect(ledger.entries()).toEqual(before);
  });
  it.each([
    ["reject", "approve", "Reject"],
    ["approve", "reject", "Approve"],
  ] as const)("retires a tap superseded by an earlier %s decision", async (first, later, label) => {
    const { dir, ledger, inbox } = setup();
    const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
    const p = await broker.handle({ op: "spend", payload: { description: "fake" } });
    broker.decide(p.approvalId!, first, "cli");
    const r = inbox.register(p.approvalId!, "approval");
    const answer = inbox.accept({ id: "tap", text: `${later}:${r.requestId}:${r.nonce}` });
    const message = recordedMessage(() => recordAnswer(ledger, answer, broker));
    expect(message).toEqual({ kind: "confirmation", text: `Not counted: request ${r.requestId} was already answered: ${label}` });
    expect(ledger.entries().at(-1)).toMatchObject({ kind: "notify", data: { phase: "recorded", outcome: "superseded", by: first } });
    expect(new ReplyInbox(Ledger.open(dir)).pending()).toEqual([]);
    const decide = vi.spyOn(broker, "decide");
    expect(recordAnswer(ledger, answer, broker)).toEqual(message);
    expect(decide).not.toHaveBeenCalled();
    expect(ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(1);
  });
  it("retires an approval tap with no broker request", () => {
    const { dir, ledger, inbox } = setup();
    const broker = new Broker({ ledger, project: "test", adapters: [], secrets: { get: () => undefined } });
    const r = inbox.register("missing", "approval");
    const answer = inbox.accept({ id: "tap", text: `approve:missing:${r.nonce}` });
    expect(recordedMessage(() => recordAnswer(ledger, answer, broker))).toEqual({ kind: "confirmation", text: "Not counted: request missing has no approval request" });
    expect(ledger.entries().at(-1)).toMatchObject({ kind: "notify", data: { phase: "recorded", outcome: "no-request" } });
    expect(new ReplyInbox(Ledger.open(dir)).pending()).toEqual([]);
    expect(ledger.entries().filter((e) => e.kind === "approval")).toEqual([]);
  });
  it("recovers without duplicating a business entry if its recorded marker could not be written", () => {
    const { ledger, inbox } = setup();
    const answer = inbox.accept({ id: "s", text: "Use blue" });
    const transact = ledger.transact.bind(ledger);
    const spy = vi.spyOn(ledger, "transact").mockImplementation((fn) => transact((entries, add) => fn(entries, (input) => {
      if (input.kind === "notify" && (input.data as Record<string, unknown>).phase === "recorded") throw new Error("marker fault");
      return add(input);
    })));
    expect(() => recordAnswer(ledger, answer)).toThrow("marker fault");
    spy.mockRestore();
    expect(inbox.pending()).toHaveLength(1);
    expect(ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
    recordAnswer(ledger, inbox.pending()[0]!);
    expect(ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
    expect(inbox.pending()).toEqual([]);
  });
});
