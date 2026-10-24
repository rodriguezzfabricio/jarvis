import { randomBytes } from "node:crypto";
import { canonical, LedgerTamperError, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import type { Broker } from "../broker/broker.ts";
import { confirmation, type Answer, type Message, type ReplyMessage } from "./notifier.ts";

export type ParsedReply = { kind: "button"; answer: Answer; requestId: string; nonce: string }
  | { kind: "steer"; text: string } | { kind: "invalid" };
export type IgnoredReason = "invalid" | "duplicate" | "unknown-request" | "unknown-nonce" | "reused-nonce" | "already-answered" | "wrong-answer";
export type CountedAnswer = { status: "counted"; seq: number; id: string } & (
  { answer: Answer; requestId: string; confirmation: Message } | { answer: "steer"; text: string; confirmation: Message }
);
export type ReplyResult = CountedAnswer | { status: "ignored"; reason: IgnoredReason };
interface Request {
  source: "notify";
  phase: "request";
  requestId: string;
  requestKind: "question" | "approval";
  nonce: string;
}
interface Intent {
  source: "notify";
  phase: "answer";
  id: string;
  answer: Answer | "steer";
  requestId?: string;
  nonce?: string;
  text?: string;
}
type Data = Record<string, unknown>;
function data(entry: LedgerEntry): Data {
  return entry.data !== null && typeof entry.data === "object" ? entry.data as Data : {};
}
function isPhase(entry: LedgerEntry, phase: string): boolean {
  return entry.kind === "notify" && data(entry).source === "notify" && data(entry).phase === phase;
}
function isRecorded(entry: LedgerEntry, seq: number): boolean {
  return entry.kind === "notify" && data(entry).source === "notify" && data(entry).phase === "recorded" && data(entry).answerSeq === seq;
}
function result(entry: LedgerEntry): CountedAnswer {
  const d = entry.data as Intent;
  const common = { status: "counted" as const, seq: entry.seq, id: d.id };
  return d.answer === "steer"
    ? { ...common, answer: "steer", text: d.text!, confirmation: { kind: "confirmation", text: "Got it: Steer note received" } }
    : { ...common, answer: d.answer, requestId: d.requestId!, confirmation: confirmation(d.answer, d.requestId!) };
}

export function parseReply(text: string): ParsedReply {
  const trimmed = text.trim();
  const match = /^(defaults|approve|reject):([A-Za-z0-9_-]{1,200}):([A-Za-z0-9_-]{1,200})$/.exec(trimmed);
  if (match) return { kind: "button", answer: match[1] as Answer, requestId: match[2]!, nonce: match[3]! };
  // A bare or malformed tap must never turn into approval, nor become a steer command.
  if (!trimmed || /^(approve|reject|defaults|use defaults)(:|$)/i.test(trimmed) || /^[\w-]+:[^\s:]*:[^\s]*(?::.*)?$/.test(trimmed)) return { kind: "invalid" };
  return { kind: "steer", text: trimmed };
}

/** Nonces and durable answer intents live in the runner-owned ledger, never task state. Checking
 * and consuming happen under its writer lock. A crash after an intent is safe: pending() replays
 * it through recordAnswer; only after that succeeds may the caller send its confirmation. */
export class ReplyInbox {
  private readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }

  register(requestId: string, requestKind: "question" | "approval"): Request {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId) || !["question", "approval"].includes(requestKind)) throw new Error("invalid notification request");
    return this.ledger.transact((entries, add) => {
      if (entries.some((e) => isPhase(e, "request") && data(e).requestId === requestId)) throw new Error("notification request already registered");
      const request: Request = { source: "notify", phase: "request", requestId, requestKind, nonce: randomBytes(32).toString("hex") };
      add({ kind: "notify", actor: "runner", data: request });
      return request;
    });
  }

  accept(message: ReplyMessage): ReplyResult {
    if (!message.id || typeof message.text !== "string") throw new Error("invalid reply message");
    const parsed = parseReply(message.text);
    return this.ledger.transact((entries, add) => {
      const ignore = (reason: IgnoredReason): ReplyResult => {
        // Log only classification and transport id; do not echo untrusted bodies or unknown nonces.
        add({ kind: "notify", actor: "runner", data: { source: "notify", phase: "ignored", id: message.id, reason } });
        return { status: "ignored", reason };
      };
      if (entries.some((e) => (isPhase(e, "answer") || isPhase(e, "ignored")) && data(e).id === message.id)) return { status: "ignored", reason: "duplicate" };
      if (parsed.kind === "invalid") return ignore("invalid");
      let intent: Intent;
      if (parsed.kind === "button") {
        const request = entries.find((e) => isPhase(e, "request") && data(e).requestId === parsed.requestId)?.data as Request | undefined;
        if (!request) return ignore("unknown-request");
        if (entries.some((e) => isPhase(e, "answer") && data(e).requestId === parsed.requestId)) return ignore("already-answered");
        if (entries.some((e) => isPhase(e, "answer") && data(e).nonce === parsed.nonce)) return ignore("reused-nonce");
        if (request.nonce !== parsed.nonce) return ignore("unknown-nonce");
        if ((request.requestKind === "question") !== (parsed.answer === "defaults")) return ignore("wrong-answer");
        intent = { source: "notify", phase: "answer", id: message.id, answer: parsed.answer, requestId: parsed.requestId, nonce: parsed.nonce };
      } else {
        intent = { source: "notify", phase: "answer", id: message.id, answer: "steer", text: parsed.text };
      }
      return result(add({ kind: "notify", actor: "runner", data: intent }));
    });
  }

  pending(): CountedAnswer[] {
    const entries = this.ledger.entries();
    return entries.filter((e) => isPhase(e, "answer") && !entries.some((r) => isRecorded(r, e.seq))).map(result);
  }
}

type Outcome = { outcome: "recorded" } | { outcome: "superseded"; by: "approve" | "reject" } | { outcome: "no-request" };

function recordingMessage(answer: CountedAnswer, marker: Data): Message {
  if (marker.outcome === "superseded" && answer.answer !== "steer") {
    const label = marker.by === "approve" ? "Approve" : "Reject";
    return { kind: "confirmation", text: `Not counted: request ${answer.requestId} was already answered: ${label}` };
  }
  if (marker.outcome === "no-request" && answer.answer !== "steer") {
    return { kind: "confirmation", text: `Not counted: request ${answer.requestId} has no approval request` };
  }
  return answer.confirmation;
}

/** Record a durable counted intent and return the message to send. The broker owns approval
 * binding and first answers; terminal conflicts get notify markers so startup does not retry them.
 * Other failures remain pending. Replaying after the broker wrote an answer is idempotent. */
export function recordAnswer(ledger: Ledger, answer: ReplyResult, broker?: Pick<Broker, "decide">): Message | undefined {
  if (answer.status !== "counted") return;
  const recorded = ledger.transact((entries) => {
    const entry = entries.find((e) => e.seq === answer.seq && isPhase(e, "answer"));
    if (!entry || canonical(result(entry)) !== canonical(answer)) throw new Error("no matching counted answer");
    return entries.find((e) => isRecorded(e, answer.seq));
  });
  if (recorded) return recordingMessage(answer, data(recorded));
  let outcome: Outcome = { outcome: "recorded" };
  if (answer.answer === "approve" || answer.answer === "reject") {
    if (!broker) throw new Error("approval answers require the broker");
    try {
      broker.decide(answer.requestId, answer.answer, "ntfy");
    } catch (error) {
      if (error instanceof LedgerTamperError) throw error;
      // Classify from verified broker records, never from an error string or an unbound approval.
      const conflict = ledger.transact((entries): Outcome | undefined => {
        const request = entries.find((e) => e.kind === "approval_request" && data(e).approvalId === answer.requestId);
        if (!request) return { outcome: "no-request" };
        const r = data(request);
        const first = entries.find((e) => e.kind === "approval" && data(e).approvalId === answer.requestId
          && data(e).payloadHash === r.payloadHash && data(e).op === r.op
          && (data(e).decision === "approve" || data(e).decision === "reject"));
        if (first && data(first).decision !== answer.answer) {
          return { outcome: "superseded", by: data(first).decision as "approve" | "reject" };
        }
        return undefined;
      });
      if (!conflict) throw error;
      outcome = conflict;
    }
  }
  return ledger.transact((entries, add) => {
    const prior = entries.find((e) => isRecorded(e, answer.seq));
    if (prior) return recordingMessage(answer, data(prior));
    const common = { source: "notify", answerSeq: answer.seq, id: answer.id };
    // A crash can leave the business entry durable before its marker. Reuse that entry on replay.
    const businessExists = entries.some((e) => (e.kind === "decision" || e.kind === "steer")
      && data(e).source === "notify" && data(e).answerSeq === answer.seq);
    if (outcome.outcome === "recorded" && !businessExists) {
      if (answer.answer === "steer") {
        add({ kind: "steer", actor: "runner", data: { ...common, note: answer.text } });
      } else if (answer.answer === "defaults") {
        add({ kind: "decision", actor: "runner", data: { ...common, requestId: answer.requestId, acceptedDefaults: true, confirmed: true } });
      }
    }
    const marker = add({ kind: "notify", actor: "runner", data: { ...common, phase: "recorded", ...outcome } });
    return recordingMessage(answer, data(marker));
  });
}
