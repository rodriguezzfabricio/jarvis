import { createHash } from "node:crypto";
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
/**
 * Lock time that passes only when the lock reads its clock (`tick` per read) or sleeps, never because the
 * machine is loaded: a deadline then means "this much lock work", deterministically.
 */
function virtualClock(tick = 1): { t: number; now: () => number; sleep: (ms: number) => void } {
  const c = { t: 0, now: () => (c.t += tick), sleep: (ms: number) => void (c.t += ms) };
  return c;
}
const ROOT_NONCE = "ab".repeat(12);
/**
 * A dead lock with `count` stranded bounded reclaim markers below it, as repeated reclaimer crashes leave
 * them. Every owner is `dead` except marker number `liveAt`, owned by this (live) process.
 * Returns [lock, marker 1, ..., marker count] and the owner nonce of each.
 */
function strandedChain(dir: string, count: number, dead: number, liveAt = -1): { paths: string[]; owners: string[] } {
  let path = join(dir, "ledger.lock");
  let owner = ROOT_NONCE;
  writeFileSync(path, `${dead} ${owner}`);
  const paths = [path];
  const owners = [owner];
  for (let depth = 0; depth < count; depth++) {
    const digest = createHash("sha256").update(`${path.split("/").at(-1)!}\0${owner}`).digest("hex");
    path = join(dir, depth === 0 ? `ledger.lock.reclaim.${owner}` : `ledger.lock.reclaim.${ROOT_NONCE}.${digest}`);
    owner = depth.toString(16).padStart(24, "0");
    writeFileSync(path, `${depth + 1 === liveAt ? process.pid : dead} ${owner}`);
    paths.push(path);
    owners.push(owner);
  }
  return { paths, owners };
}
const lockFiles = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("ledger.lock"));
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
      let seq = 0;
      expect(() => (seq = l.append({ kind: "steer", actor: "runner", data: { depth } }).seq)).not.toThrow();
      expect(seq).toBe(3);
      expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
      expect(readdirSync(dir).filter((f) => f.startsWith("ledger.lock"))).toEqual([]);
    }
  });

  // Codex review 16 D5: production nonces make a seven-marker legacy chain reach NAME_MAX.
  it("recovers a legacy stranded chain at the filesystem filename limit", () => {
    const dead = deadPid();
    const { dir } = fresh(2);
    let path = join(dir, "ledger.lock");
    let owner = "00".repeat(12);
    writeFileSync(path, `${dead} ${owner}`);
    for (let d = 1; d <= 7; d++) {
      path = `${path}.reclaim.${owner}`;
      owner = d.toString(16).padStart(24, "0");
      writeFileSync(path, `${dead} ${owner}`);
    }
    expect(Buffer.byteLength(path.split("/").at(-1)!)).toBe(242);
    const ledger = Ledger.open(dir, { lockTimeoutMs: 3000 });
    expect(ledger.append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(3);
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
    expect(readdirSync(dir).filter((f) => f.startsWith("ledger.lock"))).toEqual([]);
  });

  it("recovers repeated crashed reclaimers with bounded names and respects a live deepest owner", () => {
    const dead = deadPid();
    const { dir } = fresh(2);
    const { paths, owners } = strandedChain(dir, 40, dead, 40);
    expect(Math.max(...paths.map((p) => Buffer.byteLength(p.split("/").at(-1)!)))).toBeLessThan(256);
    const before = paths.map((p) => readFileSync(p, "utf8"));
    const quick = Ledger.open(dir, { lockTimeoutMs: 100, clock: virtualClock() });
    expect(() => quick.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    // The live deepest owner is respected, and so is every dead marker above it: nothing was unwound.
    expect(paths.map((p) => readFileSync(p, "utf8"))).toEqual(before);
    expect(readFileSync(paths[40]!, "utf8")).toBe(`${process.pid} ${owners[40]}`);
    writeFileSync(paths[40]!, `${dead} ${owners[40]}`);
    expect(Ledger.open(dir, { lockTimeoutMs: 3000, clock: virtualClock() }).append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(3);
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
    expect(lockFiles(dir)).toEqual([]);
  });

  it("stops unwinding when a live competitor claims the next parent mid-unwind, and never removes it", () => {
    const dead = deadPid();
    const { dir } = fresh(2);
    const { paths } = strandedChain(dir, 5, dead);
    const before = paths.map((p) => readFileSync(p, "utf8"));
    const rival = `${process.pid} ${"12".repeat(12)}`;
    let raced = false;
    const ledger = Ledger.open(dir, {
      lockTimeoutMs: 100,
      clock: virtualClock(),
      onLockStep: (step) => {
        if (step !== "unwound" || raced) return;
        raced = true;
        // The deepest marker is gone; its name is the claim on its parent. A live rival takes it first.
        expect(existsSync(paths[5]!)).toBe(false);
        writeFileSync(paths[5]!, rival);
      },
    });
    expect(() => ledger.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    expect(raced).toBe(true);
    expect(paths.slice(0, 5).map((p) => readFileSync(p, "utf8"))).toEqual(before.slice(0, 5));
    expect(readFileSync(paths[5]!, "utf8")).toBe(rival);
    expect(verifyLedger(dir).entries).toHaveLength(2);
    writeFileSync(paths[5]!, `${dead} ${"12".repeat(12)}`); // the rival dies holding its claim
    expect(Ledger.open(dir, { clock: virtualClock() }).append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(3);
    expect(verifyLedger(dir)).toMatchObject({ ok: true, repairable: [] });
    expect(lockFiles(dir)).toEqual([]);
  });

  it("never recreates a legacy descendant after it disappears while a bounded competitor claims the parent", () => {
    const dead = deadPid();
    const { dir } = fresh(2);
    const rootNonce = "ab".repeat(12);
    const owner = "cd".repeat(12);
    const lock = join(dir, "ledger.lock");
    const parent = `${lock}.reclaim.${rootNonce}`;
    const legacy = `${parent}.reclaim.${owner}`;
    const digest = createHash("sha256").update(`${parent.split("/").at(-1)!}\0${owner}`).digest("hex");
    const bounded = join(dir, `ledger.lock.reclaim.${rootNonce}.${digest}`);
    writeFileSync(lock, `${dead} ${rootNonce}`);
    writeFileSync(parent, `${dead} ${owner}`);
    writeFileSync(legacy, `${dead} ${"ef".repeat(12)}`);
    let raced = false;
    const ledger = Ledger.open(dir, {
      lockTimeoutMs: 150,
      clock: virtualClock(),
      onLockStep: (step) => {
        if (step !== "legacy-observed" || raced) return;
        raced = true;
        // X removes the observed legacy child; Z wins the bounded claim before Y continues.
        rmSync(legacy);
        writeFileSync(bounded, `${process.pid} ${"12".repeat(12)}`);
      },
    });
    expect(() => ledger.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    expect(raced).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(parent, "utf8")).toBe(`${dead} ${owner}`);
    expect(readFileSync(lock, "utf8")).toBe(`${dead} ${rootNonce}`);
    expect(readFileSync(bounded, "utf8")).toBe(`${process.pid} ${"12".repeat(12)}`);
    expect(verifyLedger(dir).entries).toHaveLength(2);
    rmSync(bounded);
    expect(ledger.append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(3);
  });

  it("respects a live legacy descendant until that owner exits", () => {
    const dead = deadPid();
    const { dir } = fresh(2);
    const lock = join(dir, "ledger.lock");
    const parent = `${lock}.reclaim.${"ab".repeat(12)}`;
    const legacy = `${parent}.reclaim.${"cd".repeat(12)}`;
    writeFileSync(lock, `${dead} ${"ab".repeat(12)}`);
    writeFileSync(parent, `${dead} ${"cd".repeat(12)}`);
    writeFileSync(legacy, `${process.pid} ${"ef".repeat(12)}`);
    const ledger = Ledger.open(dir, { lockTimeoutMs: 150 });
    expect(() => ledger.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    expect(readFileSync(parent, "utf8")).toBe(`${dead} ${"cd".repeat(12)}`);
    expect(readFileSync(legacy, "utf8")).toBe(`${process.pid} ${"ef".repeat(12)}`);
    writeFileSync(legacy, `${dead} ${"ef".repeat(12)}`);
    expect(Ledger.open(dir, { lockTimeoutMs: 3000 }).append({ kind: "steer", actor: "runner", data: {} }).seq).toBe(3);
    expect(readdirSync(dir).filter((f) => f.startsWith("ledger.lock"))).toEqual([]);
  });

  it("never removes a replacement lock after winning reclamation of the old instance", () => {
    const dead = deadPid();
    const { dir } = fresh(2);
    const lock = join(dir, "ledger.lock");
    writeFileSync(lock, `${dead} ${"ab".repeat(12)}`);
    const replacement = `${process.pid} ${"cd".repeat(12)}`;
    let replaced = false;
    const ledger = Ledger.open(dir, {
      lockTimeoutMs: 100,
      onLockStep: (step) => {
        if (step !== "reclaim-claimed") return;
        replaced = true;
        writeFileSync(lock, replacement);
      },
    });
    expect(() => ledger.append({ kind: "steer", actor: "runner", data: {} })).toThrow(/not acquired/);
    expect(replaced).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(replacement);
    expect(verifyLedger(dir).entries).toHaveLength(2);
    rmSync(lock);
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

// Codex stage 0 review 11, medium: an append between reading the ledger and reading the head looked like tampering.
describe("verified reads during a concurrent append", () => {
  it("see a consistent ledger and head when an append lands between the two reads", () => {
    const { dir, ledger } = fresh(2);
    let raced = false;
    const v = verifyLedger(dir, {
      afterLedgerRead: () => {
        if (raced) return;
        raced = true;
        ledger.append({ kind: "steer", actor: "runner", data: { note: "racing" } });
      },
    });
    expect(raced).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.entries).toHaveLength(3);
  });

  // Codex review 12, medium: an append during every attempt exhausted the retries and still reported tampering.
  it("never reports tampering for reads that never settle; the ledger reads under the writer lock instead", () => {
    const { dir, ledger } = fresh(2);
    const unstable = verifyLedger(dir, { afterLedgerRead: () => void ledger.append({ kind: "steer", actor: "runner", data: { note: "busy" } }) });
    expect(unstable.ok).toBe(false);
    expect(unstable.contended).toBe(true);
    expect(unstable.problems.join(" ")).not.toMatch(/forged|deleted|mismatch/);
    const writer = Ledger.open(dir);
    const reader = Ledger.open(dir, { afterLedgerRead: () => void writer.append({ kind: "steer", actor: "runner", data: { note: "busy" } }) });
    const v = reader.verify();
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.entries.length).toBeGreaterThan(unstable.entries.length + 2);
    expect(() => reader.entries()).not.toThrow();
  });

  it("still reports a forged head when the reads are stable", () => {
    const { dir } = fresh(2);
    writeFileSync(join(dir, "head.hash"), `${"f".repeat(64)}\n`);
    expect(verifyLedger(dir, { afterLedgerRead: () => {} }).problems.join(" ")).toMatch(/head.hash does not match/);
  });
});
