import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWrite, GENESIS, writeAll, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import type { RunState } from "./state.ts";

export interface InboxCursor { seq: number; hash: string }
export interface InboxIssue { id: string; reason: string }
export type InboxAction =
  | { kind: "replan"; seq: number; note: string; scope: "named" | "not-started"; taskIds: string[] }
  | { kind: "approval"; entry: LedgerEntry };
export interface InboxBatch { actions: InboxAction[]; cursor: InboxCursor; skipped: InboxIssue[] }
export interface InboxIngestion { entries: LedgerEntry[]; skipped: InboxIssue[] }
export interface SubmitSteerOptions { id?: () => string; rename?: typeof renameSync }
export interface IngestSteerOptions { archive?: typeof renameSync }
const MAX_NOTE_BYTES = 16_384;
const MAX_ITEM_BYTES = 128 * 1024;

export function runnerProjectDir(project: string, jarvisHome = join(homedir(), ".jarvis")): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)) throw new Error("Invalid project id");
  return join(jarvisHome, "projects", project);
}

function validateCursor(cursor: InboxCursor, entries: readonly LedgerEntry[]): void {
  const hash = cursor.seq === 0 ? GENESIS : entries.find((e) => e.seq === cursor.seq)?.hash;
  if (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0 || hash === undefined || cursor.hash !== hash) throw new Error("inbox cursor does not match this ledger");
}

export function loadInboxCursor(projectDir: string, entries: readonly LedgerEntry[]): InboxCursor {
  const path = join(projectDir, "inbox-cursor.json");
  const cursor = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as InboxCursor : { seq: 0, hash: GENESIS };
  validateCursor(cursor, entries);
  return cursor;
}

/** Acknowledge only after the batch's effects are durable; crashes before that replay the batch. */
export function saveInboxCursor(projectDir: string, cursor: InboxCursor, entries: readonly LedgerEntry[]): void {
  validateCursor(cursor, entries);
  atomicWrite(join(projectDir, "inbox-cursor.json"), `${JSON.stringify(cursor)}\n`);
}

function affected(note: string, state: RunState): { scope: "named" | "not-started"; taskIds: string[] } {
  const tokens = new Set((note.match(/(?<![\p{L}\p{N}_-])(?:AC|T|S)\d+(?![\p{L}\p{N}_-])/giu) ?? []).map((id) => id.toUpperCase()));
  const tasks = Object.values(state.tasks);
  if (tokens.size === 0) return { scope: "not-started", taskIds: tasks.filter((t) => t.status === "pending" && t.attemptCount === 0).map((t) => t.id) };
  const ids = new Set(tasks.filter((t) => [t.id, ...t.definition.storyIds, ...t.definition.acceptanceCriteria].some((id) => tokens.has(id.toUpperCase()))).map((t) => t.id));
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size;
    for (const task of tasks) if (task.definition.dependencies.some((id) => ids.has(id))) ids.add(task.id);
  }
  return { scope: "named", taskIds: tasks.filter((t) => ids.has(t.id)).map((t) => t.id) };
}

function noteProblem(note: unknown): string | undefined {
  if (typeof note !== "string") return "note must be text";
  if (!note.trim()) return "empty note";
  if (Buffer.byteLength(note) > MAX_NOTE_BYTES) return "note exceeds 16 KiB";
  return undefined;
}

function issueFor(entry: LedgerEntry): InboxIssue | undefined {
  if (entry.actor !== "runner") return undefined;
  const data = entry.data as { note?: unknown; type?: unknown; file?: unknown; reason?: unknown } | null;
  if (entry.kind === "steer") {
    const reason = noteProblem(data?.note);
    return reason ? { id: `ledger #${entry.seq}`, reason } : undefined;
  }
  if (entry.kind === "reconciled" && data?.type === "inbox_skipped") return { id: String(data.file), reason: String(data.reason) };
  return undefined;
}

export function inboxIssues(entries: readonly LedgerEntry[]): InboxIssue[] {
  return entries.map(issueFor).filter((issue) => issue !== undefined);
}

/** Only runner-authored steers can replan. Approvals remain observations for the broker. */
export function readInbox(entries: readonly LedgerEntry[], cursor: InboxCursor, state: RunState): InboxBatch {
  validateCursor(cursor, entries);
  const actions: InboxAction[] = [];
  const unread = entries.filter((e) => e.seq > cursor.seq);
  for (const entry of unread) {
    if (entry.kind === "approval") actions.push({ kind: "approval", entry });
    if (entry.kind !== "steer" || entry.actor !== "runner" || issueFor(entry)) continue;
    const note = (entry.data as { note: string }).note;
    actions.push({ kind: "replan", seq: entry.seq, note, ...affected(note, state) });
  }
  const last = entries.at(-1);
  return { actions, cursor: last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS }, skipped: inboxIssues(unread) };
}

function plainDirectory(path: string): void {
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("inbox paths must be real directories");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The CLI can submit text, but cannot select a ledger actor or write an approval. */
export function submitSteer(projectDir: string, note: string, options: SubmitSteerOptions = {}): string {
  const problem = noteProblem(note);
  if (problem) throw new Error(problem);
  const dir = join(projectDir, "inbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  plainDirectory(projectDir); plainDirectory(dir);
  const id = (options.id ?? randomUUID)();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid inbox item id");
  const temporary = join(dir, `.${id}.tmp`);
  const path = join(dir, `${id}.json`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeAll(fd, `${JSON.stringify({ note })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    (options.rename ?? renameSync)(temporary, path);
    syncDirectory(dir);
  } finally { rmSync(temporary, { force: true }); }
  return path;
}

function readItem(path: string): { note: string } | { reason: string } {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { reason: "note must be a regular file" };
    if (stat.nlink !== 1) return { reason: "hard-linked note refused" };
    if (stat.size > MAX_ITEM_BYTES) return { reason: "note file exceeds 128 KiB" };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_ITEM_BYTES) return { reason: "invalid note file" };
    const buffer = Buffer.alloc(MAX_ITEM_BYTES + 1);
    let used = 0;
    while (used < buffer.length) { const n = readSync(fd, buffer, used, buffer.length - used, null); if (n === 0) break; used += n; }
    if (used > MAX_ITEM_BYTES) return { reason: "note file exceeds 128 KiB" };
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used))) as { note?: unknown } | null;
    const problem = noteProblem(data?.note);
    return problem ? { reason: problem } : { note: data!.note as string };
  } catch { return { reason: "unreadable or malformed note" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function skippedItem(entries: readonly LedgerEntry[], file: string): boolean {
  return entries.some((e) => e.actor === "runner" && e.kind === "reconciled"
    && (e.data as { type?: unknown } | null)?.type === "inbox_skipped"
    && (e.data as { inboxItem?: unknown }).inboxItem === file);
}

function recordArchiveFailure(ledger: Ledger, file: string): InboxIssue | undefined {
  return ledger.transact((entries, add) => {
    if (skippedItem(entries, file)) return undefined;
    const reason = "could not archive inbox item";
    add({ kind: "reconciled", actor: "runner", data: { type: "inbox_skipped", file, reason, inboxItem: file } });
    return { id: file, reason };
  });
}

/** Ledger acknowledgment precedes archival; replay after a crash cannot duplicate a file's entry. */
export function ingestSteerNotes(projectDir: string, ledger: Ledger, options: IngestSteerOptions = {}): InboxIngestion {
  if (resolve(projectDir) !== resolve(ledger.dir)) throw new Error("inbox project must match the ledger root");
  const result: InboxIngestion = { entries: [], skipped: [] };
  const dir = join(projectDir, "inbox");
  if (!existsSync(dir)) return result;
  plainDirectory(projectDir); plainDirectory(dir);
  const archiveDir = join(dir, "ingested");
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 }); plainDirectory(archiveDir);
  for (const file of readdirSync(dir).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort()) {
    if (skippedItem(ledger.entries(), file)) continue;
    const item = readItem(join(dir, file));
    const entry = ledger.transact((entries, add) => {
      if (entries.some((e) => e.actor === "runner" && (e.kind === "steer" || e.kind === "reconciled") && (e.data as { inboxItem?: unknown } | null)?.inboxItem === file)) return undefined;
      return "reason" in item
        ? add({ kind: "reconciled", actor: "runner", data: { type: "inbox_skipped", file, reason: item.reason, inboxItem: file } })
        : add({ kind: "steer", actor: "runner", data: { note: item.note, inboxItem: file } });
    });
    if (entry?.kind === "steer") result.entries.push(entry);
    if (entry?.kind === "reconciled" && "reason" in item) result.skipped.push({ id: file, reason: item.reason });
    try {
      (options.archive ?? renameSync)(join(dir, file), join(archiveDir, file));
      syncDirectory(archiveDir); syncDirectory(dir);
    } catch {
      const skipped = recordArchiveFailure(ledger, file);
      if (skipped) result.skipped.push(skipped);
    }
  }
  return result;
}
