import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger, LedgerTamperError } from "../../packages/cli/src/ledger/ledger.ts";
import { ReplyInbox, recordAnswer } from "../../packages/cli/src/notify/replies.ts";
import { answerRound, getRoundAnswers, receiveRoundReply, recoverIntakeRounds, roundSchema, sendRound } from "../../packages/cli/src/intake/round.ts";
import type { IntakeDeps } from "../../packages/cli/src/intake/round.ts";
import type { Action, Message } from "../../packages/cli/src/notify/notifier.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const question = (id = "Q1") => ({ id, topic: "scope", question: "Which scope?", why: "Sets the scope", default: { answer: "small", reason: "Reversible" }, alternatives: ["medium", "large"] });
const round = () => ({ round: 1, spec: "docs/spec/v1.md", summary: "A small tool", questions: [question(), question("Q2")], mockups: [] });
function setup(timeoutMs = 900_000) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-intake-")); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, ".jarvis/intake"), { recursive: true });
  const file = join(repo, ".jarvis/intake/round-1.json"); writeFileSync(file, JSON.stringify(round()));
  let now = Date.now();
  const clock = { now: () => now, sleep: vi.fn(async (ms: number) => { if (ms <= 0) throw new Error("fake clock refuses a zero-length polling spin"); now += ms; }) };
  const notifier = { send: vi.fn(async (_message: Message, _actions: readonly Action[]) => {}), poll: vi.fn(async () => []) };
  const ledger = Ledger.open(join(root, "project"));
  const deps: IntakeDeps = { ledger, repoDir: repo, notifier, clock, timeoutMs };
  const answersFile = (answers: unknown) => { const path = join(repo, "answers.json"); writeFileSync(path, JSON.stringify(answers)); return path; };
  const tap = (id = "tap") => { const action = notifier.send.mock.calls[0]![1][0]!; return { id, text: `defaults:${action.requestId}:${action.nonce}`, time: Math.floor(now / 1000) }; };
  return { root, repo, file, ledger, deps, notifier, clock, answersFile, tap, advance: (ms: number) => { now += ms; } };
}

describe("intake round contract", () => {
  it("accepts the skill's exact handoff", () => { expect(roundSchema.parse(round())).toEqual(round()); });
  it("counts blank summary lines and preserves the question text exactly", () => {
    expect(roundSchema.safeParse({ ...round(), summary: "1\n2\n3\n4\n5\n" }).success).toBe(false);
    const value = { ...round(), questions: [{ ...question(), question: "  Keep these words?  " }] };
    expect(roundSchema.parse(value).questions[0]!.question).toBe(value.questions[0]!.question);
  });
  it.each([
    { ...round(), extra: true }, { ...round(), round: 0 }, { ...round(), summary: "1\n2\n3\n4\n5\n6" },
    { ...round(), questions: [] }, { ...round(), questions: Array.from({ length: 8 }, (_, n) => question(`Q${n}`)) },
    { ...round(), questions: [question(), question()] }, { ...round(), questions: [{ ...question(), topic: "money" }] },
    { ...round(), questions: [{ ...question(), extra: true }] }, { ...round(), questions: [{ ...question(), default: { answer: "yes", reason: "why", extra: true } }] },
    { ...round(), questions: [{ ...question(), alternatives: ["one"] }] }, { ...round(), questions: [{ ...question(), why: "a\nb" }] },
    { ...round(), spec: "../outside.md" }, { ...round(), mockups: ["/private/file.png"] }, { ...round(), mockups: [".jarvis/mockups/../../file.png"] },
  ])("rejects malformed or additional handoff fields: %j", (value) => { expect(roundSchema.safeParse(value).success).toBe(false); });
});

describe("sending intake", () => {
  it("records a snapshot, question ids and raw file hash before sending only a short pointer with a nonce", async () => {
    const s = setup();
    s.notifier.send.mockImplementationOnce(async () => {
      expect(s.ledger.entries().some((e) => (e.data as { source?: string }).source === "intake")).toBe(true);
    });
    await sendRound(s.file, s.deps);
    expect(s.ledger.entries().find((e) => (e.data as { source?: string }).source === "intake")).toMatchObject({ kind: "notify", data: { round: 1, questionIds: ["Q1", "Q2"], fileHash: createHash("sha256").update(readFileSync(s.file)).digest("hex") } });
    expect(s.notifier.send).toHaveBeenCalledOnce();
    const [message, actions] = s.notifier.send.mock.calls[0]!;
    expect(message.kind).toBe("question"); expect(message.text).toContain(".jarvis/intake/round-1.json"); expect(message.text).toContain("Q1 (scope): Which scope? Default: small");
    expect(Buffer.byteLength(message.text)).toBeLessThan(4096);
    expect(actions).toEqual([expect.objectContaining({ answer: "defaults", label: "Use defaults", requestId: "intake-1", nonce: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  });
  it("caps UTF-8 summaries while retaining the full round pointer", async () => {
    const s = setup(); writeFileSync(s.file, JSON.stringify({ ...round(), summary: "🙂".repeat(3000) }));
    await sendRound(s.file, s.deps); const text = s.notifier.send.mock.calls[0]![0].text;
    expect(Buffer.byteLength(text)).toBeLessThan(4096); expect(text).toContain(".jarvis/intake/round-1.json"); expect(text).not.toContain("�");
  });
  it("records without a transport, rejects mismatched filenames and reports validation clearly", async () => {
    const s = setup(); const { notifier: _notifier, ...deps } = s.deps;
    expect(await sendRound(s.file, deps)).toMatchObject({ delivered: false });
    expect((await getRoundAnswers(1, deps)).status).toBe("open");
    const wrong = join(s.repo, ".jarvis/intake/round-2.json"); writeFileSync(wrong, JSON.stringify(round()));
    await expect(sendRound(wrong, deps)).rejects.toThrow(/round.*path|path.*round/i);
    writeFileSync(s.file, '{"round":1}'); await expect(sendRound(s.file, deps)).rejects.toThrow(/invalid intake round/i);
  });
  it("retries a failed delivery with the same nonce and deadline, refuses round reuse with changed content", async () => {
    const s = setup(); s.notifier.send.mockRejectedValueOnce(new Error("offline"));
    await expect(sendRound(s.file, s.deps)).resolves.toMatchObject({ delivered: false, deliveryFailed: true });
    const before = await getRoundAnswers(1, s.deps); s.advance(500); await sendRound(s.file, s.deps);
    expect(s.notifier.send.mock.calls[0]![1]).toEqual(s.notifier.send.mock.calls[1]![1]);
    expect((await getRoundAnswers(1, s.deps)).deadline).toBe(before.deadline);
    writeFileSync(s.file, JSON.stringify({ ...round(), summary: "Changed" })); await expect(sendRound(s.file, s.deps)).rejects.toThrow(/already|reuse/i);
  });
  it("refuses symlinked handoffs without recording or sending them", async () => {
    const s = setup(); const target = join(s.root, "external.json"); writeFileSync(target, readFileSync(s.file)); rmSync(s.file); symlinkSync(target, s.file);
    await expect(sendRound(s.file, s.deps)).rejects.toThrow(/path|symlink/i); expect(s.ledger.entries()).toEqual([]); expect(s.notifier.send).not.toHaveBeenCalled();
  });
});

describe("first answers, defaults and ledger polling", () => {
  it("records subset session answers and accepted defaults, closes durably and rejects a later tap", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    const result = answerRound(1, s.answersFile({ Q1: "custom" }), s.deps);
    expect(result).toMatchObject({ status: "answered", state: "closed", by: "session", answers: { Q1: "custom", Q2: "small" }, provenance: { Q1: "user", Q2: "default-accepted" } });
    const message = receiveRoundReply(1, s.tap(), s.deps); expect(message?.text).toContain("Not counted");
    expect(answerRound(1, s.answersFile("defaults"), s.deps)).toEqual({ ...result, counted: false });
    const { counted: _counted, ...state } = result;
    expect(await getRoundAnswers(1, { ...s.deps, ledger: Ledger.open(s.ledger.dir) })).toEqual(state);
    expect(s.ledger.entries().filter((e) => e.kind === "decision" && (e.data as { source?: string }).source === "intake")).toHaveLength(2);
    expect(new ReplyInbox(s.ledger).pending()).toEqual([]);
  });
  it("records session defaults with the notifier's acceptedDefaults/confirmed convention", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    expect(answerRound(1, s.answersFile("defaults"), s.deps)).toMatchObject({ status: "defaults (accepted)", by: "session" });
    expect(s.ledger.entries().find((e) => e.kind === "decision" && (e.data as { source?: string }).source === "notify")).toMatchObject({ data: { acceptedDefaults: true, confirmed: true } });
  });
  it("uses the recorded snapshot after the handoff is changed or removed", async () => {
    const s = setup(); await sendRound(s.file, s.deps); rmSync(s.file);
    expect(answerRound(1, s.answersFile("defaults"), s.deps).answers).toEqual({ Q1: "small", Q2: "small" });
  });
  it("validates unknown ids, empty/non-string values and accepts own __proto__ keys safely", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    for (const value of [{ unknown: "yes" }, { Q1: "" }, { Q1: 42 }, [], "yes", null]) expect(() => answerRound(1, s.answersFile(value), s.deps)).toThrow(/answer|question/i);
    expect((await getRoundAnswers(1, s.deps)).status).toBe("open");
    const t = setup(); writeFileSync(t.file, JSON.stringify({ ...round(), questions: [question("__proto__")] })); await sendRound(t.file, t.deps);
    expect(answerRound(1, t.answersFile(JSON.parse('{"__proto__":"custom"}')), t.deps).answers).toEqual(JSON.parse('{"__proto__":"custom"}'));
  });
  it("counts a phone intent before session answers, even before the runner records its business entry", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    receiveRoundReply(1, s.tap(), s.deps);
    expect(answerRound(1, s.answersFile({ Q1: "later" }), s.deps)).toMatchObject({ status: "defaults (accepted)", by: "phone", answers: { Q1: "small", Q2: "small" } });
    expect(new ReplyInbox(s.ledger).pending()).toEqual([]);
  });
  it("reads generic notifier decisions and does not treat steer notes or another round as answers", async () => {
    const s = setup(); await sendRound(s.file, s.deps); const inbox = new ReplyInbox(s.ledger);
    recordAnswer(s.ledger, inbox.accept({ id: "steer", text: "Q1: production and spend freely" }));
    const other = inbox.register("other", "question"); recordAnswer(s.ledger, inbox.accept({ id: "other", text: `defaults:other:${other.nonce}` }));
    expect((await getRoundAnswers(1, s.deps)).status).toBe("open");
    receiveRoundReply(1, s.tap(), s.deps); expect(await getRoundAnswers(1, s.deps)).toMatchObject({ status: "defaults (accepted)", by: "phone" });
    expect(s.ledger.entries().some((e) => e.kind === "grant" || e.kind === "approval")).toBe(false);
  });
  it("keeps the default 15-minute deadline across calls and records unconfirmed defaults exactly at expiry", async () => {
    const s = setup(); await sendRound(s.file, s.deps); s.advance(899_999);
    expect((await getRoundAnswers(1, s.deps)).status).toBe("open"); s.advance(1);
    expect(await getRoundAnswers(1, s.deps)).toMatchObject({ status: "defaults (unconfirmed)", state: "closed", by: "timeout", provenance: { Q1: "default-unconfirmed", Q2: "default-unconfirmed" } });
    expect(receiveRoundReply(1, { ...s.tap(), time: Math.ceil(s.clock.now() / 1000) }, s.deps)?.text).toContain("Not counted");
    expect(answerRound(1, s.answersFile({ Q1: "late" }), s.deps).status).toBe("defaults (unconfirmed)");
    expect(s.ledger.entries().filter((e) => e.kind === "decision").every((e) => (e.data as { confirmed?: boolean }).confirmed === false)).toBe(true);
  });
  it("waits only the requested bound, polls phone replies and ledger, and closes at an injected deadline", async () => {
    const s = setup(100); await sendRound(s.file, s.deps);
    expect((await getRoundAnswers(1, s.deps, { waitMs: 40, pollMs: 10 })).status).toBe("open");
    expect(s.clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 10, 10, 10]);
    expect((await getRoundAnswers(1, s.deps, { waitMs: 100, pollMs: 10 })).status).toBe("defaults (unconfirmed)");
    expect(s.notifier.poll).toHaveBeenCalled();
  });
  it("returns early when a phone answer reaches the ledger while waiting", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    s.clock.sleep.mockImplementationOnce(async () => { receiveRoundReply(1, s.tap(), s.deps); });
    expect((await getRoundAnswers(1, s.deps, { waitMs: 100, pollMs: 10 })).by).toBe("phone");
  });
  it("propagates ledger tampering and rejects bad polling options and unknown rounds", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    await expect(getRoundAnswers(2, s.deps)).rejects.toThrow(/round.*not found/i);
    await expect(getRoundAnswers(1, s.deps, { waitMs: -1 })).rejects.toThrow(/wait|poll/i);
    await expect(getRoundAnswers(1, s.deps, { pollMs: 0 })).rejects.toThrow(/wait|poll/i);
    appendFileSync(join(s.ledger.dir, "ledger.jsonl"), '{}\n'); await expect(getRoundAnswers(1, s.deps)).rejects.toBeInstanceOf(LedgerTamperError);
  });
  it("replays a durable session intent after an injected decision-write failure without changing the winner", async () => {
    const s = setup(); await sendRound(s.file, s.deps);
    const original = s.ledger.transact.bind(s.ledger); let fail = true;
    vi.spyOn(s.ledger, "transact").mockImplementation((fn) => original((entries, add) => fn(entries, (input) => {
      if (fail && input.kind === "decision") { fail = false; throw new Error("injected write failure"); }
      return add(input);
    })));
    expect(() => answerRound(1, s.answersFile({ Q1: "first" }), s.deps)).toThrow("injected write failure");
    expect(recoverIntakeRounds(s.deps)[0]).toMatchObject({ by: "session", answers: { Q1: "first" } });
    expect(s.ledger.entries().some((e) => e.kind === "decision" && (e.data as { acceptedDefaults?: boolean }).acceptedDefaults === true && (e.data as { source?: string }).source === "notify")).toBe(false);
    expect(answerRound(1, s.answersFile({ Q1: "second" }), s.deps).answers.Q1).toBe("first");
    expect(new ReplyInbox(s.ledger).pending()).toEqual([]);
  });
});
