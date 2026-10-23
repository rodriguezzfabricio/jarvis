import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The run ledger (decisions 41, 49): append-only JSONL, each entry hash-chained to the one before,
 * the latest hash kept in head.hash beside it. Only the runner and the broker write it. Every append
 * is fsynced before it's acknowledged, so a crash can lose only an unacknowledged, torn final line,
 * which is repaired on the next append. Anything else that doesn't verify is tampering: appends refuse.
 */

export const GENESIS = "0".repeat(64);
export const ACTORS = ["runner", "broker"] as const;
export const KINDS = [
  "task_created", "lease", "attempt_started", "attempt_ended", "usage_wait",
  "gate_result", "review_result", "state_reached",
  "spec_version", "decision", "steer",
  "approval_request", "approval", "grant", "broker_request", "broker_receipt",
  "blocked", "reconciled", "checks_approved", "run_started", "run_ended",
] as const;
export type Actor = (typeof ACTORS)[number];
export type Kind = (typeof KINDS)[number];

export interface LedgerEntry {
  seq: number;
  ts: string;
  kind: Kind;
  actor: Actor;
  task_id: string | null;
  attempt_id: string | null;
  data: unknown;
  prev_hash: string;
  hash: string;
}

export interface AppendInput {
  kind: Kind;
  actor: Actor;
  task_id?: string | null;
  attempt_id?: string | null;
  data: unknown;
}

export class LedgerTamperError extends Error {}

/** JSON with object keys sorted at every level, so the hash doesn't depend on key order. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export function entryHash(e: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  entries: LedgerEntry[];
  problems: string[];
  /** Crash leftovers that the next append repairs (not tampering). */
  repairable: string[];
}

const FILE = "ledger.jsonl";
const HEAD = "head.hash";
const LOCK = "ledger.lock";

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function verifyLedger(dir: string): VerifyResult {
  const text = readText(join(dir, FILE));
  const problems: string[] = [];
  const repairable: string[] = [];
  let body = text;
  if (text.length > 0 && !text.endsWith("\n")) {
    repairable.push("torn final line");
    body = text.slice(0, text.lastIndexOf("\n") + 1);
  }
  const entries: LedgerEntry[] = [];
  let prev = GENESIS;
  const ls = body.split("\n").filter((l) => l !== "");
  ls.forEach((line, i) => {
    const n = i + 1;
    let e: LedgerEntry;
    try {
      e = JSON.parse(line) as LedgerEntry;
    } catch {
      problems.push(`line ${n}: not valid JSON`);
      return;
    }
    if (e.seq !== n) problems.push(`line ${n}: seq ${e.seq}, expected ${n}`);
    if (e.prev_hash !== prev) problems.push(`seq ${e.seq}: prev_hash does not match the previous entry`);
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) problems.push(`seq ${e.seq}: hash mismatch (entry edited)`);
    if (!(KINDS as readonly string[]).includes(e.kind) || !(ACTORS as readonly string[]).includes(e.actor)) problems.push(`seq ${e.seq}: unknown kind or actor`);
    entries.push(e);
    prev = hash;
  });
  const head = readText(join(dir, HEAD)).trim();
  const last = entries.at(-1);
  if (!last) {
    if (head && head !== GENESIS) problems.push("head.hash is set but the ledger is empty (entries deleted?)");
  } else if (head !== last.hash) {
    const beforeLast = entries.length > 1 ? entries[entries.length - 2]!.hash : "";
    if ((head === beforeLast && beforeLast !== "") || (head === "" && entries.length === 1)) repairable.push("head lags by one entry");
    else problems.push("head.hash does not match the last entry (entries deleted or head forged)");
  }
  return { ok: problems.length === 0, entries, problems, repairable };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Ledger {
  readonly dir: string;
  private constructor(dir: string) {
    this.dir = dir;
  }

  static open(dir: string): Ledger {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new Ledger(dir);
  }

  /** Verified entries; throws on tampering. */
  entries(): LedgerEntry[] {
    const v = verifyLedger(this.dir);
    if (!v.ok) throw new LedgerTamperError(`ledger failed verification: ${v.problems.join("; ")}`);
    return v.entries;
  }

  append(input: AppendInput): LedgerEntry {
    if (!(KINDS as readonly string[]).includes(input.kind)) throw new Error(`unknown ledger kind: ${String(input.kind)}`);
    if (!(ACTORS as readonly string[]).includes(input.actor)) throw new Error(`unknown ledger actor: ${String(input.actor)}`);
    return this.withLock(() => {
      const path = join(this.dir, FILE);
      // Repair a torn final line: it was never fsynced-and-acknowledged.
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (text.length > 0 && !text.endsWith("\n")) {
          const fd = openSync(path, "r+");
          ftruncateSync(fd, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
          fsyncSync(fd);
          closeSync(fd);
        }
      }
      const v = verifyLedger(this.dir);
      if (!v.ok) throw new LedgerTamperError(`refusing to append: ${v.problems.join("; ")}`);
      const last = v.entries.at(-1);
      const base: Omit<LedgerEntry, "hash"> = {
        seq: (last?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        kind: input.kind,
        actor: input.actor,
        task_id: input.task_id ?? null,
        attempt_id: input.attempt_id ?? null,
        data: input.data,
        prev_hash: last?.hash ?? GENESIS,
      };
      const entry: LedgerEntry = { ...base, hash: entryHash(base) };
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(entry)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.writeHead(entry.hash);
      return entry;
    });
  }

  private writeHead(hash: string): void {
    const tmp = join(this.dir, `${HEAD}.tmp`);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${hash}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(this.dir, HEAD));
    const dfd = openSync(this.dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  /**
   * An exclusive lock file holding the writer's pid. A lock left by a dead writer is taken over only
   * under a second exclusive "takeover" lock, after re-reading the holder, so a waiter can never remove
   * a lock that a live writer has just created.
   */
  private withLock<T>(fn: () => T): T {
    const lock = join(this.dir, LOCK);
    const takeover = join(this.dir, `${LOCK}.takeover`);
    const deadline = Date.now() + 30_000;
    const tryCreate = (path: string): boolean => {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    };
    const holderOf = (path: string): { pid: number; ageMs: number } | undefined => {
      try {
        return { pid: Number.parseInt(readFileSync(path, "utf8"), 10), ageMs: Date.now() - statSync(path).mtimeMs };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // released meanwhile
        throw e;
      }
    };
    const stale = (h: { pid: number; ageMs: number }) => (Number.isFinite(h.pid) ? !pidAlive(h.pid) : h.ageMs > 1000);
    for (;;) {
      if (tryCreate(lock)) break;
      const h = holderOf(lock);
      if (h && stale(h)) {
        if (tryCreate(takeover)) {
          try {
            const again = holderOf(lock);
            if (again && again.pid === h.pid && stale(again)) rmSync(lock, { force: true });
          } finally {
            rmSync(takeover, { force: true });
          }
          continue;
        }
        const t = holderOf(takeover);
        if (t && stale(t) && t.ageMs > 5000) rmSync(takeover, { force: true });
      }
      if (Date.now() > deadline) throw new Error(`ledger lock held by pid ${h?.pid} for over 30 s`);
      sleepMs(2 + Math.floor(Math.random() * 5));
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

/** Writes a value to a file the way the ledger does: temp file, fsync, rename. */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}
