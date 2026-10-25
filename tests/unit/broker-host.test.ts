import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { payloadHash } from "../../packages/cli/src/broker/broker.ts";
import { requestBroker } from "../../packages/cli/src/broker/client.ts";
import { hostBroker, projectBroker, type SignalHost } from "../../packages/cli/src/broker/host.ts";
import { brokerSocketIn } from "../../packages/cli/src/broker/server.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

// `jarvis run` hosts the project's broker for the run's duration (architecture §3.4, §3.6): the same
// adapters and secrets file as `jarvis broker`, on a per-run socket, torn down when the run ends, throws,
// exits or gets a signal, so no task session can reach a broker that outlived its run.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const EMAIL = { to: "jane@example.com", subject: "Hi", body: "Hello" };

class FakeHost extends EventEmitter implements SignalHost {
  readonly pid = 4242;
  readonly killed: [number, NodeJS.Signals][] = [];
  kill(pid: number, signal: NodeJS.Signals) { this.killed.push([pid, signal]); return true; }
}
function setup() {
  const root = shortTmp("j-host-"); roots.push(root);
  const jarvisHome = join(root, "jarvis");
  const projectDir = join(jarvisHome, "projects", "p");
  const runDir = join(jarvisHome, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(projectDir);
  return { root, jarvisHome, projectDir, runDir, ledger, broker: () => projectBroker({ jarvisHome, projectDir, project: "p", ledger }) };
}
const socketsIn = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".sock"));
const hostEvents = (host: FakeHost) => ["exit", "SIGINT", "SIGTERM", "SIGHUP"].map((e) => host.listenerCount(e));

describe("the broker a run hosts", () => {
  it("answers on its bound address, writes the request to the project's ledger, and close removes both names", async () => {
    const s = setup(); const host = new FakeHost();
    const hosted = await hostBroker(s.broker(), brokerSocketIn(s.runDir, "p"), host);
    expect(hosted.socketPath).not.toBe(hosted.alias);
    expect(socketsIn(s.runDir).sort()).toEqual([hosted.alias, hosted.socketPath].map((p) => p.slice(s.runDir.length + 1)).sort());
    expect(lstatSync(hosted.socketPath).mode & 0o777).toBe(0o600);
    const res = await requestBroker(hosted.socketPath, { op: "email.send", payload: EMAIL });
    expect(res.status).toBe("pending");
    expect(s.ledger.entries().filter((e) => e.kind === "approval_request").map((e) => (e.data as { payloadHash: string }).payloadHash)).toEqual([payloadHash("email.send", EMAIL)]);
    expect(hostEvents(host)).toEqual([1, 1, 1, 1]);
    await hosted.close();
    expect(socketsIn(s.runDir)).toEqual([]);
    expect(hostEvents(host)).toEqual([0, 0, 0, 0]);
    await hosted.close(); // idempotent
  });

  it("executes an approved request once, through the project's configured outbox adapter", async () => {
    const s = setup();
    const hosted = await hostBroker(s.broker(), brokerSocketIn(s.runDir, "p"), new FakeHost());
    try {
      const first = await requestBroker(hosted.socketPath, { op: "email.send", payload: EMAIL });
      s.broker().decide(first.approvalId!, "approve", "test");
      expect((await requestBroker(hosted.socketPath, { op: "email.send", payload: EMAIL })).status).toBe("succeeded");
      expect((await requestBroker(hosted.socketPath, { op: "email.send", payload: EMAIL })).status).toBe("duplicate");
      expect(readdirSync(join(s.projectDir, "outbox"))).toHaveLength(1);
    } finally { await hosted.close(); }
  });

  it("uses the project's owner-only secrets file and refuses one anyone else can read", () => {
    const s = setup();
    const secrets = join(s.jarvisHome, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(join(secrets, "p.env"), "VERCEL_PREVIEW_TOKEN=fake-not-a-token\n", { mode: 0o644 });
    chmodSync(join(secrets, "p.env"), 0o644);
    expect(() => s.broker()).toThrow(/chmod 600/);
    chmodSync(join(secrets, "p.env"), 0o600);
    expect(() => s.broker()).not.toThrow();
  });

  it("marks an execution its dead broker left behind as unknown before it listens (decision 41)", async () => {
    const s = setup();
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.once("exit", r));
    s.broker().recordExecuting(payloadHash("email.send", EMAIL), null, "email.send", dead.pid!);
    const hosted = await hostBroker(s.broker(), brokerSocketIn(s.runDir, "p"), new FakeHost());
    try {
      expect(hosted.reconciled).toBe(1);
      expect(s.ledger.entries().filter((e) => e.kind === "broker_receipt").map((e) => (e.data as { status: string }).status)).toEqual(["unknown"]);
    } finally { await hosted.close(); }
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`${signal} removes the sockets, then re-raises the signal so the runner still stops`, async () => {
      const s = setup(); const host = new FakeHost();
      const hosted = await hostBroker(s.broker(), brokerSocketIn(s.runDir, "p"), host);
      host.emit(signal, signal);
      expect(socketsIn(s.runDir)).toEqual([]);
      expect(host.killed).toEqual([[4242, signal]]);
      expect(hostEvents(host)).toEqual([0, 0, 0, 0]);
      expect(existsSync(hosted.socketPath)).toBe(false);
    });
  }

  it("exit removes the sockets synchronously", async () => {
    const s = setup(); const host = new FakeHost();
    await hostBroker(s.broker(), brokerSocketIn(s.runDir, "p"), host);
    host.emit("exit", 0);
    expect(socketsIn(s.runDir)).toEqual([]);
    expect(host.killed).toEqual([]);
  });
});

// Fault injection with real processes: a runner hosting the broker is signalled, exits without closing,
// or crashes. Its socket names must be gone afterwards, and a signal must still end it.
describe("a hosting process that is signalled, exits or crashes", { timeout: 30_000 }, () => {
  const hostModule = pathToFileURL(join(import.meta.dirname, "../../packages/cli/src/broker/host.ts")).href;
  const serverModule = pathToFileURL(join(import.meta.dirname, "../../packages/cli/src/broker/server.ts")).href;
  const ledgerModule = pathToFileURL(join(import.meta.dirname, "../../packages/cli/src/ledger/ledger.ts")).href;
  function child(s: ReturnType<typeof setup>, then: "wait" | "exit" | "throw") {
    const script = join(s.root, "host-child.mjs");
    writeFileSync(script, [
      `import { hostBroker, projectBroker } from ${JSON.stringify(hostModule)};`,
      `import { brokerSocketIn } from ${JSON.stringify(serverModule)};`,
      `import { Ledger } from ${JSON.stringify(ledgerModule)};`,
      `const ledger = Ledger.open(${JSON.stringify(s.projectDir)});`,
      `const hosted = await hostBroker(projectBroker({ jarvisHome: ${JSON.stringify(s.jarvisHome)}, projectDir: ${JSON.stringify(s.projectDir)}, project: "p", ledger }), brokerSocketIn(${JSON.stringify(s.runDir)}, "p"));`,
      `process.stdout.write("READY\\n");`,
      then === "exit" ? "setTimeout(() => process.exit(0), 50);" : then === "throw" ? `setTimeout(() => { throw new Error("runner crashed"); }, 50);` : "setInterval(() => {}, 1000);",
    ].join("\n"));
    const proc = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    const ready = new Promise<void>((resolve, reject) => {
      let out = "";
      proc.stdout.on("data", (d: Buffer) => { out += String(d); if (out.includes("READY")) resolve(); });
      proc.once("exit", () => reject(new Error(`child exited before READY: ${out}`)));
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
    return { proc, ready, exited };
  }
  const within = <T,>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))]);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`${signal}: the sockets are gone and the process ends by that signal`, async () => {
      const s = setup(); const c = child(s, "wait");
      try {
        await within(c.ready, 15_000, "READY");
        expect(socketsIn(s.runDir)).toHaveLength(2);
        c.proc.kill(signal);
        expect(await within(c.exited, 10_000, "exit")).toEqual({ code: null, signal });
        expect(socketsIn(s.runDir)).toEqual([]);
      } finally { c.proc.kill("SIGKILL"); }
    });
  }

  for (const then of ["exit", "throw"] as const) {
    it(`${then === "exit" ? "process.exit without close" : "an uncaught exception"}: the sockets are gone`, async () => {
      const s = setup(); const c = child(s, then);
      try {
        await within(c.ready, 15_000, "READY");
        const { code } = await within(c.exited, 10_000, "exit");
        expect(code).toBe(then === "exit" ? 0 : 1);
        expect(socketsIn(s.runDir)).toEqual([]);
      } finally { c.proc.kill("SIGKILL"); }
    });
  }

  it("a SIGKILLed runner leaves its names behind, and the next run still gets a broker of its own", async () => {
    const s = setup(); const c = child(s, "wait");
    await within(c.ready, 15_000, "READY");
    c.proc.kill("SIGKILL");
    await within(c.exited, 10_000, "exit");
    const left = socketsIn(s.runDir);
    expect(left).toHaveLength(2);
    const hosted = await hostBroker(s.broker(), brokerSocketIn(s.runDir, "p"), new FakeHost());
    try {
      expect((await requestBroker(hosted.socketPath, { op: "email.send", payload: EMAIL })).status).toBe("pending");
    } finally { await hosted.close(); }
    expect(socketsIn(s.runDir).sort()).toEqual(left.sort());
  });
});
