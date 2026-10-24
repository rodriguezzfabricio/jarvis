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
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";

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
  "blocked", "reconciled", "checks_approved", "run_started", "run_ended", "notify",
  "session_usage", "footprint",
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
  /** Writers moved the head during every read, so nothing was verified (not tampering). */
  contended?: boolean;
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

/** Attempts at a stable read before verifying whatever was read last. */
const STABLE_READ_ATTEMPTS = 5;

/**
 * Verifies the ledger against its head. A writer may append between the two reads, which would pair an
 * older ledger with a newer head and look like forgery (Codex review 11). So the head is read before and
 * after the ledger, and the read is retried until both match; an append can only move the head forward.
 * Reads that never settle are "contended", never tampering (review 12): `Ledger.verify` then reads under
 * the writer lock.
 */
export function verifyLedger(dir: string, seams: { afterLedgerRead?: () => void } = {}): VerifyResult {
  for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt++) {
    const before = readText(join(dir, HEAD)).trim();
    const text = readText(join(dir, FILE));
    seams.afterLedgerRead?.();
    const head = readText(join(dir, HEAD)).trim();
    if (head === before) return verifyText(text, head);
  }
  return { ok: false, contended: true, entries: [], problems: ["writers kept the ledger moving during every read; not verified"], repairable: [] };
}

function verifyText(text: string, head: string): VerifyResult {
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
  onLockStep?: (step: "reclaim-claimed" | "before-unlink" | "legacy-observed") => void;
  /** How long to wait for the writer lock (default 30 s). */
  lockTimeoutMs?: number;
  /** Test seam: called between verify's ledger and head reads, outside the lock, to interleave a writer. */
  afterLedgerRead?: () => void;
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

  /** verifyLedger, read again under the writer lock if writers kept it moving: a consistent result either way. */
  verify(): VerifyResult {
    const seams = this.opts.afterLedgerRead ? { afterLedgerRead: this.opts.afterLedgerRead } : {};
    const v = verifyLedger(this.dir, seams);
    return v.contended ? this.withLock(() => verifyLedger(this.dir)) : v;
  }

  /** Verified entries; throws on tampering. */
  entries(): LedgerEntry[] {
    const v = this.verify();
    if (!v.ok) throw new LedgerTamperError(`ledger failed verification: ${v.problems.join("; ")}`);
    return v.entries;
  }

  append(input: AppendInput): LedgerEntry {
    return this.transact((_entries, add) => add(input));
  }

  /**
   * Reads the verified entries and appends under the writer lock, in one step, so a decision taken
   * from what the ledger holds can't race another writer, in this process or another (Codex stage 0
   * review 6: the broker's check-and-claim). `fn` must be synchronous; `entries` includes what it appends.
   */
  transact<T>(fn: (entries: readonly LedgerEntry[], append: (input: AppendInput) => LedgerEntry) => T): T {
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
      const list = [...v.entries];
      // Repair a lagging head durably before extending the chain, so a second crash can't leave it two behind.
      const lastNow = list.at(-1);
      if (lastNow && v.repairable.includes("head lags by one entry")) this.writeHead(lastNow.hash);
      const add = (input: AppendInput): LedgerEntry => {
        if (!(KINDS as readonly string[]).includes(input.kind)) throw new Error(`unknown ledger kind: ${String(input.kind)}`);
        if (!(ACTORS as readonly string[]).includes(input.actor)) throw new Error(`unknown ledger actor: ${String(input.actor)}`);
        const last = list.at(-1);
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
        list.push(entry);
        return entry;
      };
      return fn(list, add);
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
   * Writer lock (Codex stage 0 reviews 5 and 6). Every lock file, and every reclaim marker, is created
   * fully initialized in one atomic step (a temp file holding "pid nonce", hard-linked into place), so
   * none is ever empty or half-written, and each names its owner.
   *
   * A lock whose owner is dead is removed only by whoever wins its exclusive marker
   * (ledger.lock.reclaim.<nonce>), and only while it is still that same instance, so a replacement lock
   * is never removed. A reclaimer that dies holding a marker is a dead owner too, and its marker is
   * recovered the same way using bounded names: the original lock nonce plus a hash of the parent
   * marker name and owner nonce. Stranded legacy nested names remain recoverable. The same deadline
   * bounds every descent, without imposing a depth limit on repeated reclaimer crashes.
   */
  private withLock<T>(fn: () => T): T {
    const lock = join(this.dir, LOCK);
    const nonce = randomBytes(12).toString("hex");
    const timeout = this.opts.lockTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`ledger lock not acquired within ${timeout} ms`);
      if (this.createOwned(lock, nonce)) break;
      const h = readOwner(lock);
      if (h && !pidAlive(h.pid)) this.reclaim(lock, h, deadline);
      else sleepMs(2 + Math.floor(Math.random() * 5));
    }
    try {
      return fn();
    } finally {
      if (readOwner(lock)?.nonce === nonce) {
        this.sweepMarkers(nonce);
        rmSync(lock, { force: true }); // release only our own lock
      }
    }
  }

  /** Creates `path` holding "pid nonce" in one atomic step; false if it already exists. */
  private createOwned(path: string, nonce: string): boolean {
    const tmp = join(this.dir, `${LOCK}.tmp-${randomBytes(8).toString("hex")}`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeAll(fd, `${process.pid} ${nonce}`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Removes the instance of `path` that the dead owner `h` holds, at most once (see withLock). */
  private reclaim(path: string, h: Owner, deadline: number): void {
    const rootNonce = h.nonce;
    let depth = 0;
    while (Date.now() <= deadline) {
      const legacy = `${path}.reclaim.${h.nonce}`;
      const digest = createHash("sha256").update(`${basename(path)}\0${h.nonce}`).digest("hex");
      // Existing installations may have stranded nested markers. Observe them without ever
      // recreating their names: every contender must CREATE the same bounded claim for a parent.
      // Otherwise a disappearing legacy marker could produce two exclusive claims on that parent.
      const legacyFits = Buffer.byteLength(basename(legacy)) <= 255;
      if (depth > 0 && legacyFits && existsSync(legacy)) {
        this.opts.onLockStep?.("legacy-observed");
        const previous = readOwner(legacy);
        if (previous && !pidAlive(previous.pid)) {
          path = legacy;
          h = previous;
          depth++;
          continue;
        }
        sleepMs(2 + Math.floor(Math.random() * 5));
        return;
      }
      const marker = depth === 0
        ? legacy
        : join(this.dir, `${LOCK}.reclaim.${rootNonce}.${digest}`);
      const mine = randomBytes(12).toString("hex");
      if (!existsSync(marker) && this.createOwned(marker, mine)) {
        try {
          if (depth === 0) this.opts.onLockStep?.("reclaim-claimed");
          const again = readOwner(path);
          if (depth === 0) this.opts.onLockStep?.("before-unlink");
          if (again && again.nonce === h.nonce) rmSync(path, { force: true });
        } finally {
          if (readOwner(marker)?.nonce === mine) rmSync(marker, { force: true });
        }
        return;
      }
      const m = readOwner(marker);
      if (m && !pidAlive(m.pid)) {
        path = marker;
        h = m;
        depth++;
      } else {
        sleepMs(2 + Math.floor(Math.random() * 5));
        return;
      }
    }
  }

  /**
   * Markers left by reclaimers that died after removing their lock refer to lock instances that no
   * longer exist. While we hold the lock, any marker for another instance is inert, so remove it.
   */
  private sweepMarkers(ours: string): void {
    const prefix = `${LOCK}.reclaim.`;
    for (const f of readdirSync(this.dir)) {
      if (!f.startsWith(prefix) || f.includes(".tmp-")) continue;
      if (f.slice(prefix.length).split(".")[0] === ours) continue;
      rmSync(join(this.dir, f), { force: true });
    }
  }
}

interface Owner {
  pid: number;
  nonce: string;
}

/** The "pid nonce" owner record of a lock or marker; undefined if it's gone or unreadable. */
function readOwner(path: string): Owner | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const m = /^(\d+) ([0-9a-f]+)$/.exec(text.trim());
  if (!m) return undefined;
  const pid = Number.parseInt(m[1]!, 10);
  return pid > 0 ? { pid, nonce: m[2]! } : undefined;
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
