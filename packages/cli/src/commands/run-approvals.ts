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

function unanswered(entries: readonly LedgerEntry[], request: LedgerEntry): boolean {
  const r = data(request);
  return !entries.some((e) => e.kind === "approval" && data(e).approvalId === r.approvalId
    && data(e).payloadHash === r.payloadHash && data(e).op === r.op
    && (data(e).decision === "approve" || data(e).decision === "reject"));
}

/** Runner-owned polling, never an endpoint on the task-accessible broker socket. Hard stops have no
 * timeout default. Only the broker records approval for the exact payload, and a tap never executes it.
 * Legacy requests lacking an explicit project remain terminal-only. Phone messages omit raw payloads. */
export function runApprovals(o: RunApprovalOptions): RunApprovals {
  const warn = o.warn ?? console.error;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const pollMs = o.pollMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("invalid approval polling interval or timeout");
  const cursor = o.ledger.entries().filter((e) => phase(e, "approval-cursor") && data(e).project === o.project).at(-1);
  const config = loadRunNotifier({ ...o, since: cursor ? String(data(cursor).id) : "all" });
  if (config.status === "ok") assertApprovalIsolation(config.baseUrl, o.taskAllowlists);
  else warn("Phone approvals are off for this run: approvals stay terminal-only (jarvis approve / jarvis reject).");
  const inbox = new ReplyInbox(o.ledger, { approvalProject: o.project });
  const stop = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let disabled = false;

  function failure(what: string, error: unknown): void {
    const reason = notificationError(error, config.status === "ok" ? config.secrets : []);
    warn(`Phone approval ${what} failed: ${reason}. Pending requests can be answered with jarvis approve / jarvis reject.`);
    o.ledger.append({ kind: "notify", actor: "runner", data: { source: "notify", phase: "approval-error", project: o.project, operation: what } });
  }

  async function transport<T>(what: string, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (closed || disabled || config.status !== "ok") return { ok: false };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<{ ok: false }>((resolve, reject) => {
      cancel = () => resolve({ ok: false });
      stop.signal.addEventListener("abort", cancel, { once: true });
      deadline = setTimeout(() => {
        // A stuck adapter is disabled for this run: never accumulate orphaned sends or polls.
        disabled = true;
        reject(new Error("timed out; phone polling disabled for this run"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(work).then((value) => ({ ok: true as const, value })), stopped]);
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
      const text = `Jarvis ${o.project}: approval needed for ${String(r.op)} (request ${id}). Exact payload details stay in the runner ledger on your Mac.`;
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
    const replies = await transport("poll", () => config.notifier.poll());
    if (!replies.ok || closed) return;
    for (const message of replies.value) {
      const answer = inbox.accept(message);
      const confirmation = recordAnswer(o.ledger, answer, o.broker);
      if (confirmation) await send(confirmation);
      if (closed) return;
      // Checkpoint only processed replies. A ledger failure disables polling; restart replays from here.
      o.ledger.append({ kind: "notify", actor: "runner", data: { source: "notify", phase: "approval-cursor", project: o.project, id: message.id } });
    }
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
