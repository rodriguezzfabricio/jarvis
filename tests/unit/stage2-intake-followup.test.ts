import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { answerRound, getRoundAnswers, receiveRoundReply, recoverIntakeRounds, roundSchema, sendRound } from "../../packages/cli/src/intake/round.ts";

import { register as registerIntake } from "../../packages/cli/src/intake/commands.ts";
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof registerIntake>[0] };
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const q = { id: "Q1", topic: "scope", question: "Which reminder?", why: "Meet the request", default: { answer: "Calendar", reason: "Offline", tradeOff: "Fires on logged days; re-import schedule changes" }, alternatives: ["None"] };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-followup-")); dirs.push(root);
  const repoDir = join(root, "repo"); mkdirSync(join(repoDir, ".jarvis/intake"), { recursive: true });
  const file = join(repoDir, ".jarvis/intake/round-1.json");
  const round = { formatVersion: 2, round: 1, spec: "docs/spec/v1.md", summary: "Reminder choices", questions: [q], mockups: [] };
  // Timer tests use legacy payloads too: delivery safety must apply to both versions.
  const { formatVersion: _v, ...legacy } = round; const { tradeOff: _t, ...oldDefault } = q.default;
  writeFileSync(file, JSON.stringify({ ...legacy, questions: [{ ...q, default: oldDefault }] }));
  let now = 1000;
  const clock = { now: () => now, sleep: vi.fn(async (ms: number) => { now += ms; }) };
  const ledger = Ledger.open(join(root, "ledger"));
  const notifier = { send: vi.fn(async () => {}), poll: vi.fn(async () => []) };
  const deps = { repoDir, ledger, clock, timeoutMs: 1000 };
  return { root, file, round, deps, notifier, advance: (ms: number) => { now += ms; } };
}

it("accepts legacy rounds but requires a nonblank trade-off in format 2", () => {
  const s = setup(); expect(roundSchema.safeParse(JSON.parse(readFileSync(s.file, "utf8"))).success).toBe(true);
  expect(roundSchema.safeParse(s.round).success).toBe(true);
  for (const tradeOff of [undefined, "", " "]) expect(roundSchema.safeParse({ ...s.round, questions: [{ ...q, default: { ...q.default, tradeOff } }] }).success).toBe(false);
});
it.each(["absent", "failed"])("never times out an undelivered round (%s notifier), including after restart", async (mode) => {
  const s = setup(); s.notifier.send.mockRejectedValue(new Error("offline"));
  const deps = mode === "failed" ? { ...s.deps, notifier: s.notifier } : s.deps;
  expect(await sendRound(s.file, deps)).toMatchObject({ delivered: false, deadline: null });
  s.advance(20_000);
  expect(await getRoundAnswers(1, deps, { waitMs: 1000 })).toMatchObject({ state: "open", deadline: null });
  expect(recoverIntakeRounds({ ...s.deps, ledger: Ledger.open(s.deps.ledger.dir) })[0]).toMatchObject({ state: "open", deadline: null });
  expect(s.deps.ledger.entries().filter((e) => e.kind === "decision")).toEqual([]);
  const answers = join(s.deps.repoDir, "answers.json"); writeFileSync(answers, '{"Q1":"No reminder"}');
  expect(answerRound(1, answers, s.deps)).toMatchObject({ status: "answered", provenance: { Q1: "user" } });
});
it("starts the timer at successful delivery and retries cannot extend it", async () => {
  const s = setup(); s.notifier.send.mockRejectedValueOnce(new Error("offline"));
  const deps = { ...s.deps, notifier: s.notifier };
  await sendRound(s.file, deps); s.advance(5000);
  expect(await sendRound(s.file, deps)).toMatchObject({ delivered: true, deadline: 7000 });
  s.advance(500); expect(await sendRound(s.file, deps)).toMatchObject({ deadline: 7000 });
  expect(s.deps.ledger.entries().filter((e) => (e.data as { phase?: string }).phase === "delivered")).toHaveLength(1);
  s.advance(500);
  expect(await getRoundAnswers(1, s.deps)).toMatchObject({ by: "timeout", status: "defaults (unconfirmed)" });
});
it("does not start a timer when delivery succeeds but its durable receipt fails", async () => {
  const s = setup(); const original = s.deps.ledger.transact.bind(s.deps.ledger);
  vi.spyOn(s.deps.ledger, "transact").mockImplementation((fn) => original((entries, add) => fn(entries, (input) => {
    if ((input.data as { phase?: string }).phase === "delivered") throw new Error("delivery receipt fault");
    return add(input);
  })));
  await expect(sendRound(s.file, { ...s.deps, notifier: s.notifier })).rejects.toThrow("delivery receipt fault");
  s.advance(5000); expect(recoverIntakeRounds(s.deps)[0]).toMatchObject({ state: "open", deadline: null });
});
it("requires a delivery receipt before accepting a phone tap", async () => {
  const s = setup(); await sendRound(s.file, s.deps);
  const request = s.deps.ledger.entries().find((e) => (e.data as { phase?: string }).phase === "request")!.data as { nonce: string };
  expect(receiveRoundReply(1, { id: "tap", text: `defaults:intake-1:${request.nonce}`, time: 1 }, s.deps)?.text).toContain("Not counted");
  expect((await getRoundAnswers(1, s.deps)).state).toBe("open");
});
it("an answer typed while a wait is pending closes it and is returned by that wait", async () => {
  const s = setup(); await sendRound(s.file, s.deps);
  s.deps.clock.sleep.mockImplementationOnce(async () => {
    const file = join(s.deps.repoDir, "answers.json"); writeFileSync(file, '{"Q1":"Calendar"}'); answerRound(1, file, s.deps);
  });
  expect(await getRoundAnswers(1, s.deps, { waitMs: 540_000 })).toMatchObject({ status: "answered", provenance: { Q1: "user" } });
  expect(s.deps.clock.sleep).toHaveBeenCalledOnce();
});

it("shows the known trade-off in the phone presentation", async () => {
  const s = setup(); writeFileSync(s.file, JSON.stringify(s.round));
  const send = vi.fn(async (_message: { text: string }) => {});
  await sendRound(s.file, { ...s.deps, notifier: { send, poll: async () => [] } });
  expect(send.mock.calls[0]![0].text).toContain(q.default.tradeOff);
});

it("an invalid notifier config leaves CLI rounds open instead of starting a silent timeout", async () => {
  const s = setup(); mkdirSync(join(s.deps.repoDir, ".git")); mkdirSync(join(s.root, ".jarvis"));
  writeFileSync(join(s.root, ".jarvis/notify.json"), '{"topic":"fake-invalid"}');
  const program = new Command(); program.exitOverride(); const print = vi.fn(); const warn = vi.fn();
  registerIntake(program, { home: s.root, cwd: s.deps.repoDir, env: { JARVIS_PROJECT: "example" }, clock: s.deps.clock, print, warn });
  await program.parseAsync(["intake", "send", s.file, "--timeout", "1"], { from: "user" });
  s.advance(20_000); await program.parseAsync(["intake", "answers", "1"], { from: "user" });
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ state: "open", deadline: null });
  expect(warn).toHaveBeenCalledWith("Invalid notifier configuration; notifications are off for this round");
});
it("returns the durable answer sequence through the public answer and read APIs", async () => {
  const s = setup(); await sendRound(s.file, s.deps);
  const file = join(s.deps.repoDir, "answers.json"); writeFileSync(file, '{"Q1":"Calendar"}');
  const result = answerRound(1, file, s.deps);
  const intent = s.deps.ledger.entries().find((e) => (e.data as { intakeOwned?: boolean }).intakeOwned === true)!;
  expect(result).toHaveProperty("answerSeq", intent.seq);
  expect(await getRoundAnswers(1, s.deps)).toHaveProperty("answerSeq", intent.seq);
});
it("reports an existing deadline truthfully when a delivery retry has no notifier", async () => {
  const s = setup(); mkdirSync(join(s.deps.repoDir, ".git")); mkdirSync(join(s.root, ".jarvis"));
  const config = join(s.root, ".jarvis/notify.json");
  writeFileSync(config, JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }));
  const program = new Command(); program.exitOverride(); const print = vi.fn();
  registerIntake(program, { home: s.root, cwd: s.deps.repoDir, env: { JARVIS_PROJECT: "example" }, clock: s.deps.clock, print, createNotifier: () => s.notifier });
  await program.parseAsync(["intake", "send", s.file, "--timeout", "1"], { from: "user" });
  rmSync(config); s.advance(500);
  await program.parseAsync(["intake", "send", s.file, "--timeout", "1"], { from: "user" });
  expect(print.mock.calls.at(-1)![0]).not.toContain("No deadline");
  expect(print.mock.calls.at(-1)![0]).toContain("Deadline:");
});
