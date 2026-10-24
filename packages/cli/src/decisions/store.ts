import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { addDecision, parseRegister, serializeRegister, supersedeDecision, type Decision, type DecisionInput, type RegisterDocument } from "./format.ts";
import { assertMaySupersede } from "./conflicts.ts";
import { validateSource } from "./source.ts";

export interface StoreOptions {
  write?: (fd: number, text: string) => void;
  rename?: (from: string, to: string) => void;
  sync?: (fd: number) => void;
}
function readText(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function lockOwner(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(4096);
    const owner = JSON.parse(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(owner.pid) || typeof owner.host !== "string" || typeof owner.time !== "string") return "metadata unavailable";
    return JSON.stringify({ pid: owner.pid, host: owner.host, time: owner.time });
  } catch { return "metadata unavailable"; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function assertPreserved(current: RegisterDocument, next: RegisterDocument): void {
  const byId = new Map(next.entries.map((entry) => [entry.id, entry]));
  for (const old of current.entries) {
    const entry = byId.get(old.id);
    if (!entry) throw new Error(`Refusing to drop decision D${old.id}`);
    const { status: oldStatus, ...oldChoice } = old;
    const { status, ...choice } = entry;
    if (!isDeepStrictEqual(oldChoice, choice)) throw new Error(`Refusing to rewrite decision D${old.id}; supersede it instead`);
    if (!isDeepStrictEqual(oldStatus, status) && !(oldStatus.kind === "active" && status.kind === "superseded")) {
      throw new Error(`Refusing to rewrite history for D${old.id}`);
    }
    if (oldStatus.kind === "active" && status.kind === "superseded") {
      const replacement = byId.get(status.by);
      if (!replacement) throw new Error("Missing supersession target");
      assertMaySupersede(old, replacement.madeBy, status.reason);
    }
  }
}

/** Single-writer, atomic replacement of the project register. A stranded lock fails closed. */
export class DecisionRegister {
  readonly path: string;
  private readonly repo: string;
  private readonly options: StoreOptions;

  private constructor(repo: string, options: StoreOptions) {
    this.repo = realpathSync(resolve(repo));
    this.path = join(this.repo, "docs", "decisions.md");
    this.options = options;
  }

  static open(repo: string, options: StoreOptions = {}): DecisionRegister { return new DecisionRegister(repo, options); }
  read(): RegisterDocument { this.assertSafePaths(); return parseRegister(readText(this.path)); }

  private assertSafePaths(): void {
    for (const path of [dirname(this.path), this.path]) {
      try {
        if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error(`Refusing symlink or unexpected real path: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private locked<T>(action: () => T): T {
    this.assertSafePaths();
    mkdirSync(dirname(this.path), { recursive: true });
    this.assertSafePaths();
    const lock = join(dirname(this.path), ".decisions.lock");
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Decision register busy: lock at ${lock}; owner ${lockOwner(lock)}`);
      throw error;
    }
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), time: new Date().toISOString() })}\n`);
      return action();
    }
    finally { closeSync(fd); unlinkSync(lock); }
  }

  private persist(document: RegisterDocument): void {
    const current = this.read();
    const nextIds = new Set(document.entries.map((entry) => entry.id));
    for (const entry of current.entries) {
      if (!nextIds.has(entry.id)) throw new Error(`Refusing to drop decision D${entry.id}`);
    }
    if (document.source !== current.source) throw new Error("Stale decision register snapshot; read it again before writing");
    assertPreserved(current, document);
    const output = serializeRegister(document);
    const next = parseRegister(output);
    assertPreserved(current, next);
    const oldIds = new Set(current.entries.map((entry) => entry.id));
    // Only new entries must cite a file that exists now; an old entry's source may since have moved.
    for (const entry of next.entries) if (!oldIds.has(entry.id)) validateSource(this.repo, entry.source);
    let expected = Math.max(0, ...oldIds) + 1;
    for (const entry of next.entries.filter((entry) => !oldIds.has(entry.id)).sort((a, b) => a.id - b.id)) {
      if (entry.id !== expected++) throw new Error("New decisions must use the next ID");
    }
    const temporary = join(dirname(this.path), `.decisions.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      (this.options.write ?? writeFileSync)(fd, output);
      (this.options.sync ?? fsyncSync)(fd);
      closeSync(fd);
      fd = undefined;
      if (readText(this.path) !== current.source) throw new Error("Stale decision register snapshot; file changed before rename");
      this.assertSafePaths();
      (this.options.rename ?? renameSync)(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
      try { (this.options.sync ?? fsyncSync)(directory); }
      finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  write(document: RegisterDocument): void { this.locked(() => this.persist(document)); }

  add(input: DecisionInput): Decision {
    return this.locked(() => {
      const document = addDecision(this.read(), input);
      this.persist(document);
      return document.entries.at(-1)!;
    });
  }

  supersede(oldId: number, input: DecisionInput, on: string, reason: string): Decision {
    return this.locked(() => {
      const document = supersedeDecision(this.read(), oldId, input, on, reason);
      this.persist(document);
      return document.entries.at(-1)!;
    });
  }
}
