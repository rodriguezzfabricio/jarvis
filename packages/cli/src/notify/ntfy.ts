import { z } from "zod";
import { limitText, shouldSend, type Action, type Message, type Notifier, type ReplyMessage } from "./notifier.ts";

export interface NtfyOptions {
  baseUrl: string;
  topic: string;
  replyTopic: string;
  /** Persist lastId in runner state after processing a batch; omitted means construction time in Unix seconds. */
  since?: string;
  timeoutMs?: number;
}
/** ntfy message ids are short alphanumeric strings; anything else never reaches the ledger or a log line. */
const Event = z.object({ event: z.literal("message"), id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), message: z.string(), time: z.number().int().nonnegative().optional() });
/** The most a poll reads. ntfy messages are under 4 KB; a body this large is a broken or hostile server. */
export const MAX_POLL_BYTES = 4 * 1024 * 1024;

/** Reads at most `max` bytes, then cancels the body. The error names the cap, never any content. */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`ntfy poll response exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
const Button = z.object({
  answer: z.enum(["defaults", "approve", "reject"]),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  label: z.string().min(1).max(80),
});

/** ntfy JSON publishing avoids header escaping for action labels and bodies. Topic names are
 * bearer capabilities: keep this configuration outside every task workspace (decision 12). */
export class NtfyNotifier implements Notifier {
  private readonly base: URL;
  private readonly topic: string;
  private readonly replyTopic: string;
  private readonly timeoutMs: number;
  private cursor: string;
  constructor(options: NtfyOptions) {
    const base = new URL(options.baseUrl);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("invalid ntfy base URL");
    const loopback = base.hostname === "localhost" || base.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(base.hostname);
    if (base.protocol === "http:" && !loopback) throw new Error("ntfy requires https outside loopback");
    for (const topic of [options.topic, options.replyTopic]) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(topic)) throw new Error("invalid ntfy topic");
    }
    if (options.topic === options.replyTopic) throw new Error("ntfy topics must differ");
    this.base = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
    this.topic = options.topic;
    this.replyTopic = options.replyTopic;
    this.cursor = options.since ?? String(Math.floor(Date.now() / 1000));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("invalid ntfy timeout");
  }
  get lastId(): string { return this.cursor; }

  async send(message: Message, actions: readonly Action[]): Promise<void> {
    if (actions.length > 3) throw new Error("ntfy permits at most 3 actions");
    const buttons = actions.map((action) => {
      const a = Button.parse(action);
      return { action: "http", label: a.label, url: new URL(this.replyTopic, this.base).href, method: "POST", body: `${a.answer}:${a.requestId}:${a.nonce}` };
    });
    if (!shouldSend(message)) return;
    const response = await fetch(this.base, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: this.topic, message: limitText(message.text), actions: buttons }),
    });
    // Never include the URL (topic capability) or response body in errors.
    await response.body?.cancel();
    if (!response.ok) throw new Error(`ntfy publish HTTP ${response.status}`);
  }

  async poll(): Promise<ReplyMessage[]> {
    const url = new URL(`${this.replyTopic}/json`, this.base);
    url.searchParams.set("poll", "1");
    url.searchParams.set("since", this.cursor);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ntfy poll HTTP ${response.status}`);
    }
    // Fixed errors only: JSON.parse and zod quote what they reject, and ntfy events carry the reply topic.
    const events = (await readCapped(response, MAX_POLL_BYTES)).split("\n").filter((line) => line.trim()).map((line): unknown => {
      try { return JSON.parse(line); } catch { throw new Error("ntfy poll returned malformed JSON"); }
    });
    const replies: ReplyMessage[] = [];
    for (const event of events) {
      if (typeof event === "object" && event !== null && "event" in event && event.event === "message") {
        const parsed = Event.safeParse(event);
        if (!parsed.success) throw new Error("ntfy poll returned a malformed message event");
        const message = parsed.data;
        replies.push({ id: message.id, text: message.message, ...(message.time !== undefined ? { time: message.time } : {}) });
      }
    }
    const last = replies.at(-1);
    if (last) this.cursor = last.id;
    return replies;
  }
}
