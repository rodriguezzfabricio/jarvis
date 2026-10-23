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
      let first: () => void = () => {};
      const firstAck = new Promise<void>((r) => (first = r));
      child.stdout.on("data", (d: Buffer) => {
        for (const m of d.toString().matchAll(/ack ([0-9a-f]{64})/g)) acked.add(m[1]!);
        first();
      });
      // Kill at a random moment after the writer is demonstrably appending (independent of machine load).
      await firstAck;
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 150)));
      child.kill("SIGKILL");
      await new Promise((r) => child.on("close", r));
      const v = verifyLedger(dir);
      expect(v.problems).toEqual([]);
    }
    const hashes = new Set(Ledger.open(dir).entries().map((e) => e.hash));
    for (const h of acked) expect(hashes.has(h)).toBe(true);
    const seqs = Ledger.open(dir).entries().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(acked.size).toBeGreaterThanOrEqual(12); // at least one acknowledged write per round
  }, 60_000);

  it("lets exactly one of many racing writers reclaim a dead writer's lock, repeatedly", async () => {
    for (let round = 0; round < 6; round++) {
      const dir = join(root, `stale-${round}`);
      Ledger.open(dir).append({ kind: "steer", actor: "runner", data: { seed: round } });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "ledger.lock"), `999999 dead${round}`);
      const kids = [0, 1, 2, 3, 4, 5].map((k) => writer(dir, 15, `s${round}-${k}`));
      await Promise.all(kids.map((c) => new Promise((r) => c.on("close", r))));
      const v = verifyLedger(dir);
      expect(v).toMatchObject({ ok: true, repairable: [] });
      expect(v.entries).toHaveLength(1 + 6 * 15);
    }
  }, 120_000);

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
