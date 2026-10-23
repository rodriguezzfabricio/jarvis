import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
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

/** Writes every byte or throws: a short write is never acknowledged (Codex stage 0 review 5). */
export type WriteFn = (fd: number, buf: Buffer, offset: number, length: number) => number;
export function writeAll(fd: number, data: string, write: WriteFn = (f, b, o, l) => writeSync(f, b, o, l)): void {
  const buf = Buffer.from(data);
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`write made no progress at byte ${off} of ${buf.length}`);
    off += n;
  }
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

export interface LedgerOptions {
  /** Test seam: the low-level write used for the ledger and head files. */
  write?: WriteFn;
  /** Test seam: called between lock-protocol steps, to interleave competing writers deterministically. */
  onLockStep?: (step: "reclaim-claimed" | "before-unlink") => void;
  /** How long to wait for the writer lock (default 30 s). */
  lockTimeoutMs?: number;
}

export class Ledger {
  readonly dir: string;
  private readonly opts: LedgerOptions;
  private constructor(dir: string, opts: LedgerOptions) {
    this.dir = dir;
    this.opts = opts;
  }

  static open(dir: string, opts: LedgerOptions = {}): Ledger {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new Ledger(dir, opts);
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
      // Repair a lagging head durably before extending the chain, so a second crash can't leave it two behind.
      if (last && v.repairable.includes("head lags by one entry")) this.writeHead(last.hash);
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
        writeAll(fd, `${JSON.stringify(entry)}\n`, this.opts.write);
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
      writeAll(fd, `${hash}\n`, this.opts.write);
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
   * Writer lock (Codex stage 0 review 5). The lock file is created fully initialized in one atomic step
   * (a temp file holding "pid nonce", hard-linked into place), so it is never empty or half-written.
   * A lock whose pid is dead is reclaimed only by whoever wins an exclusive per-instance marker
   * (ledger.lock.reclaim.<nonce>). Its owner is dead, and every other reclaimer is shut out by the
   * marker, so the instance can only be removed once, and never a replacement lock. The deadline is
   * checked on every path.
   */
  private withLock<T>(fn: () => T): T {
    const lock = join(this.dir, LOCK);
    const nonce = randomBytes(12).toString("hex");
    const deadline = Date.now() + (this.opts.lockTimeoutMs ?? 30_000);
    const tryCreate = (): boolean => {
      const tmp = join(this.dir, `${LOCK}.tmp-${nonce}`);
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeAll(fd, `${process.pid} ${nonce}`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(tmp, lock);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      } finally {
        rmSync(tmp, { force: true });
      }
    };
    const holder = (): { pid: number; nonce: string } | undefined => {
      try {
        const [pid, n] = readFileSync(lock, "utf8").trim().split(" ");
        return { pid: Number.parseInt(pid ?? "", 10), nonce: n ?? "" };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    };
    for (;;) {
      if (Date.now() > deadline) throw new Error(`ledger lock not acquired within ${this.opts.lockTimeoutMs ?? 30_000} ms`);
      if (tryCreate()) break;
      const h = holder();
      if (h && Number.isFinite(h.pid) && h.nonce && !pidAlive(h.pid)) {
        const marker = join(this.dir, `${LOCK}.reclaim.${h.nonce}`);
        let claimed = false;
        try {
          const fd = openSync(marker, "wx", 0o600);
          closeSync(fd);
          claimed = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        if (claimed) {
          this.opts.onLockStep?.("reclaim-claimed");
          const again = holder();
          this.opts.onLockStep?.("before-unlink");
          if (again && again.nonce === h.nonce) rmSync(lock, { force: true });
          continue;
        }
      }
      sleepMs(2 + Math.floor(Math.random() * 5));
    }
    try {
      return fn();
    } finally {
      // Release only our own lock.
      if (holder()?.nonce === nonce) rmSync(lock, { force: true });
      for (const f of readdirSync(this.dir)) {
        if (f.startsWith(`${LOCK}.reclaim.`)) {
          try {
            if (Date.now() - statSync(join(this.dir, f)).mtimeMs > 600_000) rmSync(join(this.dir, f), { force: true });
          } catch {
            // already gone
          }
        }
      }
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
