import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/intake/commands.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { NtfyOptions } from "../../packages/cli/src/notify/ntfy.ts";
import type { Clock } from "../../packages/cli/src/notify/intake.ts";
import { answerRound, receiveRoundReply } from "../../packages/cli/src/intake/round.ts";
import { recordAnswer, ReplyInbox } from "../../packages/cli/src/notify/replies.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(clock?: Clock) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-intake-cli-")); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, ".jarvis/intake"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  const file = ".jarvis/intake/round-1.json";
  writeFileSync(join(repo, file), JSON.stringify({ round: 1, spec: "docs/spec/v1.md", summary: "Tool", questions: [{ id: "Q1", topic: "scope", question: "Scope?", why: "Focus", default: { answer: "small", reason: "safe" }, alternatives: ["medium", "large"] }], mockups: [] }));
  const print = vi.fn(); const warn = vi.fn(); const notifier = { send: vi.fn(async () => {}), poll: vi.fn(async () => []) };
  const createNotifier = vi.fn((_config: NtfyOptions) => notifier);
  const program = new Command(); program.exitOverride();
  register(program, { home: root, cwd: repo, env: { JARVIS_PROJECT: "example" }, print, warn, createNotifier, ...(clock ? { clock } : {}) });
  const run = (...args: string[]) => program.parseAsync(args, { from: "user" });
  return { root, repo, file, print, warn, notifier, createNotifier, run };
}
it("runs the skill calls unchanged using JARVIS_PROJECT and the existing project ledger location", async () => {
  const s = setup(); await s.run("intake", "send", s.file);
  expect(s.print).toHaveBeenCalledWith(expect.stringMatching(/answers.*typed.*session/i)); expect(s.createNotifier).not.toHaveBeenCalled();
  expect(Ledger.open(join(s.root, ".jarvis/projects/example")).entries().length).toBeGreaterThan(0);
  await s.run("intake", "answers", "1"); expect(JSON.parse(s.print.mock.calls.at(-1)![0]).status).toBe("open");
  writeFileSync(join(s.repo, "answers.json"), '"defaults"'); await s.run("intake", "answer", "1", "answers.json");
  await s.run("intake", "answers", "1", "--wait", "0"); expect(JSON.parse(s.print.mock.calls.at(-1)![0])).toMatchObject({ status: "defaults (accepted)", state: "closed" });
});

function waitingSetup() {
  const started = Date.now(); let now = started; let sleeps = 0;
  const sleep = vi.fn(async (ms: number) => {
    expect(ms).toBeGreaterThanOrEqual(1000); expect(ms).toBeLessThanOrEqual(5000);
    expect(++sleeps).toBeLessThanOrEqual(200); now += ms;
  });
  const clock = { now: () => now, sleep };
  const s = setup(clock);
  const path = join(s.repo, s.file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.questions.push({ ...value.questions[0], id: "Q2" });
  writeFileSync(path, JSON.stringify(value));
  const ledger = Ledger.open(join(s.root, ".jarvis/projects/example"));
  return { ...s, started, clock, ledger, context: { ledger, repoDir: s.repo, clock }, advance: (ms: number) => { now += ms; } };
}

it("decision 86 permits two ledger-only waits of 540 seconds and ignores phone free text until the deadline", async () => {
  const s = waitingSetup(); await s.run("intake", "send", s.file);
  const note = { id: "phone-text", text: "Q1: medium" };
  expect(receiveRoundReply(1, note, s.context)).toBeUndefined();
  recordAnswer(s.ledger, new ReplyInbox(s.ledger).accept(note));
  await s.run("intake", "answers", "1", "--wait", "540");
  expect(s.clock.now() - s.started).toBe(540_000);
  expect(JSON.parse(s.print.mock.calls.at(-1)![0])).toMatchObject({ state: "open", status: "open", answers: {} });
  expect(s.clock.sleep).toHaveBeenCalledTimes(108);
  await s.run("intake", "answers", "1", "--wait", "540");
  expect(s.clock.now() - s.started).toBe(900_000);
  expect(s.clock.sleep).toHaveBeenCalledTimes(180);
  expect(JSON.parse(s.print.mock.calls.at(-1)![0])).toMatchObject({ state: "closed", status: "defaults (unconfirmed)", by: "timeout", answers: { Q1: "small", Q2: "small" }, provenance: { Q1: "default-unconfirmed", Q2: "default-unconfirmed" } });
  expect(s.ledger.entries().filter((entry) => entry.kind === "steer")).toHaveLength(1);
  expect(s.notifier.poll).not.toHaveBeenCalled();
});

it.each(["session", "phone"] as const)("decision 86 returns early from --wait 540 when a complete %s response closes the round", async (by) => {
  const s = waitingSetup(); await s.run("intake", "send", s.file);
  const request = s.ledger.entries().find((entry) => (entry.data as { phase?: string }).phase === "request")!.data as { requestId: string; nonce: string };
  const tap = { id: "phone-defaults", text: `defaults:${request.requestId}:${request.nonce}`, time: Math.floor(s.clock.now() / 1000) };
  s.clock.sleep.mockImplementationOnce(async (ms: number) => {
    s.advance(ms);
    if (by === "session") {
      const file = join(s.repo, "answers.json"); writeFileSync(file, '{"Q1":"custom"}');
      answerRound(1, file, s.context);
    } else {
      expect(receiveRoundReply(1, tap, s.context)?.text).toContain("Got it");
    }
  });
  await s.run("intake", "answers", "1", "--wait", "540");
  expect(s.clock.now() - s.started).toBe(5000); expect(s.clock.sleep).toHaveBeenCalledOnce();
  expect(JSON.parse(s.print.mock.calls.at(-1)![0])).toMatchObject({ state: "closed", by,
    status: by === "session" ? "answered" : "defaults (accepted)", answers: { Q1: by === "session" ? "custom" : "small", Q2: "small" },
    provenance: { Q1: by === "session" ? "user" : "default-accepted", Q2: "default-accepted" } });
  expect(s.ledger.entries().find((entry) => entry.kind === "decision" && (entry.data as { questionId?: string }).questionId === "Q2")).toMatchObject({ data: { answer: "small", by: "default-accepted", acceptedDefaults: true, confirmed: true } });
  expect(receiveRoundReply(1, { ...tap, id: "later-tap" }, s.context)?.text).toContain("Not counted");
  expect(s.notifier.poll).not.toHaveBeenCalled();
});
it("loads runner configuration through an injectable notifier factory without printing topic capabilities", async () => {
  const s = setup(); mkdirSync(join(s.root, ".jarvis"));
  const config = { baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-replies" }; writeFileSync(join(s.root, ".jarvis/notify.json"), JSON.stringify(config));
  await s.run("intake", "send", s.file, "--project", "other", "--timeout", "3");
  expect(s.createNotifier).toHaveBeenCalledWith({ ...config, since: expect.any(String) }); expect(s.notifier.send).toHaveBeenCalledOnce(); expect(s.print.mock.calls.flat().join(" ")).not.toContain("fake-out");
  expect(Ledger.open(join(s.root, ".jarvis/projects/other")).entries().some((e) => (e.data as { timeoutMs?: number }).timeoutMs === 3000)).toBe(true);
});
it("sends the round through the stage 0 notifier file (backend, server, topic, reply_topic) without printing its topics", async () => {
  const s = setup(); mkdirSync(join(s.root, ".jarvis"));
  writeFileSync(join(s.root, ".jarvis/notify.json"), JSON.stringify({ backend: "ntfy", server: "https://example.invalid", topic: "fake-stage0-out", reply_topic: "fake-stage0-in" }));
  await s.run("intake", "send", s.file);
  expect(s.createNotifier).toHaveBeenCalledWith({ baseUrl: "https://example.invalid", topic: "fake-stage0-out", replyTopic: "fake-stage0-in", since: expect.any(String) });
  expect(s.notifier.send).toHaveBeenCalledOnce();
  expect(s.warn).not.toHaveBeenCalled();
  expect([...s.print.mock.calls, ...s.warn.mock.calls].flat().join(" ")).not.toMatch(/fake-stage0/);
});
it("refuses invalid project ids, rounds, waits and config without exposing config contents", async () => {
  const s = setup();
  for (const id of ["../outside", "/tmp/outside", ".", "..", "a/b"]) await expect(s.run("intake", "send", s.file, "--project", id)).rejects.toThrow(/project/i);
  for (const n of ["0", "1x", "-1"]) await expect(s.run("intake", "answers", n)).rejects.toThrow();
  await expect(s.run("intake", "answers", "1", "--wait", "NaN")).rejects.toThrow(/wait/i);
  mkdirSync(join(s.root, ".jarvis"), { recursive: true }); writeFileSync(join(s.root, ".jarvis/notify.json"), '{"topic":"fake-private-capability"}');
  await s.run("intake", "send", s.file);
  expect(s.warn).toHaveBeenCalledWith("Invalid notifier configuration; notifications are off for this round");
  expect(s.warn.mock.calls.flat().join(" ") + s.print.mock.calls.flat().join(" ")).not.toContain("fake-private-capability");
  expect(s.print.mock.calls.flat().join(" ")).toMatch(/Intake round 1 recorded/);
});
it("saves taste through the registered top-level taste command", async () => {
  const s = setup(); const profile = { admired: ["one", "two", "three"], aiMade: "generic", tone: "playful", dislikedColors: [], dislikedFonts: [], platforms: ["web"] };
  writeFileSync(join(s.repo, "taste.json"), JSON.stringify(profile)); await s.run("taste", "save", "taste.json");
  expect(JSON.parse(readFileSync(join(s.root, ".jarvis/memory/user/taste.json"), "utf8"))).toEqual(profile);
});
