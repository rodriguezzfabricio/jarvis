import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeAll } from "../ledger/ledger.ts";

/**
 * Runner-owned files under ~/.jarvis: owner-only, never through a symlink, replaced atomically.
 * Every runner folder must belong to the current user and be writable by nobody else (Codex review of
 * setup, finding 1): another local user who can write a runner folder could swap plugin hooks, which run
 * outside the sandbox. With that ancestry, nobody else can replace entries between a check and its use;
 * opens add O_NOFOLLOW and fstat checks on the opened descriptors, so the check binds to what was opened.
 */
export interface TrustOptions { /** Test seam for ownership checks; defaults to process.getuid(). */ uid?: number }
export interface PrivateWriteOptions extends TrustOptions { rename?: typeof renameSync }

const expectedUid = (options: TrustOptions) => options.uid ?? process.getuid?.();

function checkMeta(path: string, st: Stats, options: TrustOptions): void {
  const uid = expectedUid(options);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} must be owned by you (uid ${uid}); it is owned by uid ${st.uid}`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${path} is writable by others (mode ${(st.mode & 0o777).toString(8)}); runner-owned files and folders must be writable only by you`);
}

export function refuseSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path}: runner-owned files refuse symlinks`);
}

/** An existing folder that is ours, not a symlink, and writable by nobody else. */
export function checkTrustedDir(path: string, options: TrustOptions = {}): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path}: runner-owned folders refuse symlinks`);
  if (!st.isDirectory()) throw new Error(`${path} must be a folder`);
  checkMeta(path, st, options);
}

/** Every entry under root is a real folder or regular file, ours, and writable by nobody else. */
export function checkTrustedTree(root: string, options: TrustOptions = {}): void {
  checkTrustedDir(root, options);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`${path}: runner-owned trees refuse symlinks`);
    if (st.isDirectory()) checkTrustedTree(path, options);
    else if (st.isFile()) checkMeta(path, st, options);
    else throw new Error(`${path} must be a regular file or folder`);
  }
}

/** Creates the folder (0700) if missing, then requires it to be trusted. Its parent must exist. */
export function privateDir(path: string, options: TrustOptions = {}): string {
  refuseSymlink(path);
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
  checkTrustedDir(path, options);
  return path;
}

/** Reads a regular file without following a final symlink, checked on the opened descriptor. */
export function readNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} must be a regular file`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Writes a temp file beside the target (0600, O_EXCL|O_NOFOLLOW), fsyncs it, renames it over the target and fsyncs the folder. */
export function writePrivateAtomic(path: string, content: string, options: PrivateWriteOptions = {}): void {
  const directory = dirname(path);
  checkTrustedDir(directory, options);
  refuseSymlink(path);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error(`${path} must be a regular file`);
  const checked = lstatSync(directory);
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const temp = join(directory, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const dirSt = fstatSync(dirFd);
    if (dirSt.dev !== checked.dev || dirSt.ino !== checked.ino) throw new Error(`${directory} changed while it was being checked`);
    checkMeta(directory, dirSt, options);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) throw new Error(`${temp} is not a fresh private file`);
      writeAll(fd, content);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    refuseSymlink(path);
    (options.rename ?? renameSync)(temp, path);
    const after = lstatSync(directory);
    if (after.dev !== checked.dev || after.ino !== checked.ino) throw new Error(`${directory} was replaced during the write`);
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
    rmSync(temp, { force: true });
  }
}
