import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, LedgerTamperError, type AppendInput, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";

/**
 * The broker (decisions 12, 41; architecture §3.6): the only way Jarvis acts outside the computer.
 * It holds the credentials, checks each request against an approval for that exact payload (or a
 * standing grant), writes an "executing" intent before acting and a receipt after, and never executes
 * a payload twice. An outcome it can't know is "unknown" and waits for a person; it is never retried.
 */

export type Op = "email.send" | "deploy.preview" | "deploy.promote" | "git.push_protected" | "git.create_remote" | "data.delete" | "spend" | "service.add_paid" | "store.submit" | "domain.buy";

const Email = z.object({ to: z.string().email(), subject: z.string().min(1).max(300), body: z.string().min(1).max(100_000) }).strict();
const Ref = z.object({ ref: z.string().min(1).max(200) }).strict();
const Generic = z.object({ description: z.string().min(1).max(2000), amount_usd: z.number().nonnegative().optional(), target: z.string().max(500).optional() }).strict();

/** The operation catalog. Only preview deploys run without a person's approval. */
export const CATALOG: Record<Op, { schema: z.ZodType; autoAllow?: boolean; grantable?: boolean }> = {
  "email.send": { schema: Email },
  "deploy.preview": { schema: Ref, autoAllow: true },
  "deploy.promote": { schema: Ref, grantable: true },
  "git.push_protected": { schema: Generic },
  "git.create_remote": { schema: Generic },
  "data.delete": { schema: Generic },
  spend: { schema: Generic },
  "service.add_paid": { schema: Generic },
  "store.submit": { schema: Generic },
  "domain.buy": { schema: Generic },
};

export interface BrokerRequest {
  op: Op;
  payload: unknown;
}

export type BrokerStatus = "pending" | "in_progress" | "succeeded" | "failed" | "unknown" | "rejected" | "duplicate" | "invalid" | "error";

export interface BrokerResponse {
  status: BrokerStatus;
  payloadHash: string;
  approvalId?: string;
  message: string;
  receipt?: unknown;
}

export interface AdapterResult {
  /** succeeded: done. failed: definitely not done, safe to retry. unknown: may have happened. */
  outcome: "succeeded" | "failed" | "unknown";
  detail: Record<string, unknown>;
}

export interface Adapter {
  op: Op | string;
  execute(payload: unknown, secrets: SecretsBackend): Promise<AdapterResult>;
}

export interface SecretsBackend {
  get(key: string): string | undefined;
}

export interface BrokerOptions {
  ledger: Ledger;
  project: string;
  adapters: Adapter[];
  secrets: SecretsBackend;
  /** Called when a new approval request is created (the notifier, later). */
  onApprovalRequest?: (req: { approvalId: string; op: Op; summary: string }) => void;
}

export function payloadHash(op: string, payload: unknown): string {
  return createHash("sha256").update(canonical({ op, payload })).digest("hex");
}

function summarize(op: Op, payload: unknown): string {
  if (op === "email.send") {
    const p = payload as z.infer<typeof Email>;
    return `Send email to ${p.to}: "${p.subject}" (${p.body.length} chars)`;
  }
  return `${op} ${JSON.stringify(payload).slice(0, 200)}`;
}

type D = Record<string, unknown>;

type Notify = { approvalId: string; op: Op; summary: string };
type Claim = { kind: "answer"; response: BrokerResponse; notify?: Notify } | { kind: "execute"; executionSeq: number; approvalId: string | null };

function executingIntent(hash: string, approvalId: string | null, op: string, pid: number, instance: string) {
  return { phase: "executing", payloadHash: hash, approvalId, op, pid, instance };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Broker {
  private readonly o: BrokerOptions;
  /** Identifies this broker's intents in the ledger. */
  readonly instance = randomUUID();
  constructor(o: BrokerOptions) {
    this.o = o;
  }

  private entries(): LedgerEntry[] {
    return this.o.ledger.entries();
  }

  /** A person's answer to an approval request (from `jarvis approve`/`reject` or ntfy). */
  decide(approvalId: string, decision: "approve" | "reject", by: string): void {
    if (decision !== "approve" && decision !== "reject") throw new Error(`invalid approval decision: ${String(decision)}`);
    this.o.ledger.transact((es, add) => {
      const req = es.find((e) => e.kind === "approval_request" && (e.data as D).approvalId === approvalId);
      if (!req) throw new Error(`no approval request ${approvalId}`);
      const d = req.data as D;
      if (d.project !== undefined && d.project !== this.o.project) throw new Error("approval request belongs to another project");
      const firstAnswer = es.find((e) => {
        if (e.kind !== "approval") return false;
        const answer = e.data as D;
        return answer.approvalId === approvalId && answer.payloadHash === d.payloadHash && answer.op === d.op
          && (answer.decision === "approve" || answer.decision === "reject");
      });
      if (firstAnswer) {
        const firstDecision = (firstAnswer.data as D).decision as "approve" | "reject";
        if (firstDecision !== decision) throw new Error(`already answered: ${firstDecision}`);
      } else {
        add({ kind: "approval", actor: "runner", data: { approvalId, payloadHash: d.payloadHash, op: d.op, decision, by } });
      }
    });
  }

  /** A standing grant, e.g. production deploys for this project, answered at intake. */
  grant(op: Op, scope: { project: string }, by: string): void {
    if (!CATALOG[op].grantable) throw new Error(`${op} can't be granted in advance`);
    this.o.ledger.append({ kind: "grant", actor: "runner", data: { op, scope, by } });
  }

  /** Test seam for crash simulation; production code writes intents only from handle(). */
  recordExecuting(hash: string, approvalId: string | null, op: string, pid = process.pid): LedgerEntry {
    return this.o.ledger.append({ kind: "broker_request", actor: "broker", data: executingIntent(hash, approvalId, op, pid, this.instance) });
  }

  /**
   * On start: requests that were executing when their broker died get an "unknown" receipt. An intent
   * whose broker process is still alive is in flight, not orphaned, and is left alone.
   */
  reconcile(): number {
    return this.o.ledger.transact((es, add) => {
      const done = new Set(es.filter((e) => e.kind === "broker_receipt").map((e) => (e.data as D).executionSeq));
      let n = 0;
      for (const e of es) {
        const d = e.data as D;
        if (e.kind !== "broker_request" || d.phase !== "executing" || done.has(e.seq)) continue;
        if (typeof d.pid === "number" && pidAlive(d.pid)) continue;
        add({ kind: "broker_receipt", actor: "broker", data: { executionSeq: e.seq, payloadHash: d.payloadHash, op: d.op, status: "unknown", detail: { reason: "the broker stopped while this was executing" } } });
        n++;
      }
      return n;
    });
  }

  async handle(req: BrokerRequest): Promise<BrokerResponse> {
    const op = req?.op as Op;
    const spec = Object.hasOwn(CATALOG, op) ? CATALOG[op] : undefined;
    if (!spec) return { status: "invalid", payloadHash: "", message: `unknown operation: ${String(req?.op)}` };
    const parsed = spec.schema.safeParse(req.payload);
    if (!parsed.success) return { status: "invalid", payloadHash: "", message: `invalid payload: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    const payload = parsed.data;
    const hash = payloadHash(op, payload);
    const adapter = this.o.adapters.find((a) => a.op === op);
    try {
      // Check and claim in one step under the ledger's writer lock (Codex stage 0 review 6): two
      // identical requests, from this broker or another, can't both see "approved, not yet done".
      const step = this.o.ledger.transact((es, add) => this.claim(es, add, op, spec, payload, hash, adapter !== undefined));
      if (step.kind === "answer") {
        if (step.notify) this.o.onApprovalRequest?.(step.notify);
        return step.response;
      }
      const { executionSeq, approvalId } = step;
      let result: AdapterResult;
      try {
        result = await adapter!.execute(payload, this.o.secrets);
      } catch (err) {
        result = { outcome: "unknown", detail: { reason: `adapter error during execution: ${String(err).slice(0, 300)}` } };
      }
      const receipt = { executionSeq, payloadHash: hash, op, approvalId, status: result.outcome, detail: result.detail };
      const written = this.o.ledger.transact((es, add) => {
        // One receipt per execution: if something already settled it, that receipt stands.
        const prior = es.find((e) => e.kind === "broker_receipt" && (e.data as D).executionSeq === executionSeq);
        return prior ? (prior.data as typeof receipt) : (add({ kind: "broker_receipt", actor: "broker", data: receipt }), receipt);
      });
      return { status: written.status, payloadHash: hash, ...(approvalId ? { approvalId } : {}), message: written.status, receipt: written };
    } catch (err) {
      if (err instanceof LedgerTamperError) return { status: "error", payloadHash: hash, message: "ledger failed verification: refusing all actions" };
      throw err;
    }
  }

  /** The decision for one request, taken and recorded under the ledger lock. Synchronous by design. */
  private claim(es: readonly LedgerEntry[], add: (i: AppendInput) => LedgerEntry, op: Op, spec: (typeof CATALOG)[Op], payload: unknown, hash: string, hasAdapter: boolean): Claim {
    const answer = (response: BrokerResponse, notify?: Notify): Claim => ({ kind: "answer", response, ...(notify ? { notify } : {}) });
    // Never execute a payload twice: succeeded or unknown stays final.
    const receipts = es.filter((e) => e.kind === "broker_receipt" && (e.data as D).payloadHash === hash);
    const final = receipts.find((e) => ["succeeded", "unknown"].includes((e.data as D).status as string));
    if (final) return answer({ status: "duplicate", payloadHash: hash, message: `already ${(final.data as D).status} (seq ${final.seq})`, receipt: final.data });
    // An execution without a receipt is still running (or awaits reconciliation): never start another.
    const settled = new Set(receipts.map((e) => (e.data as D).executionSeq));
    const running = es.find((e) => e.kind === "broker_request" && (e.data as D).phase === "executing" && (e.data as D).payloadHash === hash && !settled.has(e.seq));
    if (running) return answer({ status: "in_progress", payloadHash: hash, message: `already executing (seq ${running.seq}); it runs once` });

    let approvalId: string | null = null;
    if (!spec.autoAllow) {
      const granted = spec.grantable && es.some((e) => e.kind === "grant" && (e.data as D).op === op && ((e.data as D).scope as D)?.project === this.o.project);
      if (!granted) {
        const open = es.find((e) => e.kind === "approval_request" && (e.data as D).payloadHash === hash && (e.data as D).op === op);
        const openData = open?.data as D | undefined;
        const firstAnswer = open && es.find((e) => {
          if (e.kind !== "approval") return false;
          const d = e.data as D;
          return d.approvalId === openData?.approvalId && d.payloadHash === hash && d.op === op
            && (d.decision === "approve" || d.decision === "reject");
        });
        if (firstAnswer && (firstAnswer.data as D).decision === "reject") {
          return answer({ status: "rejected", payloadHash: hash, approvalId: openData!.approvalId as string, message: "rejected by a person" });
        }
        if (!firstAnswer) {
          if (open) return answer({ status: "pending", payloadHash: hash, approvalId: openData!.approvalId as string, message: "waiting for approval" });
          const id = randomUUID();
          const summary = summarize(op, payload);
          add({ kind: "approval_request", actor: "broker", data: { approvalId: id, project: this.o.project, op, payloadHash: hash, summary, payload } });
          return answer({ status: "pending", payloadHash: hash, approvalId: id, message: "approval requested" }, { approvalId: id, op, summary });
        }
        approvalId = openData!.approvalId as string;
      }
    }
    if (!hasAdapter) return answer({ status: "error", payloadHash: hash, message: `no adapter for ${op}` });
    // Intent first: if the broker dies after this, reconcile() marks it unknown and it is never retried.
    const intent = add({ kind: "broker_request", actor: "broker", data: executingIntent(hash, approvalId, op, process.pid, this.instance) });
    return { kind: "execute", executionSeq: intent.seq, approvalId };
  }
}

/** Read-only projection of verified entries; legacy requests belong to their containing project ledger. */
export function pendingApprovalRequests(entries: readonly LedgerEntry[], project: string): LedgerEntry[] {
  return entries.filter((request) => {
    if (request.kind !== "approval_request") return false;
    const r = request.data as D;
    if (r.project !== undefined && r.project !== project) return false;
    return !entries.some((e) => e.kind === "approval" && (e.data as D).approvalId === r.approvalId
      && (e.data as D).payloadHash === r.payloadHash && (e.data as D).op === r.op
      && ((e.data as D).decision === "approve" || (e.data as D).decision === "reject"));
  });
}
