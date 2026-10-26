import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { coveredFiles, mappedSemgrepExtension } from "./coverage.ts";

export const MAX_MAPPED_FILES = 4096;
export const MAX_MAPPED_BYTES = 64 * 1024 * 1024;
export interface MappedSemgrepTree {
  cwd: string;
  /** Absolute temporary path -> original checkout-relative path. */
  originals: ReadonlyMap<string, string>;
}

interface Source { absolute: string; dev: number; ino: number }

function sourcePath(root: string, path: string): Source {
  let absolute = root; let dev = 0; let ino = 0;
  const parts = path.split(sep);
  for (const [index, part] of parts.entries()) {
    if (!part || part === "." || part === "..") throw Error("Invalid mapped source path");
    absolute = join(absolute, part);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error("Mapped source may not be a link");
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw Error("Mapped source must be regular");
    dev = stat.dev; ino = stat.ino;
  }
  return { absolute, dev, ino };
}

function copyBounded(source: Source, target: string, remaining: number): number {
  const fd = openSync(source.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error("Mapped source must be regular");
    // O_NOFOLLOW covers only the last component; a parent swapped for a link opens a different file.
    if (stat.dev !== source.dev || stat.ino !== source.ino) throw Error("Mapped source changed before copy");
    if (stat.size > remaining) throw Error("Mapped byte limit");
    // One extra byte detects growth after stat without an unbounded read/allocation.
    const buffer = Buffer.alloc(stat.size + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (n === 0) break;
      bytes += n;
    }
    if (bytes !== stat.size) throw Error("Mapped source changed during copy");
    writeFileSync(target, buffer.subarray(0, bytes), { mode: 0o600, flag: "wx" });
    return bytes;
  } finally { closeSync(fd); }
}

/** Flat, unique names avoid candidate path collisions and ignore/config files. Always remove the tree. */
export async function withMappedSemgrep<T>(root: string, scanned: readonly string[], tmpDir: string, run: (tree: MappedSemgrepTree) => Promise<T>): Promise<T | undefined> {
  const reported = new Set(scanned.map((path) => resolve(root, path)));
  const files = coveredFiles(root).filter((path) => !reported.has(resolve(root, path))).flatMap((path) => {
    const extension = mappedSemgrepExtension(sourcePath(root, path).absolute);
    return extension ? [{ path, extension }] : [];
  });
  if (files.length === 0) return undefined;
  if (files.length > MAX_MAPPED_FILES) throw Error("Mapped file limit");
  const cwd = mkdtempSync(join(tmpDir, "semgrep-mapped-"));
  try {
    let bytes = 0; const originals = new Map<string, string>();
    for (const [index, file] of files.entries()) {
      const target = join(cwd, `${index}${file.extension}`);
      bytes += copyBounded(sourcePath(root, file.path), target, MAX_MAPPED_BYTES - bytes);
      originals.set(resolve(target), file.path);
    }
    return await run({ cwd, originals });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
