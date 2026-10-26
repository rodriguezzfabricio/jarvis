import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/intake/commands.ts";
import { answerRound, getRoundAnswers, recoverIntakeRounds, roundSchema, sendRound } from "../../packages/cli/src/intake/round.ts";
import * as taste from "../../packages/cli/src/intake/taste.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Message } from "../../packages/cli/src/notify/notifier.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const question = { id: "CONFIRM", topic: "scope", question: "Build spec v1 as written?", why: "Confirm scope",
  default: { answer: "Yes, build as written", reason: "Follows intake" }, alternatives: ["Describe changes", "Don't build yet"] };
const profile = { admired: ["one", "two", "three"], aiMade: "generic", tone: "serious", dislikedColors: [], dislikedFonts: [], platforms: ["web"] };
function setup(questions = [question]) {
  const home = mkdtempSync(join(tmpdir(), "jarvis-stage2-live-")); dirs.push(home);
  const repoDir = join(home, "repo"); mkdirSync(join(repoDir, ".git"), { recursive: true }); mkdirSync(join(repoDir, ".jarvis/intake"), { recursive: true });
  const round = { round: 1, spec: "docs/spec/v1.md", summary: "Build habit tracker", questions, mockups: [] };
  const file = join(repoDir, ".jarvis/intake/round-1.json"); writeFileSync(file, JSON.stringify(round));
  let now = 1000; const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const ledger = Ledger.open(join(home, "ledger")); const deps = { repoDir, ledger, clock, timeoutMs: 10_000 };
  const answer = (value: unknown) => { const path = join(repoDir, ".jarvis/intake/answers-1.json"); writeFileSync(path, JSON.stringify(value)); return answerRound(1, path, deps); };
  return { home, repoDir, round, file, ledger, deps, answer, advance: (ms: number) => { now += ms; } };
}

it("accepts a yes/no question with one alternative and still requires a nonblank default", async () => {
  const s = setup([{ ...question, id: "Q4", topic: "security", default: { answer: "No", reason: "Stop at preview" }, alternatives: ["Yes"] }]);
  expect(roundSchema.safeParse(s.round).success).toBe(true);
  await expect(sendRound(s.file, s.deps)).resolves.toMatchObject({ state: "open" });
  for (const invalid of [{ ...s.round.questions[0], alternatives: [] }, { ...s.round.questions[0], default: undefined },
    { ...s.round.questions[0], default: { answer: " ", reason: "safe" } }]) {
    expect(roundSchema.safeParse({ ...s.round, questions: [invalid] }).success).toBe(false);
  }
});

it.each(["yes. A24, A25 and A33 are fine as written.", "No, don't build yet"])("records single-question text as the user's answer: %s", async (words) => {
  const s = setup(); await sendRound(s.file, s.deps);
  expect(s.answer(words)).toMatchObject({ status: "answered", by: "session", answers: { CONFIRM: words }, provenance: { CONFIRM: "user" } });
  const decisions = () => s.ledger.entries().filter((e) => e.kind === "decision" && (e.data as { source: string }).source === "intake");
  expect(decisions()).toHaveLength(1);
  expect(decisions()[0]!.data).toMatchObject({ answer: words, by: "user", acceptedDefaults: false, confirmed: true });
  expect(recoverIntakeRounds({ ...s.deps, ledger: Ledger.open(s.ledger.dir) })[0]).toMatchObject({ provenance: { CONFIRM: "user" } });
  expect(decisions()).toHaveLength(1);
});

it("keeps defaults and silence distinct from an explicit confirmation", async () => {
  for (const value of ["defaults", {}]) {
    const s = setup(); await sendRound(s.file, s.deps);
    expect(s.answer(value)).toMatchObject({ status: "defaults (accepted)", provenance: { CONFIRM: "default-accepted" } });
  }
  const s = setup(); await sendRound(s.file, { ...s.deps, notifier: { send: async () => {}, poll: async () => [] } }); s.advance(10_000);
  expect(await getRoundAnswers(1, s.deps)).toMatchObject({ status: "defaults (unconfirmed)", provenance: { CONFIRM: "default-unconfirmed" } });
  expect(s.answer("yes")).toMatchObject({ counted: false, by: "timeout" });
});

it("does not assign an ambiguous text answer to several questions", async () => {
  const s = setup([question, { ...question, id: "Q2" }]); await sendRound(s.file, s.deps);
  for (const value of ["yes", " ", true, [], { UNKNOWN: "yes" }]) expect(() => s.answer(value)).toThrow(/answer|question/i);
  expect((await getRoundAnswers(1, s.deps)).state).toBe("open");
});

it("preserves Q4 before Q5 in delivery, recorded answers and decisions", async () => {
  const s = setup(["scope", "scope", "scope", "security", "ux", "design"].map((topic, i) => ({ ...question, id: `Q${i + 1}`, topic })));
  const send = vi.fn(async (_message: Message) => {}); await sendRound(s.file, { ...s.deps, notifier: { send, poll: async () => [] } });
  const message = send.mock.calls[0]![0].text;
  expect([...message.matchAll(/Q\d \(/g)].map((m) => m[0].slice(0, 2))).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
  expect(Object.keys(s.answer({}).answers)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
  expect(s.ledger.entries().filter((e) => e.kind === "decision" && (e.data as { source: string }).source === "intake").map((e) => (e.data as { questionId: string }).questionId)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
});

it("taste show reports a missing profile without creating memory, then returns the saved profile", async () => {
  const s = setup(); const print = vi.fn(); const program = new Command(); program.exitOverride();
  register(program, { home: s.home, cwd: s.repoDir, env: {}, print });
  await program.parseAsync(["taste", "show"], { from: "user" });
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toBeNull(); expect(existsSync(join(s.home, ".jarvis"))).toBe(false);
  const file = join(s.repoDir, ".jarvis/intake/taste.json"); writeFileSync(file, JSON.stringify(profile));
  await program.parseAsync(["taste", "save", file], { from: "user" });
  await program.parseAsync(["taste", "show"], { from: "user" });
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual(profile);
});

it.each([".jarvis", ".jarvis/memory", ".jarvis/memory/user", ".jarvis/memory/user/taste.json"])("taste reads refuse symlinks at %s", (part) => {
  const s = setup(); const path = join(s.home, part); mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(join(s.home, "missing"), path);
  expect(() => taste.loadTaste({ home: s.home })).toThrow(/symlink/i);
});

it("taste reads validate stored data instead of passing malformed memory to the session", () => {
  const s = setup(); const path = join(s.home, ".jarvis/memory/user/taste.json"); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, '{}');
  expect(() => taste.loadTaste({ home: s.home })).toThrow(/admired/);
  expect(readFileSync(path, "utf8")).toBe('{}');
});

it("recovers an explicit confirmation after a fault between intent and decision writes", async () => {
  const s = setup(); await sendRound(s.file, s.deps);
  const transact = s.ledger.transact.bind(s.ledger); let fail = true;
  vi.spyOn(s.ledger, "transact").mockImplementation((fn) => transact((entries, add) => fn(entries, (input) => {
    if (fail && input.kind === "decision") { fail = false; throw new Error("decision write fault"); }
    return add(input);
  })));
  expect(() => s.answer("yes, as written")).toThrow("decision write fault");
  const recovered = recoverIntakeRounds({ ...s.deps, ledger: Ledger.open(s.ledger.dir) });
  expect(recovered[0]).toMatchObject({ status: "answered", answers: { CONFIRM: "yes, as written" }, provenance: { CONFIRM: "user" } });
  expect(s.ledger.entries().filter((e) => e.kind === "decision" && (e.data as { source: string }).source === "intake")).toHaveLength(1);
});
