import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/intake/commands.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";
import { answerRound, getRoundAnswers, receiveRoundReply, roundSchema, sendRound } from "../../packages/cli/src/intake/round.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ReplyInbox } from "../../packages/cli/src/notify/replies.ts";
import type { Action, Message, ReplyMessage } from "../../packages/cli/src/notify/notifier.ts";
import { saveTaste } from "../../packages/cli/src/intake/taste.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const profile = { admired: ["one", "two", "three"], aiMade: "generic", tone: "serious", dislikedColors: [], dislikedFonts: [], platforms: ["web"] };
const question = { id: "Q1", topic: "scope", question: "Which scope?", why: "Focus", default: { answer: "small", reason: "safe" }, alternatives: ["medium", "large"] };
function setup() {
  const home = mkdtempSync(join(tmpdir(), "jarvis-intake-contract-")); dirs.push(home);
  const repo = join(home, "repo"); mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(repo, "src")); mkdirSync(join(repo, ".jarvis/intake"), { recursive: true });
  const file = join(repo, ".jarvis/intake/round-1.json");
  writeFileSync(file, JSON.stringify({ round: 1, spec: "docs/spec/v1.md", summary: "Summary", questions: [question], mockups: [] }));
  let now = Math.floor(Date.now() / 1000) * 1000;
  const clock = { now: () => now, sleep: vi.fn(async (ms: number) => { expect(ms).toBeGreaterThan(0); now += ms; }) };
  const notifier = { send: vi.fn(async (_message: Message, _actions: readonly Action[]) => {}), poll: vi.fn(async (): Promise<(ReplyMessage & { time?: number })[]> => []) };
  const ledger = Ledger.open(join(home, "project")); const deps = { repoDir: repo, ledger, notifier, clock, timeoutMs: 10_000 };
  const answers = join(repo, ".jarvis/intake/answers-1.json"); writeFileSync(answers, '"defaults"');
  const tap = (time: number, id = "tap") => { const action = notifier.send.mock.calls[0]![1][0]!; return { id, text: `defaults:${action.requestId}:${action.nonce}`, time }; };
  return { home, repo, file, clock, notifier, ledger, deps, answers, tap, advance: (ms: number) => { now += ms; } };
}

it.each([".", "src"])("runs all exact skill calls with empty env from %s", async (subdir) => {
  const s = setup(); const print = vi.fn(); const program = new Command(); program.exitOverride();
  register(program, { home: s.home, cwd: join(s.repo, subdir), env: {}, clock: s.clock, print });
  await program.parseAsync(["intake", "send", ".jarvis/intake/round-1.json"], { from: "user" });
  await program.parseAsync(["intake", "answer", "1", ".jarvis/intake/answers-1.json"], { from: "user" });
  await program.parseAsync(["intake", "answers", "1", "--wait", "540"], { from: "user" });
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ state: "closed", status: "defaults (accepted)" });
  expect(Ledger.open(join(s.home, ".jarvis/projects", projectId(s.repo))).entries().some((e) => e.kind === "decision")).toBe(true);
  const taste = ".jarvis/intake/taste.json"; writeFileSync(join(s.repo, taste), JSON.stringify(profile));
  await program.parseAsync(["taste", "save", taste], { from: "user" });
  expect(JSON.parse(readFileSync(join(s.home, ".jarvis/memory/user/taste.json"), "utf8"))).toEqual(profile);
});

it("counts a tap made before the deadline even when the poll reads it after the deadline, and persists its cursor", async () => {
  const s = setup(); await sendRound(s.file, s.deps); const before = s.clock.now(); s.advance(11_000);
  s.notifier.poll.mockResolvedValueOnce([s.tap(before / 1000 + 9)]);
  expect(await getRoundAnswers(1, s.deps, { waitMs: 540_000 })).toMatchObject({ by: "phone", status: "defaults (accepted)" });
  expect(JSON.parse(readFileSync(join(s.ledger.dir, "intake-notify-cursor.json"), "utf8"))).toEqual({ since: "tap" });
});
it("rejects a tap whose own time is after the deadline and confirms Not counted", async () => {
  const s = setup(); await sendRound(s.file, s.deps); const before = s.clock.now(); s.advance(11_000);
  s.notifier.poll.mockResolvedValueOnce([s.tap(before / 1000 + 11)]);
  expect(await getRoundAnswers(1, s.deps, { waitMs: 540_000 })).toMatchObject({ by: "timeout", status: "defaults (unconfirmed)" });
  expect(s.notifier.send.mock.calls.some(([message]) => message.text.includes("Not counted"))).toBe(true);
});
it("records polled free text as steer, leaves the round open and never asks the generic path to record a round button", async () => {
  const s = setup(); await sendRound(s.file, s.deps);
  s.notifier.poll.mockResolvedValueOnce([{ id: "note", text: "Q1: medium", time: s.clock.now() / 1000 }]);
  expect((await getRoundAnswers(1, s.deps, { waitMs: 1000 })).state).toBe("open");
  expect(s.ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
  expect(s.notifier.poll).toHaveBeenCalled();
});
it("uses entries rather than acquiring a writer lock on open, non-writing wait polls", async () => {
  const s = setup(); const { notifier: _notifier, ...deps } = s.deps; await sendRound(s.file, deps);
  const transact = vi.spyOn(s.ledger, "transact"); const entries = vi.spyOn(s.ledger, "entries");
  expect((await getRoundAnswers(1, deps, { waitMs: 1000 })).state).toBe("open");
  expect(entries).toHaveBeenCalled(); expect(transact).not.toHaveBeenCalled();
});
it("returns counted false on a closed round without reading the replacement file", async () => {
  const s = setup(); await sendRound(s.file, s.deps); answerRound(1, s.answers, s.deps);
  expect(answerRound(1, "missing-answers.json", s.deps)).toMatchObject({ counted: false, status: "defaults (accepted)", by: "session" });
});
it("prints Not counted and sets a nonzero exit code for a repeated CLI answer", async () => {
  const s = setup(); const program = new Command(); const print = vi.fn(); program.exitOverride();
  const setExitCode = vi.fn(); register(program, { home: s.home, cwd: s.repo, env: { JARVIS_PROJECT: "example" }, print, setExitCode } as Parameters<typeof register>[1]);
  const run = (...args: string[]) => program.parseAsync(args, { from: "user" });
  await run("intake", "send", s.file); await run("intake", "answer", "1", s.answers); await run("intake", "answer", "1", s.answers);
  expect(print.mock.calls.at(-1)![0]).toBe("Not counted: round 1 already closed (defaults (accepted), by session)"); expect(setExitCode).toHaveBeenCalledWith(1);
});
it("sends a pointer first, then the summary and question/default lines", async () => {
  const s = setup(); await sendRound(s.file, s.deps); const message = s.notifier.send.mock.calls[0]![0].text;
  expect(message.split("\n")[0]).toContain(".jarvis/intake/round-1.json"); expect(message).toContain("Q1 (scope): Which scope? Default: small");
  expect(message.indexOf("Summary")).toBeLessThan(message.indexOf("Q1 (scope)"));
});
it("records a failed notification without rejecting, and reports a closed round's status on send", async () => {
  const s = setup(); s.notifier.send.mockRejectedValueOnce(new Error("offline"));
  await expect(sendRound(s.file, s.deps)).resolves.toMatchObject({ delivered: false, deliveryFailed: true });
  answerRound(1, s.answers, s.deps);
  expect(await sendRound(s.file, s.deps)).toMatchObject({ state: "closed", status: "defaults (accepted)" });
});
it("prints the delivery-failure fallback and exits successfully", async () => {
  const s = setup(); const program = new Command(); const print = vi.fn(); const setExitCode = vi.fn(); program.exitOverride();
  mkdirSync(join(s.home, ".jarvis")); writeFileSync(join(s.home, ".jarvis/notify.json"), JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }));
  s.notifier.send.mockRejectedValueOnce(new Error("offline"));
  register(program, { home: s.home, cwd: s.repo, env: { JARVIS_PROJECT: "example" }, print, createNotifier: () => s.notifier, setExitCode } as Parameters<typeof register>[1]);
  await program.parseAsync(["intake", "send", s.file], { from: "user" });
  expect(print.mock.calls.at(-1)![0]).toContain("recorded; notification not delivered; answer in the session"); expect(setExitCode).not.toHaveBeenCalledWith(1);
  await program.parseAsync(["intake", "answer", "1", s.answers], { from: "user" });
  await program.parseAsync(["intake", "send", s.file], { from: "user" });
  expect(print.mock.calls.at(-1)![0]).toBe("Intake round 1 already closed (defaults (accepted)).");
});
it("names every invalid taste field in its schema error", () => {
  const s = setup(); const file = join(s.repo, "bad-taste.json"); writeFileSync(file, JSON.stringify({ ...profile, admired: [], tone: "both", platforms: [] }));
  expect(() => saveTaste(file, { home: s.home })).toThrow(/admired:.*tone:.*platforms:/s);
});
it("accepts multiline question and default reason text", () => {
  const s = setup(); const value = JSON.parse(readFileSync(s.file, "utf8")); value.questions[0].question = "Which scope?\nConsider the first launch."; value.questions[0].default.reason = "Safe.\nReversible.";
  expect(roundSchema.safeParse(value).success).toBe(true);
});
it("reloads the project cursor when a new CLI invocation polls the configured notifier", async () => {
  const s = setup(); const print = vi.fn(); const createNotifier = vi.fn((_config: { since?: string }) => s.notifier);
  mkdirSync(join(s.home, ".jarvis")); writeFileSync(join(s.home, ".jarvis/notify.json"), JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }));
  const program = () => { const value = new Command(); value.exitOverride(); register(value, { home: s.home, cwd: s.repo, env: {}, clock: s.clock, print, createNotifier }); return value; };
  await program().parseAsync(["intake", "send", s.file, "--timeout", "10"], { from: "user" });
  const time = s.clock.now() / 1000 + 9; s.advance(11_000); s.notifier.poll.mockResolvedValueOnce([s.tap(time, "resume-cursor")]);
  await program().parseAsync(["intake", "answers", "1", "--wait", "540"], { from: "user" });
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ by: "phone", status: "defaults (accepted)" });
  await program().parseAsync(["intake", "answers", "1", "--wait", "540"], { from: "user" });
  expect(createNotifier.mock.calls.at(-1)![0].since).toBe("resume-cursor");
});
it("keeps a phone answer that arrives between a session's optimistic read and locked write", async () => {
  const s = setup(); await sendRound(s.file, s.deps); const transact = s.ledger.transact.bind(s.ledger);
  const spy = vi.spyOn(s.ledger, "transact").mockImplementationOnce((fn) => {
    spy.mockRestore(); receiveRoundReply(1, s.tap(s.clock.now() / 1000), s.deps); return transact(fn);
  });
  expect(answerRound(1, s.answers, s.deps)).toMatchObject({ counted: false, by: "phone", status: "defaults (accepted)" });
});
it.each(["nonce", "time", "answer"] as const)("refuses a phone tap with invalid %s without consuming the valid response", async (bad) => {
  const s = setup(); await sendRound(s.file, s.deps); const tap = s.tap(s.clock.now() / 1000);
  const invalid = bad === "nonce" ? { ...tap, text: tap.text.replace(/:[^:]+$/, ":unknown") }
    : bad === "answer" ? { ...tap, text: tap.text.replace(/^defaults:/, "approve:") }
    : { id: tap.id, text: tap.text };
  expect(receiveRoundReply(1, invalid, s.deps)?.text).toContain("Not counted");
  expect((await getRoundAnswers(1, s.deps)).state).toBe("open");
  expect(receiveRoundReply(1, { ...tap, id: "valid" }, s.deps)?.text).toContain("Got it");
});
it("lets an on-time phone tap supersede an already materialized unconfirmed timeout", async () => {
  const s = setup(); await sendRound(s.file, s.deps); const time = s.clock.now() / 1000 + 9; s.advance(11_000);
  expect((await getRoundAnswers(1, s.deps)).status).toBe("defaults (unconfirmed)");
  const timeout = s.ledger.entries().find((e) => (e.data as { intakeBy?: string }).intakeBy === "timeout")!;
  s.notifier.poll.mockResolvedValueOnce([s.tap(time)]);
  expect(await getRoundAnswers(1, s.deps, { waitMs: 1000 })).toMatchObject({ status: "defaults (accepted)", by: "phone" });
  expect(s.ledger.entries().find((e) => e.kind === "decision" && (e.data as { source?: string; acceptedDefaults?: boolean }).source === "intake" && (e.data as { acceptedDefaults?: boolean }).acceptedDefaults === true)).toMatchObject({ data: { supersedesAnswerSeq: timeout.seq } });
});
it("replays a generic steer intent after its business write fails without losing it to a duplicate transport id", async () => {
  const s = setup(); await sendRound(s.file, s.deps); s.notifier.poll.mockResolvedValueOnce([{ id: "durable-note", text: "Use blue" }]);
  const original = s.ledger.transact.bind(s.ledger); let fault = true;
  vi.spyOn(s.ledger, "transact").mockImplementation((fn) => original((entries, add) => fn(entries, (input) => {
    if (fault && input.kind === "steer") { fault = false; throw new Error("steer write fault"); } return add(input);
  })));
  await expect(getRoundAnswers(1, s.deps, { waitMs: 1000 })).rejects.toThrow("steer write fault");
  await getRoundAnswers(1, s.deps, { waitMs: 1000 });
  expect(s.ledger.entries().filter((e) => e.kind === "steer")).toHaveLength(1);
  expect(new ReplyInbox(s.ledger).pending()).toEqual([]);
});
it("delegates a non-intake approval reply through the existing broker interface", async () => {
  const s = setup(); await sendRound(s.file, s.deps); const request = new ReplyInbox(s.ledger).register("outside-approval", "approval");
  s.notifier.poll.mockResolvedValueOnce([{ id: "approval", text: `approve:${request.requestId}:${request.nonce}` }]);
  const broker = { decide: vi.fn() };
  await expect(getRoundAnswers(1, { ...s.deps, broker }, { waitMs: 1000 })).resolves.toMatchObject({ state: "open" });
  expect(broker.decide).toHaveBeenCalledWith("outside-approval", "approve", "ntfy");
  expect((await getRoundAnswers(1, s.deps)).state).toBe("open");
});
