/** Runner-only notifications (decisions 10, 50). Callers supply short human summaries, never
 * code, credentials, payloads or reports. Truncation is a size limit, not a secret scrubber. */
export type Answer = "defaults" | "approve" | "reject";
export type Message = { kind: "question" | "approval" | "blocked" | "finished" | "confirmation"; text: string }
  | { kind: "usage-wait"; text: string; waitMs: number };
export interface Action {
  answer: Answer;
  requestId: string;
  nonce: string;
  label: string;
}
export interface ReplyMessage { id: string; text: string; time?: number }
/** What a publish reported: the server's own time for the message, in Unix seconds, when it gave one. */
export interface SendReceipt { time?: number }
export interface Notifier {
  send(message: Message, actions: readonly Action[]): Promise<SendReceipt | void>;
  poll(): Promise<ReplyMessage[]>;
}

const LABELS: Record<Answer, string> = { defaults: "Use defaults", approve: "Approve", reject: "Reject" };
export function actionsFor(kind: Message["kind"], requestId: string, nonce: string): Action[] {
  const answers: Answer[] = kind === "question" ? ["defaults"] : kind === "approval" ? ["approve", "reject"] : [];
  return answers.map((answer) => ({ answer, requestId, nonce, label: LABELS[answer] }));
}
export function confirmation(answer: Answer, requestId: string): Message {
  return { kind: "confirmation", text: `Got it: ${LABELS[answer]} (request ${requestId})` };
}
export function shouldSend(message: Message): boolean {
  return message.kind !== "usage-wait" || message.waitMs > 7_200_000;
}
export function limitText(text: string): string {
  if (Buffer.byteLength(text) < 4096) return text;
  const suffix = "\n… See REPORT.md on your Mac.";
  const budget = 4095 - Buffer.byteLength(suffix);
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return result + suffix;
}
