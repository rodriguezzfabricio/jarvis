import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger, verifyLedger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

// Fault injection (architecture §10): writers killed mid-append, and concurrent writers.
const root = shortTmp("jtf-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ledgerTs = fileURLToPath(new URL("../../packages/cli/src/ledger/ledger.ts", import.meta.url));

function writer(dir: string, count: number, tag: string) {
  const code = `import { Ledger } from ${JSON.stringify(ledgerTs)};
const l = Ledger.open(${JSON.stringify(dir)});
for (let i = 0; i < ${count}; i++) { const e = l.append({ kind: "steer", actor: "runner", data: { tag: ${JSON.stringify(tag)}, i } }); process.stdout.write("ack " + e.hash + "\\n"); }`;
  return spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
}

describe("ledger under faults", () => {
  it("keeps every acknowledged entry and a valid chain when the writer is SIGKILLed mid-run", async () => {
    const dir = join(root, "kill");
    const acked = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const child = writer(dir, 100_000, `r${round}`);
      child.stdout.on("data", (d: Buffer) => {
        for (const m of d.toString().matchAll(/ack ([0-9a-f]{64})/g)) acked.add(m[1]!);
      });
      await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 200)));
      child.kill("SIGKILL");
      await new Promise((r) => child.on("close", r));
      const v = verifyLedger(dir);
      expect(v.problems).toEqual([]);
    }
    const hashes = new Set(Ledger.open(dir).entries().map((e) => e.hash));
    for (const h of acked) expect(hashes.has(h)).toBe(true);
    const seqs = Ledger.open(dir).entries().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(acked.size).toBeGreaterThan(20);
  }, 60_000);

  it("serializes concurrent writers into one valid chain", async () => {
    const dir = join(root, "concurrent");
    Ledger.open(dir);
    const kids = [0, 1, 2, 3].map((k) => writer(dir, 40, `w${k}`));
    await Promise.all(kids.map((c) => new Promise((r) => c.on("close", r))));
    const v = verifyLedger(dir);
    expect(v).toMatchObject({ ok: true, repairable: [] });
    expect(Ledger.open(dir).entries()).toHaveLength(160);
  }, 60_000);
});
