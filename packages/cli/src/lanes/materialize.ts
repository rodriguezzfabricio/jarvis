import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const insideTree = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)); };
export const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export interface MaterializeFs {
  openSync(path: string, flags: number): number;
  closeSync(fd: number): void;
  fstatSync(fd: number): Stats;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  realpathSync(path: string): string;
  statSync(path: string): Stats;
}
/** Runner-controlled limits, an optional approved source boundary, and test seams. */
export interface MaterializeOptions { maxBytes?: number; maxFiles?: number; sourceRoot?: string; fs?: Partial<MaterializeFs>; platform?: NodeJS.Platform }
interface CopyBudget { bytes: number; files: number; maxBytes: number; maxFiles: number }
interface CopyContext { root: string; io: MaterializeFs; budget: CopyBudget; flags: number; platform: NodeJS.Platform }
const DARWIN_NOFOLLOW_ANY = 0x20000000; // O_NOFOLLOW_ANY in sys/fcntl.h.
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const regularFile = (stat: Stats): boolean => stat.isFile();
const validLimit = (value: number) => Number.isSafeInteger(value) && value > 0;

function sourceFlags(platform: NodeJS.Platform): number {
  if (platform !== "darwin" && platform !== "linux") throw new Error("unsupported secure bundle copy platform");
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

/** Darwin rejects combining the two no-follow flags. Bind the data fd to a second, fully checked open. */
function verifyDarwinPath(real: string, opened: Stats, io: MaterializeFs): void {
  const proof = io.openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_NOFOLLOW_ANY);
  try {
    const bound = io.fstatSync(proof);
    if (!regularFile(bound) || !sameFile(opened, bound)) throw new Error("bundle source changed during path verification");
  } finally { io.closeSync(proof); }
}

function chargeBytes(budget: CopyBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.maxBytes - budget.bytes) throw new Error("bundle byte limit exceeded");
}

function sourcePath(root: string, from: string, io: MaterializeFs): string {
  const real = io.realpathSync(from);
  if (!insideTree(root, real)) throw new Error("bundle source escapes its tree");
  return real;
}

function writeChunk(fd: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    const written = writeSync(fd, buffer, offset, length - offset);
    if (written <= 0) throw new Error("bundle copy made no progress");
    offset += written;
  }
}

/** Read only the verified descriptor; O_NONBLOCK keeps a raced FIFO from blocking at open. */
function copyRegular(real: string, to: string, expected: Stats, context: CopyContext): string {
  const { root, io, budget, flags, platform } = context;
  const fd = io.openSync(real, flags);
  try {
    const opened = io.fstatSync(fd);
    if (!regularFile(opened)) throw new Error("bundle descriptor must be a regular file");
    if (!sameFile(expected, opened)) throw new Error("bundle source changed before open");
    if (platform === "darwin") verifyDarwinPath(real, opened, io);
    if (platform === "linux") sourcePath(root, `/proc/self/fd/${fd}`, io);
    const current = sourcePath(root, real, io);
    if (current !== real || !sameFile(opened, io.statSync(current))) throw new Error("bundle source changed after open");
    chargeBytes(budget, opened.size);
    const output = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let position = 0;
      for (;;) {
        const bytes = io.readSync(fd, buffer, 0, buffer.length, position);
        if (bytes === 0) break;
        chargeBytes(budget, bytes); budget.bytes += bytes;
        writeChunk(output, buffer, bytes); hash.update(buffer.subarray(0, bytes)); position += bytes;
      }
      const after = io.fstatSync(fd);
      if (!sameFile(opened, after) || position !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error("bundle source changed during copy");
      fchmodSync(output, opened.mode & 0o777);
      return hash.digest("hex");
    } finally { closeSync(output); }
  } finally { io.closeSync(fd); }
}

/** Internal aliases become independent files. maxFiles counts all entries below the root, including directories and expanded aliases. */
export function materializeTree(source: string, destination: string, options: MaterializeOptions = {}): Record<string, string> {
  const budget: CopyBudget = { bytes: 0, files: 0, maxBytes: options.maxBytes ?? 2 * 1024 ** 3, maxFiles: options.maxFiles ?? 200_000 };
  if (!validLimit(budget.maxBytes) || !validLimit(budget.maxFiles)) throw new Error("bundle limits must be positive safe integers");
  const io: MaterializeFs = { openSync, closeSync, fstatSync, readSync, realpathSync, statSync, ...options.fs };
  const platform = options.platform ?? process.platform; const flags = sourceFlags(platform);
  const root = io.realpathSync(source); const approvedRoot = options.sourceRoot === undefined ? root : io.realpathSync(options.sourceRoot);
  if (!insideTree(approvedRoot, root)) throw new Error("bundle source root escapes its approved tree");
  const target = join(realpathSync(dirname(resolve(destination))), basename(destination));
  if (!io.statSync(root).isDirectory() || existsSync(target) || insideTree(root, target)) throw new Error("invalid materialization destination");
  const files: Record<string, string> = Object.create(null) as Record<string, string>; const directories: string[] = [];
  const context: CopyContext = { root, io, budget, flags, platform };
  const walk = (from: string, to: string, parents: Set<string>) => {
    if (to !== target && ++budget.files > budget.maxFiles) throw new Error("bundle file limit exceeded");
    const real = sourcePath(root, from, io);
    const stat = io.statSync(real);
    if (stat.isDirectory()) {
      if (parents.has(real)) throw new Error("cyclic bundle source link");
      mkdirSync(to, { mode: 0o700 }); directories.push(to);
      for (const name of readdirSync(real)) walk(join(real, name), join(to, name), new Set([...parents, real]));
      chmodSync(to, stat.mode & 0o777);
    } else {
      if (!stat.isFile()) throw new Error("bundle contains a special file");
      files[relative(target, to)] = copyRegular(real, to, stat, context);
    }
  };
  try { walk(root, target, new Set()); return files; }
  catch (error) {
    for (const dir of directories) chmodSync(dir, 0o700);
    rmSync(target, { recursive: true, force: true }); throw error;
  }
}

export function assertNoBundleLinks(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("installed bundles must be symlink-free");
    if (stat.isDirectory()) assertNoBundleLinks(path);
    else if (!stat.isFile()) throw new Error("installed bundle contains a special file");
  }
}
