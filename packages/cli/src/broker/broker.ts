import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, LedgerTamperError, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";

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

export type BrokerStatus = "pending" | "succeeded" | "failed" | "unknown" | "rejected" | "duplicate" | "invalid" | "error";

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

export class Broker {
  private readonly o: BrokerOptions;
  constructor(o: BrokerOptions) {
    this.o = o;
  }

  private entries(): LedgerEntry[] {
    return this.o.ledger.entries();
  }

  /** A person's answer to an approval request (from `jarvis approve`/`reject` or ntfy). */
  decide(approvalId: string, decision: "approve" | "reject", by: string): void {
    const req = this.entries().find((e) => e.kind === "approval_request" && (e.data as D).approvalId === approvalId);
    if (!req) throw new Error(`no approval request ${approvalId}`);
    const d = req.data as D;
    this.o.ledger.append({ kind: "approval", actor: "runner", data: { approvalId, payloadHash: d.payloadHash, op: d.op, decision, by } });
  }

  /** A standing grant, e.g. production deploys for this project, answered at intake. */
  grant(op: Op, scope: { project: string }, by: string): void {
    if (!CATALOG[op].grantable) throw new Error(`${op} can't be granted in advance`);
    this.o.ledger.append({ kind: "grant", actor: "runner", data: { op, scope, by } });
  }

  /** Test seam for crash simulation; production code calls it only from handle(). */
  recordExecuting(hash: string, approvalId: string | null, op: string): LedgerEntry {
    return this.o.ledger.append({ kind: "broker_request", actor: "broker", data: { phase: "executing", payloadHash: hash, approvalId, op } });
  }

  /** On start: requests that were executing when the runner died get an "unknown" receipt. */
  reconcile(): number {
    const es = this.entries();
    const done = new Set(es.filter((e) => e.kind === "broker_receipt").map((e) => (e.data as D).executionSeq));
    let n = 0;
    for (const e of es) {
      const d = e.data as D;
      if (e.kind === "broker_request" && d.phase === "executing" && !done.has(e.seq)) {
        this.o.ledger.append({ kind: "broker_receipt", actor: "broker", data: { executionSeq: e.seq, payloadHash: d.payloadHash, op: d.op, status: "unknown", detail: { reason: "the runner stopped while this was executing" } } });
        n++;
      }
    }
    return n;
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
      const es = this.entries(); // throws on tampering: fail closed
      // Never execute a payload twice: succeeded or unknown stays final.
      const receipts = es.filter((e) => e.kind === "broker_receipt" && (e.data as D).payloadHash === hash);
      const final = receipts.find((e) => ["succeeded", "unknown"].includes((e.data as D).status as string));
      if (final) return { status: "duplicate", payloadHash: hash, message: `already ${(final.data as D).status} (seq ${final.seq})`, receipt: final.data };

      let approvalId: string | null = null;
      if (!spec.autoAllow) {
        const granted = spec.grantable && es.some((e) => e.kind === "grant" && (e.data as D).op === op && ((e.data as D).scope as D)?.project === this.o.project);
        if (!granted) {
          const answers = es.filter((e) => e.kind === "approval" && (e.data as D).payloadHash === hash);
          const last = answers.at(-1);
          if (last && (last.data as D).decision === "reject") return { status: "rejected", payloadHash: hash, approvalId: (last.data as D).approvalId as string, message: "rejected by a person" };
          if (!last) {
            const open = es.find((e) => e.kind === "approval_request" && (e.data as D).payloadHash === hash);
            if (open) return { status: "pending", payloadHash: hash, approvalId: (open.data as D).approvalId as string, message: "waiting for approval" };
            const id = randomUUID();
            const summary = summarize(op, payload);
            this.o.ledger.append({ kind: "approval_request", actor: "broker", data: { approvalId: id, op, payloadHash: hash, summary, payload } });
            this.o.onApprovalRequest?.({ approvalId: id, op, summary });
            return { status: "pending", payloadHash: hash, approvalId: id, message: "approval requested" };
          }
          approvalId = (last.data as D).approvalId as string;
        }
      }
      if (!adapter) return { status: "error", payloadHash: hash, message: `no adapter for ${op}` };

      // Intent first: if we die after this line, reconcile() marks it unknown and it is never retried.
      // Its own entry's seq, not the ledger's last: another writer may append in between.
      const executionSeq = this.recordExecuting(hash, approvalId, op).seq;
      let result: AdapterResult;
      try {
        result = await adapter.execute(payload, this.o.secrets);
      } catch (err) {
        result = { outcome: "unknown", detail: { reason: `adapter error during execution: ${String(err).slice(0, 300)}` } };
      }
      const receipt = { executionSeq, payloadHash: hash, op, approvalId, status: result.outcome, detail: result.detail };
      this.o.ledger.append({ kind: "broker_receipt", actor: "broker", data: receipt });
      return { status: result.outcome, payloadHash: hash, ...(approvalId ? { approvalId } : {}), message: result.outcome, receipt };
    } catch (err) {
      if (err instanceof LedgerTamperError) return { status: "error", payloadHash: hash, message: "ledger failed verification: refusing all actions" };
      throw err;
    }
  }
}
