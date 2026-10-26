import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

/**
 * A bounded zip reader for fixture archives the runner unpacks outside any sandbox (decision 123; Codex security
 * review of dd0923f..a299593, highs 1 and 2). No subprocess, so no inherited UNZIP/UNZIPOPT can change what is
 * written. Every entry is listed and checked before anything is written: its path stays inside one folder, it
 * is a plain file or folder, and the archive's size, entry count and declared expansion are within limits.
 * While unpacking, each entry inflates to at most its declared size and the output budget left, must match its
 * CRC-32, and the whole unpack has a deadline. Every refusal starts with "refused:".
 */

export interface ZipLimits {
  maxZipBytes: number;
  maxEntries: number;
  /** Declared and actual expanded bytes, all entries together. */
  maxTotalBytes: number;
  timeoutMs: number;
}

interface Entry { name: string; dir: boolean; executable: boolean; method: number; crc: number; compressedSize: number; size: number; dataStart: number }
export interface ZipListing { entries: Entry[]; totalBytes: number; data: Buffer }

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;
const refuse = (why: string): never => { throw new Error(`refused: the toolchain zip ${why}`); };

/** Reads at most `limits.maxZipBytes` of the archive at `zipPath` and checks every entry against `within` (a relative folder). */
export function listZip(zipPath: string, within: string, limits: ZipLimits): ZipListing {
  const fd = openSync(zipPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const size = fstatSync(fd).size;
    if (size > limits.maxZipBytes) refuse(`is larger than ${limits.maxZipBytes} bytes (${size})`);
    data = Buffer.alloc(size);
    for (let at = 0; at < size;) { const n = readSync(fd, data, at, size - at, at); if (n === 0) refuse("shrank while it was read"); at += n; }
  } finally { closeSync(fd); }

  // End of central directory: the last record, with no zip64, spanning or trailing bytes.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) if (data.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0 || eocd + 22 + data.readUInt16LE(eocd + 20) !== data.length) refuse("has no end-of-archive record");
  const count = data.readUInt16LE(eocd + 10), cdSize = data.readUInt32LE(eocd + 12), cdOffset = data.readUInt32LE(eocd + 16);
  if (data.readUInt16LE(eocd + 4) !== 0 || data.readUInt16LE(eocd + 6) !== 0 || data.readUInt16LE(eocd + 8) !== count) refuse("spans several disks");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) refuse("uses zip64, which a toolchain module doesn't need");
  if (count > limits.maxEntries) refuse(`has ${count} entries, more than its ${limits.maxEntries} limit`);
  if (cdOffset + cdSize !== eocd) refuse("has a central directory out of place");

  const entries: Entry[] = [];
  const seen = new Set<string>(), files = new Set<string>(), folders = new Set<string>();
  let totalBytes = 0;
  for (let i = 0, at = cdOffset; i < count; i++) {
    if (at + 46 > eocd || data.readUInt32LE(at) !== CENTRAL) refuse(`has a damaged central directory at entry ${i}`);
    const madeBy = data.readUInt16LE(at + 4) >> 8, flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16), compressedSize = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLen = data.readUInt16LE(at + 28), next = at + 46 + nameLen + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    const external = data.readUInt32LE(at + 38), localOffset = data.readUInt32LE(at + 42);
    if (next > eocd) refuse(`has a damaged central directory at entry ${i}`);
    const rawName = data.subarray(at + 46, at + 46 + nameLen);
    const name = rawName.toString("utf8");
    at = next;

    // The path: valid UTF-8, no control characters or backslashes, no empty, "." or ".." segment (so no
    // absolute path and no climbing out), and inside `within`.
    if (!Buffer.from(name, "utf8").equals(rawName) || /[\u0000-\u001f\u007f\\]/.test(name)) refuse(`has an unsafe path: ${JSON.stringify(name)}`);
    const dir = name.endsWith("/");
    const body = dir ? name.slice(0, -1) : name;
    if (body.split("/").some((s) => s === "" || s === "." || s === "..")) refuse(`has an unsafe path: ${JSON.stringify(name)}`);
    if (!body.startsWith(`${within}/`) && !(dir && body === within)) refuse(`has an entry outside ${within}: ${JSON.stringify(name)}`);
    // The type: a plain file or folder (a link would point the session somewhere else).
    const mode = madeBy === 3 ? external >>> 16 : 0;
    const type = mode & S_IFMT;
    if ((type !== 0 && type !== S_IFREG && type !== S_IFDIR) || (dir && type === S_IFREG) || (!dir && type === S_IFDIR)) refuse(`has a link or special file: ${JSON.stringify(name)}`);
    if (flags & 0x1) refuse(`has an encrypted entry: ${JSON.stringify(name)}`);
    if (method !== 0 && method !== 8) refuse(`has an entry with compression method ${method}: ${JSON.stringify(name)}`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) refuse("uses zip64, which a toolchain module doesn't need");
    if ((method === 0 && compressedSize !== size) || (dir && size !== 0)) refuse(`has inconsistent sizes for ${JSON.stringify(name)}`);
    // Names fold case on this Mac's disk: two names that differ only by case, or a file where a folder goes, collide.
    const key = body.toLowerCase();
    if (seen.has(key)) refuse(`has the same path twice: ${JSON.stringify(name)}`);
    seen.add(key);
    const parents = body.split("/").slice(0, -1).map((_, k, a) => a.slice(0, k + 1).join("/").toLowerCase());
    if ((!dir && folders.has(key)) || parents.some((p) => files.has(p))) refuse(`has a file where a folder goes: ${JSON.stringify(name)}`);
    (dir ? folders : files).add(key);
    for (const p of parents) folders.add(p);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) refuse(`declares ${totalBytes} or more bytes, more than its ${limits.maxTotalBytes}-byte limit`);

    // The data, from the local header: the same name, and wholly before the central directory.
    if (localOffset + 30 > cdOffset || data.readUInt32LE(localOffset) !== LOCAL) refuse(`has a damaged local header for ${JSON.stringify(name)}`);
    const localNameLen = data.readUInt16LE(localOffset + 26);
    if (!data.subarray(localOffset + 30, localOffset + 30 + localNameLen).equals(rawName)) refuse(`has a local name that differs from its directory's: ${JSON.stringify(name)}`);
    const dataStart = localOffset + 30 + localNameLen + data.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > cdOffset) refuse(`has data past the archive for ${JSON.stringify(name)}`);
    entries.push({ name, dir, executable: (mode & 0o111) !== 0, method, crc, compressedSize, size, dataStart });
  }
  // Entries that share data can't expand past the limit either: every entry inflates to its declared size at
  // most, and the declared sizes together are bounded above.
  return { entries, totalBytes, data };
}

/**
 * Writes a checked listing into `dest`, a fresh folder the caller made, file by file, never through a link
 * (O_EXCL | O_NOFOLLOW). A refusal leaves a partial folder: the caller removes it.
 */
export function extractZip(listing: ZipListing, dest: string, limits: ZipLimits, now: () => number): { files: number; bytes: number } {
  const deadline = now() + limits.timeoutMs;
  let written = 0, files = 0;
  const made = new Set<string>();
  const folder = (p: string) => { if (!made.has(p)) { mkdirSync(p, { recursive: true, mode: 0o755 }); made.add(p); } };
  for (const e of listing.entries) {
    if (now() > deadline) throw new Error(`refused: unpacking the toolchain zip took longer than ${limits.timeoutMs} ms`);
    const path = join(dest, e.name);
    if (e.dir) { folder(path); continue; }
    const raw = listing.data.subarray(e.dataStart, e.dataStart + e.compressedSize);
    let out: Buffer;
    if (e.method === 0) out = raw;
    else {
      // The output budget: never more than the entry declared, nor than what is left of the whole.
      try { out = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(e.size, limits.maxTotalBytes - written)) }); } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") refuse(`entry ${e.name} expands past its declared size`);
        throw err;
      }
    }
    if (out.length !== e.size) refuse(`entry ${e.name} is shorter than its declared size`);
    if ((crc32(out) >>> 0) !== e.crc) refuse(`entry ${e.name} fails its checksum`);
    written += out.length;
    folder(dirname(path));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, e.executable ? 0o755 : 0o644);
    try { for (let at = 0; at < out.length;) at += writeSync(fd, out, at, out.length - at); } finally { closeSync(fd); }
    files++;
  }
  return { files, bytes: written };
}
