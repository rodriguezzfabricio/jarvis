import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { requestBroker } from "../../packages/cli/src/broker/client.ts";
import { brokerSocketPath, startBrokerServer } from "../../packages/cli/src/broker/server.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("j-sock-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function broker(project: string) {
  return new Broker({ project, ledger: Ledger.open(join(root, `ledger-${++n}`)), secrets: { get: () => undefined },
    adapters: [{ op: "deploy.preview", execute: async () => ({ outcome: "succeeded", detail: { project } }) }] });
}
const request = { op: "deploy.preview", payload: { ref: "test" } } as const;
describe("broker socket ownership", () => {
  it("assigns different addresses to separate projects and runs", () => {
    const a = brokerSocketPath("A", "run", root);
    expect(brokerSocketPath("B", "run", root)).not.toBe(a);
    expect(brokerSocketPath("A", "other", root)).not.toBe(a);
    expect(brokerSocketPath("A", "run", root)).toBe(a);
    expect(brokerSocketPath("A")).not.toBe(brokerSocketPath("A"));
  });
  it("refuses to replace an active socket and keeps routing to its owner", async () => {
    const path = join(root, "active.sock");
    const a = await startBrokerServer(broker("A"), path);
    let b: Awaited<ReturnType<typeof startBrokerServer>> | undefined;
    try {
      await expect(startBrokerServer(broker("B"), path).then(value => { b = value; })).rejects.toThrow();
      expect((await requestBroker(path, request)).receipt).toMatchObject({ detail: { project: "A" } });
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    } finally { await a.close(); await b?.close(); }
  });
  it("closing a displaced owner preserves its replacement socket", async () => {
    const path = join(root, "replaced.sock");
    const a = await startBrokerServer(broker("A"), path);
    rmSync(path);
    const b = await startBrokerServer(broker("B"), path);
    try {
      await a.close();
      expect(existsSync(path)).toBe(true);
      expect((await requestBroker(path, request)).receipt).toMatchObject({ detail: { project: "B" } });
    } finally { await b.close(); }
  });
  it.each([false, true])("preserves an existing file or symlink (symlink=%s) on failed start", async symlink => {
    const path = join(root, `occupied-${symlink}.sock`);
    const file = join(root, `original-${symlink}`);
    writeFileSync(file, "owned elsewhere");
    if (symlink) symlinkSync(file, path); else writeFileSync(path, "owned elsewhere");
    let server: Awaited<ReturnType<typeof startBrokerServer>> | undefined;
    try {
      await expect(startBrokerServer(broker("B"), path).then(value => { server = value; })).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe("owned elsewhere");
    } finally { await server?.close(); }
  });
  it("removes its own sockets and closes idempotently", async () => {
    const path = join(root, "clean.sock");
    const before = readdirSync(root).filter(f => f.endsWith(".sock"));
    const server = await startBrokerServer(broker("A"), path);
    await server.close();
    await server.close();
    expect(readdirSync(root).filter(f => f.endsWith(".sock"))).toEqual(before);
  });
});

const cli = fileURLToPath(new URL("../../packages/cli/src/cli.ts", import.meta.url));
it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("foreground broker cleans up on %s and explicit socket can restart", async signal => {
  const home = join(root, `home-${signal}`);
  mkdirSync(home);
  const path = join(root, `${signal}.sock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, [cli, "broker", "--project", "p", "--socket", path], {
      env: { HOME: home, PATH: process.env.PATH! }, stdio: ["ignore", "pipe", "pipe"],
    });
    const ended = new Promise(resolve => child.once("close", resolve));
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    try {
      const deadline = Date.now() + 5000;
      while (!output.includes("Broker listening") && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(output).toContain("Broker listening");
      child.kill(signal);
      await ended;
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(root).filter(name => name.startsWith(".b-"))).toEqual([]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }
}, 15000);
it("act requires an explicit run socket instead of falling back to a global broker", () => {
  const result = spawnSync(process.execPath, [cli, "act", "deploy.preview", "--json", '{"ref":"main"}'], {
    env: { HOME: root, PATH: process.env.PATH! }, encoding: "utf8", timeout: 5000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/select.*socket|specify.*socket/i);
});
// Backlog #19: an empty socket setting fails closed with a message naming it, not a path error.
it.each([
  ["JARVIS_BROKER_SOCKET", [], { JARVIS_BROKER_SOCKET: "" }],
  ["--socket", ["--socket", ""], {}],
] as const)("broker refuses an empty %s by name", (_label, extra, env) => {
  const home = join(root, "home-empty");
  mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [cli, "broker", "--project", "p", ...extra], {
    env: { HOME: home, PATH: process.env.PATH!, ...env }, encoding: "utf8", timeout: 5000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("Broker listening");
  expect(result.stderr).toMatch(/socket path is empty/i);
});
it.skipIf(process.platform !== "darwin")("supports a short public basename near the Unix socket path limit", async () => {
  const dir = join(root, "x".repeat(97 - Buffer.byteLength(root) - 1));
  mkdirSync(dir);
  const path = join(dir, "s");
  const server = await startBrokerServer(broker("long"), path);
  try { expect((await requestBroker(path, request)).status).toBe("succeeded"); }
  finally { await server.close(); }
  expect(readdirSync(dir)).toEqual([]);
});
