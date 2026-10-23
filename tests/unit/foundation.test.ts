import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { startBrokerServer } from "../../packages/cli/src/broker/server.ts";
import { foundationChecks } from "../../packages/cli/src/doctor/foundation.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtd-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pluginDir = fileURLToPath(new URL("../../plugin", import.meta.url));
const level = (cs: { name: string; level: string }[], n: string) => cs.find((c) => c.name === n)?.level;

describe("doctor foundation checks (stage 1)", () => {
  it("passes on an intact foundation, with a live broker and a working checks sandbox", async () => {
    const jh = join(root, "jh1");
    const l = Ledger.open(join(jh, "projects", "p"));
    l.append({ kind: "steer", actor: "runner", data: {} });
    mkdirSync(join(jh, "secrets"), { recursive: true });
    writeFileSync(join(jh, "secrets", "p.env"), "X=1\n", { mode: 0o600 });
    const sock = join(jh, "b.sock");
    const server = await startBrokerServer(new Broker({ ledger: l, project: "p", adapters: [], secrets: { get: () => undefined } }), sock);
    try {
      const cs = await foundationChecks({ jarvisHome: jh, pluginDir, socketPath: sock });
      expect(cs.filter((c) => c.level === "fail")).toEqual([]);
      expect(level(cs, "broker")).toBe("pass");
      expect(level(cs, "plugin")).toBe("pass");
      if (process.platform === "darwin") expect(level(cs, "checks_sandbox")).toBe("pass");
    } finally {
      await server.close();
    }
  });

  it("fails on a tampered ledger and an over-readable secrets file", async () => {
    const jh = join(root, "jh2");
    const dir = join(jh, "projects", "p");
    Ledger.open(dir).append({ kind: "steer", actor: "runner", data: { a: 1 } });
    writeFileSync(join(dir, "ledger.jsonl"), '{"seq":1}\n');
    mkdirSync(join(jh, "secrets"), { recursive: true });
    writeFileSync(join(jh, "secrets", "p.env"), "X=1\n", { mode: 0o644 });
    const cs = await foundationChecks({ jarvisHome: jh, pluginDir, socketPath: join(jh, "none.sock") });
    expect(level(cs, "ledger.p")).toBe("fail");
    expect(level(cs, "secrets.p.env")).toBe("fail");
    expect(level(cs, "broker")).toBe("warn");
  });
});
