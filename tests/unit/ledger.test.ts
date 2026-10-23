import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GENESIS, Ledger, LedgerTamperError, entryHash, verifyLedger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtl-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function fresh(count = 3): { dir: string; ledger: Ledger } {
  const dir = join(root, `l${++n}`);
  const ledger = Ledger.open(dir);
  for (let i = 0; i < count; i++) ledger.append({ kind: "steer", actor: "runner", data: { note: `n${i}` } });
  return { dir, ledger };
}
const lines = (dir: string) => readFileSync(join(dir, "ledger.jsonl"), "utf8").trimEnd().split("\n");

describe("ledger (decisions 41, 49)", () => {
  it("chains entries by hash, starting from genesis, with contiguous sequence numbers", () => {
    const { dir } = fresh(3);
    const es = lines(dir).map((l) => JSON.parse(l));
    expect(es.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(es[0].prev_hash).toBe(GENESIS);
    expect(es[1].prev_hash).toBe(es[0].hash);
    for (const e of es) {
      const { hash, ...rest } = e;
      expect(entryHash(rest)).toBe(hash);
    }
    expect(readFileSync(join(dir, "head.hash"), "utf8").trim()).toBe(es[2].hash);
    expect(verifyLedger(dir).ok).toBe(true);
  });

  it("only accepts known entry kinds and actors", () => {
    const { ledger } = fresh(0);
    expect(() => ledger.append({ kind: "anything", actor: "runner", data: {} } as never)).toThrow(/kind/);
    expect(() => ledger.append({ kind: "steer", actor: "agent", data: {} } as never)).toThrow(/actor/);
  });

  it("detects an edited entry", () => {
    const { dir } = fresh(3);
    const ls = lines(dir);
    ls[1] = ls[1]!.replace('"n1"', '"edited"');
    writeFileSync(join(dir, "ledger.jsonl"), `${ls.join("\n")}\n`);
    const v = verifyLedger(dir);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/seq 2: hash mismatch/);
  });

  it("detects an edited entry even when its hash was recomputed (the chain breaks)", () => {
    const { dir } = fresh(3);
    const es = lines(dir).map((l) => JSON.parse(l));
    es[1].data.note = "edited";
    const { hash: _h, ...rest } = es[1];
    es[1].hash = entryHash(rest);
    writeFileSync(join(dir, "ledger.jsonl"), `${es.map((e) => JSON.stringify(e)).join("\n")}\n`);
    expect(verifyLedger(dir).problems.join(" ")).toMatch(/seq 3: prev_hash does not match/);
  });

  it("detects deleted entries at the end (the head is kept separately)", () => {
    const { dir } = fresh(3);
    writeFileSync(join(dir, "ledger.jsonl"), `${lines(dir).slice(0, 1).join("\n")}\n`);
    const v = verifyLedger(dir);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/head/);
  });

  it("detects reordered and removed middle entries", () => {
    const { dir } = fresh(3);
    const ls = lines(dir);
    writeFileSync(join(dir, "ledger.jsonl"), `${[ls[0], ls[2], ls[1]].join("\n")}\n`);
    expect(verifyLedger(dir).ok).toBe(false);
    const d2 = fresh(3).dir;
    const l2 = lines(d2);
    writeFileSync(join(d2, "ledger.jsonl"), `${[l2[0], l2[2]].join("\n")}\n`);
    expect(verifyLedger(d2).ok).toBe(false);
  });

  it("detects a forged head", () => {
    const { dir } = fresh(2);
    writeFileSync(join(dir, "head.hash"), `${"a".repeat(64)}\n`);
    expect(verifyLedger(dir).ok).toBe(false);
  });

  it("refuses to append to a tampered ledger", () => {
    const { dir, ledger } = fresh(3);
    const ls = lines(dir);
    ls[0] = ls[0]!.replace('"n0"', '"x"');
    writeFileSync(join(dir, "ledger.jsonl"), `${ls.join("\n")}\n`);
    expect(() => ledger.append({ kind: "steer", actor: "runner", data: {} })).toThrow(LedgerTamperError);
  });

  it("repairs a torn final line (a crash mid-write, never acknowledged) and continues the chain", () => {
    const { dir, ledger } = fresh(2);
    appendFileSync(join(dir, "ledger.jsonl"), '{"seq":3,"ts":"2026-');
    const v = verifyLedger(dir);
    expect(v.ok).toBe(true);
    expect(v.repairable).toEqual(["torn final line"]);
    const e = ledger.append({ kind: "steer", actor: "runner", data: { note: "after" } });
    expect(e.seq).toBe(3);
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
  });

  it("repairs a head that lags by exactly one entry (a crash between the two writes)", () => {
    const { dir, ledger } = fresh(3);
    const es = lines(dir).map((l) => JSON.parse(l));
    writeFileSync(join(dir, "head.hash"), `${es[1].hash}\n`);
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: ["head lags by one entry"] });
    expect(ledger.append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(4);
    expect(verifyLedger(dir).repairable).toEqual([]);
  });

  it("reads back verified entries", () => {
    const { ledger } = fresh(2);
    expect(ledger.entries().map((e) => e.data)).toEqual([{ note: "n0" }, { note: "n1" }]);
  });
});
