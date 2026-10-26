import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { submitSteer } from "../runner/inbox.ts";
import { canonical, LedgerTamperError, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import type { Broker } from "../broker/broker.ts";
import { confirmation, type Answer, type Message, type ReplyMessage } from "./notifier.ts";

/** How far ntfy's own time for a publish may stand in for the Mac's later record of the send, when the
 * Mac's clock runs ahead (decision 130). It never bounds how late a tap may come. */
export const MAX_APPROVAL_CLOCK_SKEW_SECONDS = 120;

export type ParsedReply = { kind: "button"; answer: Answer; requestId: string; nonce: string }
  | { kind: "steer"; text: string } | { kind: "invalid" };
export type IgnoredReason = "invalid" | "duplicate" | "unknown-request" | "unknown-nonce" | "reused-nonce" | "already-answered" | "wrong-answer" | "wrong-project" | "not-sent" | "before-send" | "not-approval";
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
  project?: string;
}
interface Intent {
  source: "notify";
  phase: "answer";
  id: string;
  answer: Answer | "steer";
  requestId?: string;
  nonce?: string;
  text?: string;
  approvalProject?: string;
  steerInbox?: boolean;
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
  if (!trimmed || Buffer.byteLength(trimmed) > 16_384 || /^Not counted:/i.test(trimmed) || /^(approve|reject|defaults|use defaults)(:|$)/i.test(trimmed) || /^[\w-]+:[^\s:]*:[^\s]*(?::.*)?$/.test(trimmed)) return { kind: "invalid" };
  return { kind: "steer", text: trimmed };
}

/** Nonces and durable answer intents live in the runner-owned ledger, never task state. Checking
 * and consuming happen under its writer lock. A crash after an intent is safe: pending() replays
 * it through recordAnswer; only after that succeeds may the caller send its confirmation. */
export class ReplyInbox {
  private readonly ledger: Ledger;
  private readonly approvalProject: string | undefined;
  private readonly steerInbox: boolean;
  constructor(ledger: Ledger, options: { approvalProject?: string; steerInbox?: boolean } = {}) {
    this.ledger = ledger;
    this.approvalProject = options.approvalProject;
    this.steerInbox = options.steerInbox === true;
  }

  register(requestId: string, requestKind: "question" | "approval", project?: string): Request {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId) || !["question", "approval"].includes(requestKind)) throw new Error("invalid notification request");
    return this.ledger.transact((entries, add) => {
      if (entries.some((e) => isPhase(e, "request") && data(e).requestId === requestId)) throw new Error("notification request already registered");
      const request: Request = { source: "notify", phase: "request", requestId, requestKind, nonce: randomBytes(32).toString("hex"), ...(project !== undefined ? { project } : {}) };
      add({ kind: "notify", actor: "runner", data: request });
      return request;
    });
  }

  /** Record only after a successful send. A failed or ambiguous send grants no phone capability.
   * `serverTime` is ntfy's own time for this publish, in seconds, when the response gave one. */
  sent(requestId: string, sentAt: number, serverTime?: number): void {
    if (!Number.isSafeInteger(sentAt) || sentAt < 0) throw new Error("invalid notification send time");
    if (serverTime !== undefined && (!Number.isSafeInteger(serverTime) || serverTime < 0)) throw new Error("invalid notification server time");
    this.ledger.transact((entries, add) => {
      const request = entries.find((e) => isPhase(e, "request") && data(e).requestId === requestId);
      if (!request || typeof data(request).project !== "string") throw new Error("no project-bound notification request");
      if (entries.some((e) => isPhase(e, "sent") && data(e).requestId === requestId)) return;
      add({ kind: "notify", actor: "runner", data: { source: "notify", phase: "sent", requestId, sentAt, ...(serverTime !== undefined ? { serverTime } : {}) } });
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
      // Intake owns its taps; leaving no trace lets its reader still claim them on this ledger.
      if (this.approvalProject !== undefined && parsed.kind === "button" && parsed.requestId.startsWith("intake-")) return { status: "ignored", reason: "not-approval" };
      if (this.approvalProject !== undefined && parsed.kind === "steer" && !this.steerInbox) return { status: "ignored", reason: "not-approval" };
      if (this.approvalProject !== undefined && parsed.kind === "button" && parsed.answer === "defaults") return ignore("wrong-answer");
      let intent: Intent;
      if (parsed.kind === "button") {
        // Intake taps are routed to the intake round (receiveRoundReply), never answered here (decision 90).
        if (parsed.requestId.startsWith("intake-")) return ignore("unknown-request");
        const request = entries.find((e) => isPhase(e, "request") && data(e).requestId === parsed.requestId)?.data as Request | undefined;
        if (!request) return ignore("unknown-request");
        if (entries.some((e) => isPhase(e, "answer") && data(e).requestId === parsed.requestId)) return ignore("already-answered");
        if (entries.some((e) => isPhase(e, "answer") && data(e).nonce === parsed.nonce)) return ignore("reused-nonce");
        if (request.nonce !== parsed.nonce) return ignore("unknown-nonce");
        if ((request.requestKind === "question") !== (parsed.answer === "defaults")) return ignore("wrong-answer");
        if (this.approvalProject !== undefined || request.project !== undefined) {
          const reason = approvalGuard(entries, request, this.approvalProject ?? request.project!, message.time);
          if (reason) return ignore(reason);
          // Counted only because ntfy's clock stood in for the Mac's: record by how much (decision 130).
          const sent = sentRecord(entries, request);
          if (sent && message.time! * 1000 <= (sent.sentAt as number)) add({ kind: "notify", actor: "runner", data: { source: "notify", phase: "clock-skew", id: message.id, requestId: request.requestId,
            skewSeconds: (sent.sentAt as number) / 1000 - (sent.serverTime as number), allowedSeconds: (sent.sentAt as number) / 1000 - sendReference(sent) } });
        }
        intent = { source: "notify", phase: "answer", id: message.id, answer: parsed.answer, requestId: parsed.requestId, nonce: parsed.nonce,
          ...(request.project !== undefined ? { approvalProject: request.project } : {}) };
      } else {
        intent = { source: "notify", phase: "answer", id: message.id, answer: "steer", text: parsed.text,
          ...(this.approvalProject !== undefined ? { approvalProject: this.approvalProject } : {}), ...(this.steerInbox ? { steerInbox: true } : {}) };
      }
      return result(add({ kind: "notify", actor: "runner", data: intent }));
    });
  }

  pending(): CountedAnswer[] {
    const entries = this.ledger.entries();
    return entries.filter((e) => isPhase(e, "answer") && data(e).intakeOwned !== true && !String(data(e).requestId ?? "").startsWith("intake-")
      && (this.approvalProject === undefined || data(e).approvalProject === this.approvalProject)
      && !entries.some((r) => isRecorded(r, e.seq))).map(result);
  }
}

function sentRecord(entries: readonly LedgerEntry[], request: Request): Data | undefined {
  const sent = entries.find((e) => isPhase(e, "sent") && data(e).requestId === request.requestId);
  return sent && data(sent);
}

/** The send's time in seconds on the clock that stamps taps: ntfy's own time for the publish, standing
 * in for the Mac's record by at most MAX_APPROVAL_CLOCK_SKEW_SECONDS; without one, the Mac's record. */
function sendReference(sent: Data): number {
  const mac = (sent.sentAt as number) / 1000;
  return typeof sent.serverTime === "number" ? Math.max(sent.serverTime, mac - MAX_APPROVAL_CLOCK_SKEW_SECONDS) : mac;
}

/** Both the notification and the exact pending broker request must belong to this project. */
function approvalGuard(entries: readonly LedgerEntry[], request: Request, project: string, time: number | undefined): IgnoredReason | undefined {
  if (request.project !== project) return "wrong-project";
  const broker = entries.find((e) => e.kind === "approval_request" && data(e).approvalId === request.requestId);
  if (!broker) return "unknown-request";
  const pending = data(broker);
  if (pending.project !== project) return "wrong-project";
  if (entries.some((e) => e.kind === "approval" && data(e).approvalId === request.requestId
    && data(e).payloadHash === pending.payloadHash && data(e).op === pending.op
    && (data(e).decision === "approve" || data(e).decision === "reject"))) return "already-answered";
  const sent = sentRecord(entries, request);
  if (!sent || typeof sent.sentAt !== "number") return "not-sent";
  if (!Number.isSafeInteger(time) || time! < 0) return "before-send";
  // ntfy's second-resolution timestamp must prove the tap followed the completed send, on one clock.
  // A same-second tap can't prove it and is refused; a later tap with the same nonce can still count.
  if (time! <= sendReference(sent)) return "before-send";
  return undefined;
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
    if (data(entry).intakeOwned === true || String(data(entry).requestId ?? "").startsWith("intake-")) throw new Error("intake replies require intake routing");
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
        const intent = entries.find((e) => e.seq === answer.seq)!;
        if (data(intent).steerInbox === true) {
          // Stable file identity spans submission, ingestion and a crash before this marker. An
          // already ingested note must not be re-created, even if the runner archived its file.
          const id = `notify-${answer.seq}`;
          const ingested = entries.some((e) => (e.kind === "steer" || e.kind === "reconciled") && data(e).inboxItem === `${id}.json`);
          if (!ingested) queueSteer(ledger.dir, answer.text, id);
        } else add({ kind: "steer", actor: "runner", data: { ...common, note: answer.text } });
      } else if (answer.answer === "defaults") {
        add({ kind: "decision", actor: "runner", data: { ...common, requestId: answer.requestId, acceptedDefaults: true, confirmed: true } });
      }
    }
    const marker = add({ kind: "notify", actor: "runner", data: { ...common, phase: "recorded", ...outcome } });
    return recordingMessage(answer, data(marker));
  });
}

/** Called under the ledger writer lock; only this intent can own its temporary filename. */
function queueSteer(dir: string, note: string, id: string): void {
  const inbox = join(dir, "inbox");
  for (const path of [dir, inbox]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("inbox paths must be real directories");
  }
  rmSync(join(inbox, `.${id}.tmp`), { force: true });
  submitSteer(dir, note, { id: () => id });
}

/** Fixed reasons only: never reflect payloads, request ids, nonces or the incoming body. */
export function refusedReply(message: ReplyMessage, answer: ReplyResult): Message | undefined {
  const parsed = parseReply(message.text);
  if (answer.status !== "ignored" || answer.reason === "duplicate" || answer.reason === "not-approval"
    || parsed.kind !== "button" || parsed.requestId.startsWith("intake-")) return;
  const reasons: Record<IgnoredReason, string> = {
    "before-send": "tap time could not be verified; tap again.",
    "already-answered": "this request already has an answer.",
    "not-sent": "this request has no confirmed notification; check your Mac.",
    "unknown-request": "request not found; check your Mac.",
    "unknown-nonce": "button does not match this request; use its latest notification.",
    "reused-nonce": "this button has already been used.",
    "wrong-project": "request belongs to another project.",
    "wrong-answer": "this button cannot answer an approval request.",
    invalid: "invalid button; use the latest notification.", duplicate: "duplicate reply.", "not-approval": "not an approval reply.",
  };
  return { kind: "confirmation", text: `Not counted: ${reasons[answer.reason]}` };
}
