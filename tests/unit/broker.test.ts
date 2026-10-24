import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Broker, type Adapter, type AdapterResult } from "../../packages/cli/src/broker/broker.ts";
import { requestBroker } from "../../packages/cli/src/broker/client.ts";
import { outboxAdapters } from "../../packages/cli/src/broker/outbox.ts";
import { startBrokerServer } from "../../packages/cli/src/broker/server.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtbk-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function setup(behavior: (payload: unknown) => AdapterResult = () => ({ outcome: "succeeded", detail: { id: "msg-1" } }), before: () => Promise<void> = async () => {}) {
  const dir = join(root, `b${++n}`);
  const ledger = Ledger.open(dir);
  const calls: { op: string; payload: unknown; secret: string | undefined }[] = [];
  const adapter = (op: string): Adapter => ({
    op,
    async execute(payload, secrets) {
      calls.push({ op, payload, secret: secrets.get("SMTP_PASSWORD") });
      await before();
      return behavior(payload);
    },
  });
  const secrets = new Map([["SMTP_PASSWORD", "S3cr3t-broker-only-value"]]);
  const broker = new Broker({ ledger, project: "freehire", adapters: [adapter("email.send"), adapter("deploy.preview"), adapter("deploy.promote")], secrets: { get: (k) => secrets.get(k) } });
  return { dir, ledger, broker, calls };
}
/** Blocks adapters at `wait` until `release`; `reached` resolves when the first one arrives. */
function barrier() {
  let release = () => {};
  let arrived = () => {};
  let armed = false;
  const open = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrived = r));
  return {
    wait: async () => {
      if (!armed) return;
      arrived();
      await open;
    },
    arm: () => (armed = true),
    reached,
    release: () => release(),
  };
}
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number.parseInt(r.stdout, 10);
}
const brokerTs = fileURLToPath(new URL("../../packages/cli/src/broker/broker.ts", import.meta.url));
const ledgerTs = fileURLToPath(new URL("../../packages/cli/src/ledger/ledger.ts", import.meta.url));
const mail = (body = "Hi Jane, …") => ({ to: "jane@example.com", subject: "Hello", body });

describe("broker: the only path to outside actions (decisions 12, 41)", () => {
  it("holds an unapproved send as pending, asks for approval, and does not execute", async () => {
    const { broker, ledger, calls } = setup();
    const r = await broker.handle({ op: "email.send", payload: mail() });
    expect(r.status).toBe("pending");
    expect(calls).toHaveLength(0);
    expect(ledger.entries().some((e) => e.kind === "approval_request")).toBe(true);
  });

  it("executes the exact approved payload once, with a receipt", async () => {
    const { broker, ledger, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    const r = await broker.handle({ op: "email.send", payload: mail() });
    expect(r.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(ledger.entries().filter((e) => e.kind === "broker_receipt").at(-1)?.data).toMatchObject({ status: "succeeded" });
  });

  it("does not let an approval cover a changed payload", async () => {
    const { broker, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail("original") });
    broker.decide(p.approvalId!, "approve", "fabricio");
    expect((await broker.handle({ op: "email.send", payload: mail("changed after approval") })).status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("never sends the same payload twice", async () => {
    const { broker, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    await broker.handle({ op: "email.send", payload: mail() });
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("duplicate");
    expect(calls).toHaveLength(1);
  });

  it("refuses a rejected payload", async () => {
    const { broker, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "reject", "fabricio");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["approve", "reject", "succeeded"],
    ["reject", "approve", "rejected"],
  ] as const)("keeps the first valid answer when %s is followed by %s", async (first, second, expected) => {
    const { broker, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, first, "first-answer");
    if (first === second) broker.decide(p.approvalId!, second, "later-answer");
    else expect(() => broker.decide(p.approvalId!, second, "later-answer")).toThrow(`already answered: ${first}`);
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe(expected);
    expect(calls).toHaveLength(expected === "succeeded" ? 1 : 0);
  });

  it("makes repeated decisions idempotent", async () => {
    const { dir, broker } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    const other = new Broker({ ledger: Ledger.open(dir), project: "freehire", adapters: [], secrets: { get: () => undefined } });
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => broker.decide(p.approvalId!, "approve", "one")),
      Promise.resolve().then(() => other.decide(p.approvalId!, "reject", "two")),
    ]);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(settled.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(Error);
    const answers = Ledger.open(dir).entries().filter((e) => e.kind === "approval");
    expect(answers).toHaveLength(1);
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe(
      (answers[0]!.data as { decision: string }).decision === "approve" ? "succeeded" : "rejected",
    );
  });

  it("accepts a repeated identical decision without adding another ledger entry", async () => {
    const { broker, ledger } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "first");
    expect(() => broker.decide(p.approvalId!, "approve", "again")).not.toThrow();
    expect(ledger.entries().filter((e) => e.kind === "approval")).toHaveLength(1);
  });

  it("writes decisions through transact without using separate ledger reads or appends", async () => {
    const { broker, ledger } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    const entries = vi.spyOn(ledger, "entries").mockImplementation(() => { throw new Error("separate read forbidden"); });
    const append = vi.spyOn(ledger, "append").mockImplementation(() => { throw new Error("separate append forbidden"); });
    try {
      expect(() => broker.decide(p.approvalId!, "approve", "fabricio")).not.toThrow();
      expect(ledger.transact((es) => es.filter((e) => e.kind === "approval"))).toHaveLength(1);
    } finally {
      entries.mockRestore();
      append.mockRestore();
    }
  });

  it("serializes contradictory decisions from two broker processes", async () => {
    const { dir, ledger, broker } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    const start = join(dir, "decisions.start");
    const readyA = join(dir, "decision-a.ready");
    const readyB = join(dir, "decision-b.ready");
    const code = (decision: string, ready: string) => `
import { writeFileSync, existsSync } from "node:fs";
import { Broker } from ${JSON.stringify(brokerTs)};
import { Ledger } from ${JSON.stringify(ledgerTs)};
writeFileSync(${JSON.stringify(ready)}, "ready");
while (!existsSync(${JSON.stringify(start)})) await new Promise((r) => setTimeout(r, 5));
new Broker({ ledger: Ledger.open(${JSON.stringify(dir)}), project: "freehire", adapters: [], secrets: { get: () => undefined } })
  .decide(${JSON.stringify(p.approvalId)}, ${JSON.stringify(decision)}, "child");`;
    const children = [
      spawn(process.execPath, ["--input-type=module", "-e", code("approve", readyA)], { stdio: "ignore" }),
      spawn(process.execPath, ["--input-type=module", "-e", code("reject", readyB)], { stdio: "ignore" }),
    ];
    try {
      const deadline = Date.now() + 5_000;
      while ((!existsSync(readyA) || !existsSync(readyB)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(existsSync(readyA) && existsSync(readyB)).toBe(true);
      writeFileSync(start, "go");
      const codes = await Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.on("close", (_code) => resolve(_code)))));
      expect(codes.filter((code) => code === 0)).toHaveLength(1);
      expect(codes.filter((code) => code !== 0)).toHaveLength(1);
      const answers = ledger.entries().filter((e) => e.kind === "approval");
      expect(answers).toHaveLength(1);
      expect(["approve", "reject"]).toContain((answers[0]!.data as { decision: string }).decision);
    } finally {
      writeFileSync(start, "go");
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }, 10_000);

  it("does not accept an answer linked to a different approval request", async () => {
    const { broker, ledger } = setup();
    const first = await broker.handle({ op: "email.send", payload: mail("first") });
    const second = await broker.handle({ op: "email.send", payload: mail("second") });
    ledger.append({ kind: "approval", actor: "runner", data: { approvalId: first.approvalId, payloadHash: second.payloadHash, op: "email.send", decision: "approve" } });
    expect((await broker.handle({ op: "email.send", payload: mail("second") })).status).toBe("pending");
  });

  it("does not accept a linked answer whose payload hash differs from its request", async () => {
    const { broker, ledger } = setup();
    const request = await broker.handle({ op: "email.send", payload: mail("same request") });
    ledger.append({
      kind: "approval",
      actor: "runner",
      data: { approvalId: request.approvalId, payloadHash: "wrong-payload-hash", op: "email.send", decision: "approve" },
    });
    expect((await broker.handle({ op: "email.send", payload: mail("same request") })).status).toBe("pending");
  });

  it("prints a failed CLI result when rejecting an already-approved request", async () => {
    const home = join(root, `cli-home-${n}`);
    const dir = join(home, ".jarvis", "projects", "p");
    const ledger = Ledger.open(dir);
    const broker = new Broker({ ledger, project: "p", adapters: [], secrets: { get: () => undefined } });
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    const cli = fileURLToPath(new URL("../../packages/cli/src/cli.ts", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "reject", p.approvalId!, "--project", "p"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("already answered: approve");
    expect(result.stdout).not.toContain("Rejected ");
  });

  it.each([
    ["approve", "reject", "succeeded"],
    ["reject", "approve", "rejected"],
  ] as const)("honors the first valid linked answer in older ledgers (%s then %s)", async (first, second, expected) => {
    const { broker, ledger, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    ledger.append({ kind: "approval", actor: "runner", data: { approvalId: p.approvalId, payloadHash: p.payloadHash, op: "email.send", decision: "invalid" } });
    ledger.append({ kind: "approval", actor: "runner", data: { approvalId: p.approvalId, payloadHash: p.payloadHash, op: "email.send", decision: first } });
    ledger.append({ kind: "approval", actor: "runner", data: { approvalId: p.approvalId, payloadHash: p.payloadHash, op: "email.send", decision: second } });
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe(expected);
    expect(calls).toHaveLength(expected === "succeeded" ? 1 : 0);
  });

  it("rejects an invalid runtime decision without appending", async () => {
    const { broker, ledger } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    const before = ledger.entries().length;
    expect(() => broker.decide(p.approvalId!, "maybe" as never, "fabricio")).toThrow(/invalid approval decision/);
    expect(ledger.entries()).toHaveLength(before);
  });

  it("records an ambiguous outcome as unknown and never retries it", async () => {
    const { broker, calls } = setup(() => ({ outcome: "unknown", detail: { reason: "timeout after sending" } }));
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("unknown");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("duplicate");
    expect(calls).toHaveLength(1);
  });

  it("treats an adapter crash during execution as unknown, not as a failure to retry", async () => {
    const { broker, calls } = setup(() => {
      throw new Error("socket closed mid-send");
    });
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("unknown");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("duplicate");
    expect(calls).toHaveLength(1);
  });

  it("allows a retry after a definite failure, with the same approval", async () => {
    let first = true;
    const { broker, calls } = setup(() => {
      if (first) {
        first = false;
        return { outcome: "failed", detail: { reason: "connection refused before sending" } };
      }
      return { outcome: "succeeded", detail: {} };
    });
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("failed");
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("succeeded");
    expect(calls).toHaveLength(2);
  });

  it("writes the executing intent before the adapter acts, and the receipt points at it", async () => {
    const { dir, broker } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    let seenWhileExecuting: number[] = [];
    const watching = new Broker({
      ledger: Ledger.open(dir),
      project: "freehire",
      adapters: [{ op: "email.send", execute: async () => {
        seenWhileExecuting = Ledger.open(dir).entries().filter((e) => e.kind === "broker_request" && (e.data as { phase?: string }).phase === "executing").map((e) => e.seq);
        return { outcome: "succeeded", detail: {} };
      } }],
      secrets: { get: () => undefined },
    });
    const r = await watching.handle({ op: "email.send", payload: mail() });
    expect(seenWhileExecuting).toHaveLength(1);
    expect(r.receipt).toMatchObject({ executionSeq: seenWhileExecuting[0] });
  });

  it("reconciles a request that was executing when the runner died as unknown, and never re-executes it", async () => {
    const { dir, broker, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    // Simulate a crash: an executing intent with no receipt, from a broker process that is gone.
    broker.recordExecuting(p.payloadHash, p.approvalId!, "email.send", deadPid());
    const again = new Broker({ ledger: Ledger.open(dir), project: "freehire", adapters: [{ op: "email.send", execute: async () => ({ outcome: "succeeded", detail: {} }) }], secrets: { get: () => undefined } });
    expect(again.reconcile()).toBe(1);
    expect((await again.handle({ op: "email.send", payload: mail() })).status).toBe("duplicate");
    expect(calls).toHaveLength(0);
  });

  // Codex review 6, high: concurrent identical requests must execute an approved payload once.
  it("executes once when identical requests arrive concurrently on one broker", async () => {
    const gate = barrier();
    const { broker, calls } = setup(() => ({ outcome: "succeeded", detail: {} }), gate.wait);
    const p = await broker.handle({ op: "email.send", payload: mail() });
    expect(p.status).toBe("pending");
    broker.decide(p.approvalId!, "approve", "fabricio");
    gate.arm();
    const both = Promise.all([broker.handle({ op: "email.send", payload: mail() }), broker.handle({ op: "email.send", payload: mail() })]);
    await gate.reached;
    gate.release();
    const statuses = (await both).map((r) => r.status).sort();
    expect(statuses).toEqual(["in_progress", "succeeded"]);
    expect(calls).toHaveLength(1);
    expect((await broker.handle({ op: "email.send", payload: mail() })).status).toBe("duplicate");
  });

  it("executes once across two brokers sharing the ledger, and reconcile leaves a live execution alone", async () => {
    const gate = barrier();
    const { dir, broker, calls } = setup(() => ({ outcome: "succeeded", detail: {} }), gate.wait);
    const p = await broker.handle({ op: "email.send", payload: mail() });
    expect(p.status).toBe("pending");
    broker.decide(p.approvalId!, "approve", "fabricio");
    gate.arm();
    const other = new Broker({ ledger: Ledger.open(dir), project: "freehire", adapters: [{ op: "email.send", execute: async () => (calls.push({ op: "email.send", payload: null, secret: undefined }), { outcome: "succeeded", detail: {} }) }], secrets: { get: () => undefined } });
    const first = broker.handle({ op: "email.send", payload: mail() });
    await gate.reached;
    expect((await other.handle({ op: "email.send", payload: mail() })).status).toBe("in_progress");
    expect(other.reconcile()).toBe(0); // the first broker is alive and executing
    gate.release();
    expect((await first).status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    const receipts = Ledger.open(dir).entries().filter((e) => e.kind === "broker_receipt");
    expect(receipts.map((e) => (e.data as { status: string }).status)).toEqual(["succeeded"]);
  });

  it("executes once when broker processes race on the same approved payload", async () => {
    const { dir, broker } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    expect(p.status).toBe("pending");
    broker.decide(p.approvalId!, "approve", "fabricio");
    const log = join(dir, "sent.log");
    const code = `import { appendFileSync } from "node:fs";
import { Broker } from ${JSON.stringify(brokerTs)};
import { Ledger } from ${JSON.stringify(ledgerTs)};
const b = new Broker({ ledger: Ledger.open(${JSON.stringify(dir)}), project: "freehire", secrets: { get: () => undefined },
  adapters: [{ op: "email.send", execute: async () => { appendFileSync(${JSON.stringify(log)}, process.pid + "\\n"); await new Promise((r) => setTimeout(r, 300)); return { outcome: "succeeded", detail: {} }; } }] });
const r = await b.handle({ op: "email.send", payload: ${JSON.stringify(mail())} });
process.stdout.write(r.status);`;
    const kids = [0, 1, 2, 3].map(() => spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] }));
    const outs = await Promise.all(kids.map((k) => new Promise<string>((r) => { let o = ""; k.stdout.on("data", (d: Buffer) => (o += d)); k.on("close", () => r(o)); })));
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(outs.filter((o) => o === "succeeded")).toHaveLength(1);
    expect(outs.every((o) => ["succeeded", "in_progress", "duplicate"].includes(o))).toBe(true);
  }, 30_000);

  it("executes once when identical requests arrive concurrently over the socket", async () => {
    const gate = barrier();
    const { broker, calls } = setup(() => ({ outcome: "succeeded", detail: {} }), gate.wait);
    const p = await broker.handle({ op: "email.send", payload: mail() });
    expect(p.status).toBe("pending");
    broker.decide(p.approvalId!, "approve", "fabricio");
    gate.arm();
    const sock = join(root, `c${n}.sock`);
    const server = await startBrokerServer(broker, sock);
    try {
      const all = Promise.all([0, 1, 2].map(() => requestBroker(sock, { op: "email.send", payload: mail() })));
      await gate.reached;
      await new Promise((r) => setTimeout(r, 200)); // let the other requests reach the broker
      gate.release();
      const statuses = (await all).map((r) => r.status).sort();
      expect(statuses).toEqual(["in_progress", "in_progress", "succeeded"]);
      expect(calls).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("allows preview deploys without asking, but production only with a grant", async () => {
    const { broker, calls } = setup();
    expect((await broker.handle({ op: "deploy.preview", payload: { ref: "abc123" } })).status).toBe("succeeded");
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: "abc123" } })).status).toBe("pending");
    broker.grant("deploy.promote", { project: "freehire" }, "fabricio at intake");
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: "def456" } })).status).toBe("succeeded");
    expect(calls.map((c) => c.op)).toEqual(["deploy.preview", "deploy.promote"]);
  });

  it("rejects unknown operations and malformed payloads", async () => {
    const { broker } = setup();
    expect((await broker.handle({ op: "shell.exec", payload: { cmd: "curl evil" } } as never)).status).toBe("invalid");
    expect((await broker.handle({ op: "email.send", payload: { to: "not-an-email", subject: "x", body: "y" } })).status).toBe("invalid");
    expect((await broker.handle({ op: "email.send", payload: { ...mail(), bcc: "x@y.z" } as never })).status).toBe("invalid");
  });

  it("keeps credentials out of the ledger", async () => {
    const { dir, broker, calls } = setup();
    const p = await broker.handle({ op: "email.send", payload: mail() });
    broker.decide(p.approvalId!, "approve", "fabricio");
    await broker.handle({ op: "email.send", payload: mail() });
    expect(calls[0]?.secret).toBe("S3cr3t-broker-only-value");
    expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain("S3cr3t-broker-only-value");
  });

  it("fails closed on a tampered ledger", async () => {
    const { dir, broker, calls } = setup();
    await broker.handle({ op: "email.send", payload: mail() });
    const f = join(dir, "ledger.jsonl");
    writeFileSync(f, readFileSync(f, "utf8").replace('"pending"', '"approved"').replace("approval_request", "approval"));
    const r = await broker.handle({ op: "email.send", payload: mail() });
    expect(r.status).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("serves jarvis act over a Unix socket", async () => {
    const { broker } = setup();
    const sock = join(root, `s${n}.sock`);
    const server = await startBrokerServer(broker, sock);
    try {
      const r = await requestBroker(sock, { op: "email.send", payload: mail() });
      expect(r.status).toBe("pending");
      const bad = await requestBroker(sock, { op: "nope", payload: {} } as never);
      expect(bad.status).toBe("invalid");
    } finally {
      await server.close();
    }
  });
});

// Codex stage 0 review 9, medium: two actions in the same millisecond shared one outbox file.
describe("outbox adapter", () => {
  it("keeps every action in its own file, even within one millisecond", async () => {
    const dir = join(root, "outbox-same-ms");
    const [email] = outboxAdapters(dir);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    try {
      const a = await email!.execute({ to: "a@example.com", body: "first" }, { get: () => undefined });
      const b = await email!.execute({ to: "b@example.com", body: "second" }, { get: () => undefined });
      const fa = (a.detail as { outbox: string }).outbox;
      const fb = (b.detail as { outbox: string }).outbox;
      expect(fa).not.toBe(fb);
      expect(readFileSync(fa, "utf8")).toContain("first");
      expect(readFileSync(fb, "utf8")).toContain("second");
    } finally {
      vi.useRealTimers();
    }
  });
});
