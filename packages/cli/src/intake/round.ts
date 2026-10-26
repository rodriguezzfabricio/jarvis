import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { atomicWrite, type AppendInput, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import type { Clock } from "../notify/intake.ts";
import { actionsFor, limitText, type Message, type Notifier, type ReplyMessage } from "../notify/notifier.ts";
import { parseReply, recordAnswer, ReplyInbox } from "../notify/replies.ts";
import type { Broker } from "../broker/broker.ts";

const text = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const line = text.refine((value) => !/[\r\n]/.test(value), "must be one line");
const repoPath = line.refine((value) => !value.startsWith("/") && !value.includes("\\")
  && !value.split("/").some((part) => part === ".." || part === "." || part === ""), "must be a repo-relative path without traversal");
const questionSchema = z.object({
  id: line.max(100), topic: z.enum(["scope", "security", "privacy", "legal", "ux", "technical", "design"]),
  question: text, why: line,
  default: z.object({ answer: text, reason: text, tradeOff: text.optional() }).strict(), alternatives: z.array(text).min(1).max(3),
}).strict();
const roundObject = z.object({
  formatVersion: z.literal(2).optional(),
  round: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), spec: repoPath,
  summary: text.refine((value) => value.split(/\r\n|\r|\n/).length <= 5, "summary must have at most 5 lines"),
  questions: z.array(questionSchema).min(1).max(7).refine((questions) => new Set(questions.map((q) => q.id)).size === questions.length, "question ids must be unique"),
  mockups: z.array(repoPath.refine((value) => value.startsWith(".jarvis/mockups/"), "mockups must be under .jarvis/mockups/")),
}).strict();
export const roundSchema = roundObject.superRefine((round, context) => {
  if (round.formatVersion !== 2) return;
  round.questions.forEach((question, index) => {
    if (!question.default.tradeOff) context.addIssue({ code: "custom", path: ["questions", index, "default", "tradeOff"], message: "Format 2 requires the known costs or an explicit not-checked limitation" });
  });
});
export type IntakeRound = z.infer<typeof roundSchema>;
export type Answers = "defaults" | Record<string, string>;
export type Provenance = "user" | "default-accepted" | "default-unconfirmed";
export interface IntakeDeps {
  ledger: Ledger;
  repoDir: string;
  notifier?: Notifier;
  broker?: Pick<Broker, "decide">;
  /** Unix milliseconds, so persisted deadlines can be compared with ledger timestamps. */
  clock?: Clock;
  timeoutMs?: number;
}
export interface RoundAnswers {
  round: number;
  state: "open" | "closed";
  status: "open" | "answered" | "defaults (accepted)" | "defaults (unconfirmed)";
  by?: "session" | "phone" | "timeout";
  answerSeq?: number;
  deadline: number | null;
  answers: Record<string, string>;
  provenance: Record<string, Provenance>;
}
export interface PollOptions { waitMs?: number; pollMs?: number }
export interface IntakeReply extends ReplyMessage { /** ntfy's Unix seconds, preserved by the adapter. */ time?: number }
export interface AnswerResult extends RoundAnswers { counted: boolean }
export interface SendResult { round: number; requestId: string; delivered: boolean; deliveryFailed?: boolean; deadline: number | null; state: RoundAnswers["state"]; status: RoundAnswers["status"] }
interface RecordedRound {
  source: "intake";
  phase: "round";
  round: number;
  requestId: string;
  file: string;
  fileHash: string;
  questionIds: string[];
  snapshot: IntakeRound;
  sentAt: number;
  deliveredAt?: number;
  timeoutMs: number;
}
type Data = Record<string, unknown>;
const clockOf = (deps: IntakeDeps): Clock => deps.clock ?? { now: Date.now, sleep: (ms, signal) => delay(ms, undefined, { signal }) };
const data = (entry: LedgerEntry): Data => entry.data !== null && typeof entry.data === "object" ? entry.data as Data : {};
const phase = (entry: LedgerEntry, name: string): boolean => entry.kind === "notify" && data(entry).source === "notify" && data(entry).phase === name;
const deadlineOf = (round: RecordedRound): number | null => round.deliveredAt === undefined ? null : round.deliveredAt + round.timeoutMs;

function findRound(entries: readonly LedgerEntry[], n: number): RecordedRound {
  const entry = entries.find((e) => e.kind === "notify" && data(e).source === "intake" && data(e).phase === "round" && data(e).round === n);
  if (!entry) throw new Error(`Intake round ${n} not found`);
  const round = entry.data as RecordedRound;
  const delivered = entries.find((e) => e.kind === "notify" && data(e).source === "intake" && data(e).phase === "delivered"
    && data(e).round === n && data(e).requestId === round.requestId && data(e).fileHash === round.fileHash);
  const deliveredAt = delivered && data(delivered).deliveredAt;
  return typeof deliveredAt === "number" && Number.isSafeInteger(deliveredAt) && deliveredAt >= 0 ? { ...round, deliveredAt } : round;
}
function requestFor(ledger: Ledger, requestId: string): { requestId: string; nonce: string } {
  const existing = ledger.entries().find((e) => phase(e, "request") && data(e).requestId === requestId);
  if (existing) {
    if (data(existing).requestKind !== "question") throw new Error("Intake request conflicts with another notification");
    return { requestId, nonce: data(existing).nonce as string };
  }
  try { return new ReplyInbox(ledger).register(requestId, "question"); } catch (error) {
    // Another sender may have registered this same round under the ledger lock.
    const entry = ledger.entries().find((e) => phase(e, "request") && data(e).requestId === requestId && data(e).requestKind === "question");
    if (!entry) throw error;
    return { requestId, nonce: data(entry).nonce as string };
  }
}
function loadRound(file: string, repoDir: string): { snapshot: IntakeRound; file: string; fileHash: string } {
  const root = resolve(repoDir);
  const absolute = resolve(root, file);
  const raw = readFileSync(absolute);
  let snapshot: IntakeRound;
  try { snapshot = roundSchema.parse(JSON.parse(raw.toString("utf8"))); } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "round"}: ${issue.message}`).join("; ") : "expected JSON";
    throw new Error(`Invalid intake round: ${detail}`);
  }
  const expected = `.jarvis/intake/round-${snapshot.round}.json`;
  if (realpathSync(absolute) !== resolve(realpathSync(root), expected)) throw new Error("Intake round path must match .jarvis/intake/round-<n>.json without symlinks");
  return { snapshot, file: expected, fileHash: createHash("sha256").update(raw).digest("hex") };
}

/** Register before sending. Only a durable successful-delivery receipt starts the default timer. */
export async function sendRound(file: string, deps: IntakeDeps): Promise<SendResult> {
  const loaded = loadRound(file, deps.repoDir);
  const n = loaded.snapshot.round;
  const timeoutMs = deps.timeoutMs ?? 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Invalid intake timeout");
  const request = requestFor(deps.ledger, `intake-${n}`);
  const round = deps.ledger.transact((entries, add): RecordedRound => {
    const prior = entries.find((e) => e.kind === "notify" && data(e).source === "intake" && data(e).round === n);
    if (prior) {
      if (data(prior).fileHash !== loaded.fileHash) throw new Error(`Intake round ${n} already sent; never reuse its number`);
      return prior.data as RecordedRound;
    }
    const record: RecordedRound = { source: "intake", phase: "round", round: n, requestId: request.requestId,
      ...loaded, questionIds: loaded.snapshot.questions.map((q) => q.id), sentAt: clockOf(deps).now(), timeoutMs };
    add({ kind: "notify", actor: "runner", data: record });
    return record;
  });
  const state = snapshotRound(n, deps);
  const result = { round: n, requestId: request.requestId, delivered: false, deadline: state.deadline, state: state.state, status: state.status };
  if (!deps.notifier || state.state === "closed") return result;
  if (readReplyCursor(deps.ledger) === undefined) atomicWrite(cursorPath(deps.ledger), JSON.stringify({ since: String(Math.floor(round.sentAt / 1000)) }));
  // Keep the pointer first; multiline question text is folded only for the phone presentation.
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  const questions = round.snapshot.questions.map((q) => `${q.id} (${q.topic}): ${oneLine(q.question)} Default: ${oneLine(q.default.answer)} Reason: ${oneLine(q.default.reason)} Trade-off: ${oneLine(q.default.tradeOff ?? "not checked (legacy round)")}`).join("\n");
  const message: Message = { kind: "question", text: limitText(`Intake round ${n}. Full round on your Mac: ${round.file}\n${round.snapshot.summary}\n${questions}\nUse defaults, or answer in the session.`) };
  try { await deps.notifier.send(message, actionsFor("question", request.requestId, request.nonce)); } catch { return { ...result, deliveryFailed: true }; }
  deps.ledger.transact((entries, add) => {
    const current = findRound(entries, n);
    if (current.deliveredAt === undefined) add({ kind: "notify", actor: "runner", data: { source: "intake", phase: "delivered", round: n,
      requestId: current.requestId, fileHash: current.fileHash, deliveredAt: clockOf(deps).now() } });
  });
  const deliveredState = snapshotRound(n, deps);
  return { ...result, delivered: true, deadline: deliveredState.deadline, state: deliveredState.state, status: deliveredState.status };
}

function parseAnswers(file: string, round: RecordedRound): Answers {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Invalid answers: expected a JSON map or string (defaults, or an answer to one question)"); }
  if (value === "defaults") return value;
  // A single-question confirmation can carry the user's words directly. Normalize it to the
  // same explicit-id map as other session answers, so replay preserves user provenance.
  if (typeof value === "string" && value.trim() && round.questionIds.length === 1) return { [round.questionIds[0]!]: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid answers: expected a JSON map or string (defaults, or an answer to one question)");
  for (const [id, answer] of Object.entries(value)) {
    if (!round.questionIds.includes(id)) throw new Error(`Unknown intake question id: ${id}`);
    if (typeof answer !== "string" || !answer.trim()) throw new Error(`Invalid answer for question ${id}: expected nonempty text`);
  }
  return value as Record<string, string>;
}
function firstIntent(entries: readonly LedgerEntry[], round: RecordedRound): LedgerEntry | undefined {
  const intents = entries.filter((e) => phase(e, "answer") && data(e).requestId === round.requestId && data(e).answer === "defaults" && data(e).intakeOwned === true && (data(e).intakeBy !== "timeout" || deadlineOf(round) !== null));
  return intents.find((entry) => data(entry).intakeBy !== "timeout") ?? intents[0];
}
type Add = (input: AppendInput) => LedgerEntry;
function localIntent(entries: readonly LedgerEntry[], add: Add, round: RecordedRound, by: "session" | "timeout" | "phone", answers: Answers, now: number, id = `intake-${by}-${round.round}`): LedgerEntry {
  const request = entries.find((e) => phase(e, "request") && data(e).requestId === round.requestId);
  if (!request) throw new Error("Intake round has no notification registration");
  // The existing inbox consumes these same intents under the same ledger lock. Keep the full
  // session answer in the intent so a crash halfway through decision writes cannot lose it.
  return add({ kind: "notify", actor: "runner", data: { source: "notify", phase: "answer", answer: "defaults",
    requestId: round.requestId, nonce: data(request).nonce, id,
    intakeOwned: true, intakeBy: by, intakeAnswers: answers, intakeAt: now } });
}
function resultFor(round: RecordedRound, intent?: LedgerEntry): RoundAnswers {
  const base: RoundAnswers = { round: round.round, state: "open", status: "open", deadline: deadlineOf(round), answers: {}, provenance: {} };
  if (!intent) return base;
  const d = data(intent);
  const late = base.deadline !== null && (typeof d.intakeAt === "number" ? d.intakeAt : Date.parse(intent.ts)) >= base.deadline;
  const by = late || d.intakeBy === "timeout" ? "timeout" : d.intakeBy === "session" ? "session" : "phone";
  const supplied = by === "session" ? d.intakeAnswers as Answers : "defaults";
  const pairs = round.snapshot.questions.map((q): [string, string] => [q.id, supplied !== "defaults" && Object.hasOwn(supplied, q.id) ? supplied[q.id]! : q.default.answer]);
  const provenance = round.snapshot.questions.map((q): [string, Provenance] => [q.id, by === "timeout" ? "default-unconfirmed" : supplied !== "defaults" && Object.hasOwn(supplied, q.id) ? "user" : "default-accepted"]);
  return { ...base, state: "closed", by, answerSeq: intent.seq, answers: Object.fromEntries(pairs), provenance: Object.fromEntries(provenance),
    status: by === "timeout" ? "defaults (unconfirmed)" : provenance.some(([, source]) => source === "user") ? "answered" : "defaults (accepted)" };
}
function recordDecisions(entries: readonly LedgerEntry[], add: Add, round: RecordedRound, intent: LedgerEntry, result: RoundAnswers): void {
  const timeout = result.by === "phone" ? entries.find((e) => phase(e, "answer") && data(e).requestId === round.requestId && data(e).intakeBy === "timeout") : undefined;
  const common = { round: round.round, requestId: round.requestId, answerSeq: intent.seq, confirmed: result.by !== "timeout",
    ...(timeout ? { supersedesAnswerSeq: timeout.seq } : {}) };
  for (const question of round.snapshot.questions) {
    if (entries.some((e) => e.kind === "decision" && data(e).source === "intake" && data(e).answerSeq === intent.seq && data(e).questionId === question.id)) continue;
    add({ kind: "decision", actor: "runner", data: { ...common, source: "intake", questionId: question.id,
      answer: result.answers[question.id], by: result.provenance[question.id], acceptedDefaults: result.provenance[question.id] === "default-accepted" } });
  }
  // Match recordAnswer's business-entry and recorded-marker conventions; replay never creates
  // accepted defaults for a session's explicit answer or an expired round.
  if (!entries.some((e) => e.kind === "decision" && data(e).source === "notify" && data(e).answerSeq === intent.seq)) {
    add({ kind: "decision", actor: "runner", data: { ...common, source: "notify", id: data(intent).id, acceptedDefaults: result.status === "defaults (accepted)" } });
  }
  if (!entries.some((e) => phase(e, "recorded") && data(e).answerSeq === intent.seq)) {
    add({ kind: "notify", actor: "runner", data: { source: "notify", phase: "recorded", answerSeq: intent.seq, id: data(intent).id, outcome: "recorded" } });
  }
}
function needsRecording(entries: readonly LedgerEntry[], round: RecordedRound, intent: LedgerEntry): boolean {
  return !entries.some((e) => phase(e, "recorded") && data(e).answerSeq === intent.seq)
    || round.questionIds.some((id) => !entries.some((e) => e.kind === "decision" && data(e).source === "intake" && data(e).answerSeq === intent.seq && data(e).questionId === id));
}
function transitionRound(n: number, deps: IntakeDeps, supplied?: Answers): AnswerResult {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid intake round number");
  const entries = deps.ledger.entries(); const round = findRound(entries, n); const intent = firstIntent(entries, round);
  if (intent && !needsRecording(entries, round, intent)) return { ...resultFor(round, intent), counted: false };
  if (!intent && supplied === undefined && (deadlineOf(round) === null || clockOf(deps).now() < deadlineOf(round)!)) return { ...resultFor(round), counted: false };
  return deps.ledger.transact((entries, add) => {
    const round = findRound(entries, n);
    const now = clockOf(deps).now();
    let intent = firstIntent(entries, round);
    if (!intent && deadlineOf(round) !== null && now >= deadlineOf(round)!) intent = localIntent(entries, add, round, "timeout", "defaults", now);
    const counted = !intent && supplied !== undefined;
    if (counted) intent = localIntent(entries, add, round, "session", supplied!, now);
    const result = resultFor(round, intent);
    if (intent) recordDecisions(entries, add, round, intent, result);
    return { ...result, counted };
  });
}
function snapshotRound(n: number, deps: IntakeDeps): RoundAnswers {
  const { counted: _counted, ...result } = transitionRound(n, deps);
  return result;
}

export function answerRound(n: number, file: string, deps: IntakeDeps): AnswerResult {
  const existing = snapshotRound(n, deps);
  if (existing.state === "closed") return { ...existing, counted: false };
  const round = findRound(deps.ledger.entries(), n);
  return transitionRound(n, deps, parseAnswers(resolve(deps.repoDir, file), round));
}

/** Call before replaying generic notifier intents at startup. Local intents carry the complete
 * answer, and must be finalized here rather than interpreted as phone defaults by recordAnswer. */
export function recoverIntakeRounds(deps: IntakeDeps): RoundAnswers[] {
  const rounds = deps.ledger.entries().filter((e) => e.kind === "notify" && data(e).source === "intake" && data(e).phase === "round");
  return rounds.map((entry) => snapshotRound(data(entry).round as number, deps));
}

/** Bounded interactive wait (decision 90). Poll retained phone replies before applying the deadline,
 * so a pre-deadline message read late can still count. Open ledger reads acquire no writer lock. */
export async function getRoundAnswers(n: number, deps: IntakeDeps, options: PollOptions = {}): Promise<RoundAnswers> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 5000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("Invalid intake wait or poll interval");
  const clock = clockOf(deps);
  const stopAt = clock.now() + waitMs;
  for (;;) {
    if (deps.notifier && waitMs > 0) await pollReplies(deps);
    const result = snapshotRound(n, deps);
    if (result.state === "closed" || clock.now() >= stopAt) return result;
    const remaining = Math.min(stopAt, result.deadline ?? stopAt) - clock.now();
    if (remaining <= 0) return snapshotRound(n, deps);
    await clock.sleep(Math.min(pollMs, remaining));
  }
}

/** Runner dispatch for this round's phone taps. Unrelated replies stay with the runner's inbox.
 * Free-text steer notes are never interpreted here as grants, approvals or intake answers. */
export function receiveRoundReply(n: number, message: IntakeReply, deps: IntakeDeps): Message | undefined {
  const round = findRound(deps.ledger.entries(), n);
  const parsed = parseReply(message.text);
  if (parsed.kind !== "button" || parsed.requestId !== round.requestId) return;
  const counted = deps.ledger.transact((entries, add) => {
    const request = entries.find((e) => phase(e, "request") && data(e).requestId === round.requestId);
    const time = message.time;
    const validTime = typeof time === "number" && Number.isSafeInteger(time) && time >= 0;
    const first = firstIntent(entries, round);
    // An on-time server event upgrades an unconfirmed timeout; explicit answers stay closed.
    const reason = !request || data(request).nonce !== parsed.nonce || parsed.answer !== "defaults" ? "invalid"
      : deadlineOf(round) === null ? "not-delivered" : first && data(first).intakeBy !== "timeout" ? "already-closed" : !validTime ? "missing-time"
      : time! * 1000 >= deadlineOf(round)! ? "late" : undefined;
    if (reason) {
      if (!entries.some((e) => data(e).source === "intake" && data(e).phase === "ignored" && data(e).id === message.id)) add({ kind: "notify", actor: "runner", data: { source: "intake", phase: "ignored", id: message.id, reason, round: n } });
      return false;
    }
    localIntent(entries, add, round, "phone", "defaults", time! * 1000, message.id);
    return true;
  });
  snapshotRound(n, deps);
  return { kind: "confirmation", text: counted ? `Got it: Use defaults (request ${round.requestId})` : `Not counted: intake round ${n} is closed or the tap is invalid or late` };
}

const cursorPath = (ledger: Ledger): string => join(ledger.dir, "intake-notify-cursor.json");
export function readReplyCursor(ledger: Ledger): string | undefined {
  try {
    const value = JSON.parse(readFileSync(cursorPath(ledger), "utf8")) as { since?: unknown };
    if (typeof value.since !== "string" || !value.since) throw new Error("Invalid intake notification cursor");
    return value.since;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return; }
}
const pendingBatches = new WeakMap<Notifier, IntakeReply[]>();
async function confirmReply(notifier: Notifier, message: Message | undefined): Promise<void> {
  if (message) { try { await notifier.send(message, []); } catch { /* The durable answer survives a missed confirmation. */ } }
}
async function pollReplies(deps: IntakeDeps): Promise<void> {
  const notifier = deps.notifier!;
  const inbox = new ReplyInbox(deps.ledger);
  const pending = inbox.pending().filter((answer) => answer.answer === "steer" || !answer.requestId.startsWith("intake-"));
  for (const answer of pending) await confirmReply(notifier, recordAnswer(deps.ledger, answer, deps.broker));
  let batch = pendingBatches.get(notifier);
  if (!batch) {
    try { batch = await notifier.poll(); } catch { return; }
    pendingBatches.set(notifier, batch);
  }
  for (const reply of batch) {
    const parsed = parseReply(reply.text);
    const round = parsed.kind === "button" ? deps.ledger.entries().find((e) => e.kind === "notify" && data(e).source === "intake" && data(e).phase === "round" && data(e).requestId === parsed.requestId) : undefined;
    const message = round ? receiveRoundReply(data(round).round as number, reply, deps)
      : recordAnswer(deps.ledger, inbox.accept(reply), deps.broker);
    await confirmReply(notifier, message);
  }
  const since = (notifier as Notifier & { readonly lastId?: string }).lastId ?? batch.at(-1)?.id;
  if (since && since !== readReplyCursor(deps.ledger)) atomicWrite(cursorPath(deps.ledger), JSON.stringify({ since }));
  pendingBatches.delete(notifier);
}
