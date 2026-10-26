import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ReplyInbox, type CountedAnswer } from "../../packages/cli/src/notify/replies.ts";
import { confirmation } from "../../packages/cli/src/notify/notifier.ts";
import { answerRound, getRoundAnswers, recoverIntakeRounds, sendRound } from "../../packages/cli/src/intake/round.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Exercise the exact proposed shared-module patch in a temporary copy; notify/ is not lane-owned. */
async function notifierWithProposedGuards(root: string): Promise<typeof import("../../packages/cli/src/notify/replies.ts")> {
  const origin = new URL("../../packages/cli/src/notify/replies.ts", import.meta.url);
  let source = readFileSync(origin, "utf8");
  const pending = 'isPhase(e, "answer") && !entries.some((r) => isRecorded(r, e.seq))';
  // The guard has landed in replies.ts; detect it by its own text, not by how pending() is wrapped.
  const intakeGuard = 'data(e).intakeOwned !== true && !String(data(e).requestId ?? "").startsWith("intake-")';
  if (!source.includes(intakeGuard)) { expect(source.split(pending).length - 1).toBe(1); source = source.replace(pending, `isPhase(e, "answer") && ${intakeGuard} && !entries.some((r) => isRecorded(r, e.seq))`); }
  const guard = 'if (data(entry).intakeOwned === true || String(data(entry).requestId ?? "").startsWith("intake-")) throw new Error("intake replies require intake routing");';
  const anchor = 'if (!entry || canonical(result(entry)) !== canonical(answer)) throw new Error("no matching counted answer");';
  if (!source.includes(guard)) { expect(source.split(anchor).length - 1).toBe(1); source = source.replace(anchor, `${anchor}\n    ${guard}`); }
  const imports = source.replace(/from "(\.\.?\/[^\"]+)"/g, (_whole, path: string) => `from "${new URL(path, origin).href}"`);
  const file = join(root, "guarded-replies.ts"); writeFileSync(file, imports);
  return import(pathToFileURL(file).href);
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-intake-replay-")); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, ".jarvis/intake"), { recursive: true });
  const file = join(repo, ".jarvis/intake/round-1.json"); writeFileSync(file, JSON.stringify({ round: 1, spec: "docs/spec/v1.md", summary: "Small tool", questions: [{ id: "Q1", topic: "scope", question: "Scope?", why: "Focus", default: { answer: "small", reason: "safe" }, alternatives: ["medium", "large"] }], mockups: [] }));
  const ledger = Ledger.open(join(root, "project")); let now = Date.now();
  const deps = { ledger, repoDir: repo, clock: { now: () => now, sleep: async (ms: number) => { now += ms; } }, timeoutMs: 10_000 };
  await sendRound(file, deps); return { root, repo, ledger, deps, advance: (ms: number) => { now += ms; }, guarded: await notifierWithProposedGuards(root) };
}
it("excludes and refuses local session intents on crash replay before intake recovery", async () => {
  const s = await setup(); const file = join(s.repo, "answers.json"); writeFileSync(file, '{"Q1":"custom"}');
  const transact = s.ledger.transact.bind(s.ledger); let fault = true;
  vi.spyOn(s.ledger, "transact").mockImplementation((fn) => transact((entries, add) => fn(entries, (input) => {
    if (fault && input.kind === "decision") { fault = false; throw new Error("decision write fault"); } return add(input);
  })));
  expect(() => answerRound(1, file, s.deps)).toThrow("decision write fault");
  const entry = s.ledger.entries().find((e) => (e.data as { phase?: string }).phase === "answer")!;
  const intent = entry.data as { id: string; requestId: string };
  const raw: CountedAnswer = { status: "counted", seq: entry.seq, id: intent.id, answer: "defaults", requestId: intent.requestId, confirmation: confirmation("defaults", intent.requestId) };
  expect(new s.guarded.ReplyInbox(s.ledger).pending()).toEqual([]);
  expect(() => s.guarded.recordAnswer(s.ledger, raw)).toThrow(/intake routing/i);
  expect(s.ledger.entries().find((e) => (e.data as { intakeOwned?: boolean }).intakeOwned === true)).toBeDefined();
  // Also inject an old pending() result into intake's own poller. Its routing must stay safe
  // regardless of whether the shared guards have already been integrated.
  vi.spyOn(ReplyInbox.prototype, "pending").mockReturnValue([raw]);
  const notifier = { send: async () => {}, poll: async () => [] };
  await expect(getRoundAnswers(1, { ...s.deps, notifier }, { waitMs: 1000 })).resolves.toMatchObject({ by: "session", answers: { Q1: "custom" } });
  expect(recoverIntakeRounds(s.deps)[0]).toMatchObject({ by: "session", answers: { Q1: "custom" } });
  expect(s.ledger.entries().some((e) => e.kind === "decision" && (e.data as { acceptedDefaults?: boolean }).acceptedDefaults === true)).toBe(false);
});
it("refuses a late round tap on the generic path both before and after timeout materialization", async () => {
  const s = await setup(); const request = s.ledger.entries().find((e) => (e.data as { phase?: string }).phase === "request")!.data as { requestId: string; nonce: string };
  s.advance(11_000);
  const inbox = new s.guarded.ReplyInbox(s.ledger); const message = { id: "late-before-timeout", text: `defaults:${request.requestId}:${request.nonce}` };
  // The generic inbox refuses intake taps before writing an intent; recordAnswer's guard is the backstop.
  expect(inbox.accept(message)).toMatchObject({ status: "ignored", reason: "unknown-request" });
  expect(inbox.pending()).toEqual([]);
  expect(await getRoundAnswers(1, s.deps)).toMatchObject({ by: "timeout", status: "defaults (unconfirmed)" });
  expect(inbox.accept({ ...message, id: "late-after-timeout" }).status).toBe("ignored");
  expect(s.ledger.entries().some((e) => e.kind === "decision" && (e.data as { confirmed?: boolean }).confirmed === true)).toBe(false);
});
