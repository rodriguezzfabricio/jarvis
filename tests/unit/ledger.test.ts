import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GENESIS, Ledger, LedgerTamperError, entryHash, verifyLedger, writeAll } from "../../packages/cli/src/ledger/ledger.ts";
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
/** The pid of a process that has exited (so it is certainly not alive, unlike a made-up number). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number.parseInt(r.stdout, 10);
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

  // Codex review 5, high: short writes.
  it("writes every byte, across short writes, and refuses a write that makes no progress", () => {
    const { dir } = fresh(1);
    const short = Ledger.open(dir, { write: (fd, buf, off, len) => writeSync(fd, buf, off, Math.min(len, 7)) });
    const e = short.append({ kind: "steer", actor: "runner", data: { note: "written seven bytes at a time" } });
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
    expect(Ledger.open(dir).entries().at(-1)?.hash).toBe(e.hash);
    // A writer stuck at zero bytes, bounded so a missing guard fails here instead of hanging the suite.
    const zero = () => {
      let calls = 0;
      return () => {
        if (++calls > 100) throw new Error("test writer gave up: the loop never stopped on a zero-byte write");
        return 0;
      };
    };
    expect(() => writeAll(0, "abc", zero())).toThrow(/no progress/);
    const stuck = Ledger.open(dir, { write: zero() });
    expect(() => stuck.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/no progress/);
    expect(verifyLedger(dir).ok).toBe(true);
    expect(Ledger.open(dir).entries()).toHaveLength(2);
  });

  // Codex review 5, medium: a crash during recovery itself.
  it("repairs a lagging head before appending, so a second crash can't strand the ledger", () => {
    const { dir, ledger } = fresh(3);
    const es = lines(dir).map((l) => JSON.parse(l));
    writeFileSync(join(dir, "head.hash"), `${es[1].hash}\n`); // crash 1: head one behind
    // crash 2 at the same point: the entry is written, then the head write fails
    let calls = 0;
    const crashing = Ledger.open(dir, {
      write: (fd, buf, off, len) => {
        calls++;
        if (calls === 3) throw new Error("simulated crash before the head update");
        return writeSync(fd, buf, off, len);
      },
    });
    expect(() => crashing.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/simulated crash/);
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: ["head lags by one entry"] });
    expect(ledger.append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(5);
  });

  // Codex review 5, high / medium: lock reclamation.
  it("never reclaims a stale lock another live reclaimer is already handling, and never loops forever", () => {
    const { dir } = fresh(1);
    writeFileSync(join(dir, "ledger.lock"), "999999 deadbeef");
    writeFileSync(join(dir, "ledger.lock.reclaim.deadbeef"), `${process.pid} 0123abcd`); // a live reclaimer
    const quick = Ledger.open(dir, { lockTimeoutMs: 300 });
    expect(() => quick.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    expect(readFileSync(join(dir, "ledger.lock"), "utf8")).toBe("999999 deadbeef");
    rmSync(join(dir, "ledger.lock.reclaim.deadbeef"));
    expect(quick.append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(2);
    expect(existsSync(join(dir, "ledger.lock"))).toBe(false);
  });

  // Codex review 6, medium: a reclaimer that died holding its marker must not block later writers.
  it("recovers when a reclaimer died holding its marker, at any depth", () => {
    const dead = deadPid();
    for (const depth of [1, 2, 3]) {
      const { dir } = fresh(2);
      writeFileSync(join(dir, "ledger.lock"), `${dead} aa00`);
      let path = join(dir, "ledger.lock");
      let owner = "aa00";
      for (let d = 1; d <= depth; d++) {
        path = `${path}.reclaim.${owner}`;
        owner = `bb0${d}`;
        writeFileSync(path, `${dead} ${owner}`);
      }
      const l = Ledger.open(dir, { lockTimeoutMs: 3000 });
      expect(l.append({ kind: "steer", actor: "runner", data: { depth } }).seq).toBe(3);
      expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
      expect(readdirSync(dir).filter((f) => f.startsWith("ledger.lock"))).toEqual([]);
    }
  });

  it("keeps one writer at a time: transact's read and append are atomic", () => {
    const { dir, ledger } = fresh(1);
    const other = Ledger.open(dir);
    const seen = ledger.transact((es, add) => {
      const before = es.length;
      // Another writer can't get in while we hold the lock.
      expect(() => Ledger.open(dir, { lockTimeoutMs: 200 }).append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
      const e = add({ kind: "steer", actor: "runner", data: { after: es.length } });
      return { before, seq: e.seq, after: es.length };
    });
    expect(seen).toEqual({ before: 1, seq: 2, after: 2 });
    expect(other.append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(3);
  });

  it("times out instead of spinning on a malformed lock", () => {
    const { dir } = fresh(1);
    writeFileSync(join(dir, "ledger.lock"), "");
    const t0 = Date.now();
    expect(() => Ledger.open(dir, { lockTimeoutMs: 300 }).append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("reads back verified entries", () => {
    const { ledger } = fresh(2);
    expect(ledger.entries().map((e) => e.data)).toEqual([{ note: "n0" }, { note: "n1" }]);
  });
});
