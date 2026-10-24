import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeAll } from "../ledger/ledger.ts";

/** Runner-owned files under ~/.jarvis: owner-only, never through a symlink, replaced atomically. */
export interface PrivateWriteOptions { rename?: typeof renameSync }

export function refuseSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path}: runner-owned files refuse symlinks`);
}

/** Creates the folder (0700) if missing; refuses a symlink or a non-folder. Its parent must exist. */
export function privateDir(path: string): string {
  refuseSymlink(path);
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error(`${path} must be a folder`);
  return path;
}

/** Writes a temp file beside the target (0600, exclusive), fsyncs it, renames it over the target and fsyncs the folder. */
export function writePrivateAtomic(path: string, content: string, options: PrivateWriteOptions = {}): void {
  const directory = dirname(path);
  refuseSymlink(directory);
  refuseSymlink(path);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error(`${path} must be a regular file`);
  const temp = join(directory, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeAll(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    refuseSymlink(path);
    (options.rename ?? renameSync)(temp, path);
    const dirFd = openSync(directory, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally { rmSync(temp, { force: true }); }
}
