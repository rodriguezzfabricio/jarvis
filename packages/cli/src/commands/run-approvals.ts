import type { Broker } from "../broker/broker.ts";
import { assertTaskDomains } from "../eval/allowlist.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { actionsFor, limitText, type Action, type Message } from "../notify/notifier.ts";
import { ReplyInbox, recordAnswer } from "../notify/replies.ts";
import { loadRunNotifier, notificationError, type RunNotificationOptions } from "./run-notify.ts";

export interface RunApprovalOptions extends RunNotificationOptions {
  ledger: Ledger;
  broker: Pick<Broker, "decide">;
  /** Every effective task/reviewer network allowlist, from the same values given to the harnesses. */
  taskAllowlists: readonly (readonly string[])[];
  now?: () => number;
  pollMs?: number;
}
export interface RunApprovals {
  /** Begin background polling; call only once the run has hosted its broker. */
  start(): void;
  /** One serialized scan/send/poll cycle; also useful with an injected scheduler. */
  tick(): Promise<void>;
  /** Stop the broker first, then finish polling and flush its final requests within timeoutMs. Idempotent. */
  close(): Promise<void>;
}

type Data = Record<string, unknown>;
const data = (entry: LedgerEntry): Data => entry.data as Data;
const phase = (entry: LedgerEntry, name: string) => entry.kind === "notify" && data(entry).source === "notify" && data(entry).phase === name;

/** Fail closed before any session starts. Exact-host policies reject wildcards already; a matching
 * host on any port, or a parent domain, also makes the phone reply path unsafe for task sessions. */
export function assertApprovalIsolation(baseUrl: string, taskAllowlists: readonly (readonly string[])[]): void {
  if (!Array.isArray(taskAllowlists) || taskAllowlists.length === 0) throw new Error("task allowlists are required for phone approvals");
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  for (const domains of taskAllowlists) {
    assertTaskDomains(domains);
    for (const domain of domains) {
      const allowed = new URL(`https://${domain}`).hostname.toLowerCase();
      if (host === allowed || host.endsWith(`.${allowed}`)) throw new Error("task allowlist exposes the notification host; refusing phone approvals and the run");
    }
  }
}

/** A notifier on this Mac's loopback. A protected check that may bind local ports reaches every loopback
 * port (sandbox/srt.ts), and a phone can't reach it, so phone approvals never use one. URL has already
 * canonicalized integer, hex and IPv4-mapped spellings. */
export function onLoopback(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "0.0.0.0"
    || host === "[::1]" || host === "[::]" || host.startsWith("[::ffff:7f") || host.startsWith("[::ffff:127.");
}

function unanswered(entries: readonly LedgerEntry[], request: LedgerEntry): boolean {
  const r = data(request);
  return !entries.some((e) => e.kind === "approval" && data(e).approvalId === r.approvalId
    && data(e).payloadHash === r.payloadHash && data(e).op === r.op
    && (data(e).decision === "approve" || data(e).decision === "reject"));
}

/** The broker's summary as one line a phone can show (decision 117). Its text is session-written (an
 * email subject, a description), so control, format and line-separator characters go: no extra lines,
 * no bidi tricks. At most 300 characters, never splitting one. The full payload stays in the ledger. */
export function oneLineSummary(summary: unknown): string {
  const flat = String(summary ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > 300 ? `${chars.slice(0, 299).join("")}…` : flat;
}

/** Runner-owned polling, never an endpoint on the task-accessible broker socket. Hard stops have no
 * timeout default. Only the broker records approval for the exact payload, and a tap never executes it.
 * Legacy requests lacking an explicit project remain terminal-only. Phone messages carry the broker's
 * one-line summary and a payload hash prefix, never the raw payload (decision 117). */
export function runApprovals(o: RunApprovalOptions): RunApprovals {
  const warn = o.warn ?? console.error;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const pollMs = o.pollMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("invalid approval polling interval or timeout");
  const loaded = loadRunNotifier(o);
  if (loaded.status === "ok") assertApprovalIsolation(loaded.baseUrl, o.taskAllowlists);
  const config = loaded.status === "ok" && onLoopback(loaded.baseUrl) ? { status: "loopback" as const } : loaded;
  const off = "approvals stay terminal-only (jarvis approve / jarvis reject).";
  if (config.status === "loopback") warn(`Phone approvals are off for this run: the notifier in ${o.configPath} is on this Mac's loopback, which sandboxed checks can reach and a phone can't; ${off}`);
  else if (config.status !== "ok") warn(`Phone approvals are off for this run: no valid notifier configuration at ${o.configPath}; ${off}`);
  const inbox = new ReplyInbox(o.ledger, { approvalProject: o.project });
  const stop = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  /** A ledger failure: phone approvals stop for the run. */
  let disabled = false;
  /** A timed-out call hasn't settled yet: nothing new is stacked on the adapter until it does. */
  let stuck = false;
  /** Failed since the last success: one warning and one ledger entry per outage, not one per poll. */
  let failing = false;

  /** The last reply this project processed. Polls start here, never at an adapter's own cursor, which a
   * timed-out poll that answered late would have moved past replies nobody processed. */
  function cursor(): string {
    const last = o.ledger.entries().filter((e) => phase(e, "approval-cursor") && data(e).project === o.project).at(-1);
    return last ? String(data(last).id) : "all";
  }

  function failure(what: string, error: unknown): void {
    if (failing) return;
    failing = true;
    const reason = notificationError(error, config.status === "ok" ? config.secrets : []);
    warn(`Phone approval ${what} failed: ${reason}. Pending requests can be answered with jarvis approve / jarvis reject.`);
    o.ledger.append({ kind: "notify", actor: "runner", data: { source: "notify", phase: "approval-error", project: o.project, operation: what } });
  }

  async function transport<T>(what: string, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (closed || disabled || stuck || config.status !== "ok") return { ok: false };
    const call = Promise.resolve().then(work);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<{ ok: false }>((resolve, reject) => {
      cancel = () => resolve({ ok: false });
      stop.signal.addEventListener("abort", cancel, { once: true });
      deadline = setTimeout(() => {
        // Pause, never stack calls on a stuck adapter; resume once it answers. A late answer is discarded.
        stuck = true;
        void call.then(() => {}, () => {}).finally(() => { stuck = false; });
        reject(new Error("timed out; phone approvals pause until the notifier answers"));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([call.then((value) => ({ ok: true as const, value })), stopped]);
      if (result.ok && failing) { failing = false; warn("Phone approvals are reachable again."); }
      return result;
    } catch (error) {
      failure(what, error);
      return { ok: false };
    } finally {
      clearTimeout(deadline);
      stop.signal.removeEventListener("abort", cancel);
    }
  }

  async function send(message: Message, actions: readonly Action[] = []): Promise<boolean> {
    if (config.status !== "ok") return false;
    return (await transport("send", () => config.notifier.send({ ...message, text: limitText(message.text) }, actions))).ok;
  }

  async function requests(): Promise<void> {
    const entries = o.ledger.entries();
    for (const request of entries.filter((e) => e.kind === "approval_request" && data(e).project === o.project && unanswered(entries, e))) {
      if (closed || disabled) return;
      const r = data(request);
      const id = String(r.approvalId);
      const registered = entries.find((e) => phase(e, "request") && data(e).requestId === id);
      if (registered && data(registered).project !== o.project) continue;
      if (entries.some((e) => phase(e, "sent") && data(e).requestId === id)) continue;
      const nonce = registered ? String(data(registered).nonce) : inbox.register(id, "approval", o.project).nonce;
      const text = `Jarvis ${o.project}: approve ${String(r.op)}? ${oneLineSummary(r.summary)} (request ${id}, payload ${String(r.payloadHash).slice(0, 12)}). The full payload is in the runner ledger on your Mac.`;
      if (await send({ kind: "approval", text }, actionsFor("approval", id, nonce)) && !closed) inbox.sent(id, now());
    }
  }

  async function cycle(): Promise<void> {
    if (closed || disabled || config.status !== "ok") return;
    for (const answer of inbox.pending()) {
      const confirmation = recordAnswer(o.ledger, answer, o.broker);
      if (confirmation) await send(confirmation);
      if (closed || disabled) return;
    }
    await requests();
    const since = cursor();
    const replies = await transport("poll", () => config.at(since).poll());
    if (!replies.ok || closed) return;
    let last: string | undefined;
    for (const message of replies.value) {
      const answer = inbox.accept(message);
      const confirmation = recordAnswer(o.ledger, answer, o.broker);
      last = message.id;
      if (confirmation) await send(confirmation);
      if (closed) break;
    }
    // One checkpoint per processed batch. A crash before it replays the batch, whose replies are then
    // duplicates; a ledger failure stops phone approvals for the run.
    if (last !== undefined) o.ledger.append({ kind: "notify", actor: "runner", data: { source: "notify", phase: "approval-cursor", project: o.project, id: last } });
  }

  function tick(): Promise<void> {
    if (closed || disabled) return Promise.resolve();
    return active ??= cycle().catch((error: unknown) => {
      disabled = true;
      throw error; // Ledger failures are not transport failures and must never be treated as answers.
    }).finally(() => { active = undefined; });
  }
  function background(): void {
    void tick().catch(() => { warn("Phone approval ledger processing failed; polling stopped. Check the runner ledger on your Mac."); });
  }
  return {
    tick,
    start() {
      if (timer || closed || config.status !== "ok") return;
      background();
      timer = setInterval(background, pollMs);
      timer.unref();
    },
    close() {
      return closing ??= (async () => {
        clearInterval(timer);
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<false>((resolve) => { deadlineTimer = setTimeout(() => resolve(false), timeoutMs); });
        const draining = (async () => { await active; await tick(); return true; })();
        try {
          if (!await Promise.race([draining, deadline])) failure("shutdown", new Error("timed out; remaining approvals stay terminal-only"));
        } finally {
          closed = true; stop.abort(); clearTimeout(deadlineTimer);
          await active;
        }
      })();
    },
  };
}
