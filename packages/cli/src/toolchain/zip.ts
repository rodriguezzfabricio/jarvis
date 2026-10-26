import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

/**
 * A bounded zip reader for the toolchain zip the runner unpacks outside any sandbox (decision 123; Codex security
 * reviews of dd0923f..a299593 and e13ca2a). It runs in its own process (zip-worker.ts), which the runner kills at
 * the deadline, with a capped heap and no inherited environment. The bytes must hash to the pinned SHA-256 before
 * any is parsed. Then every entry is checked before anything is written: its name's length, depth and the names'
 * total are bounded before any string is built from it; its path stays inside one folder; it is a plain file or
 * folder; no two paths are one on this Mac's disk (case and Unicode normalization fold); and the archive's size,
 * entry count and declared expansion are within limits. Each entry inflates to at most its declared size and the
 * budget left, and must match its CRC-32. Every refusal starts with "refused:".
 */

export interface ZipLimits {
  maxZipBytes: number;
  maxEntries: number;
  /** Declared and actual expanded bytes, all entries together. */
  maxTotalBytes: number;
  /** One name, in bytes. */
  maxNameBytes: number;
  /** Folders in one path. */
  maxDepth: number;
  /** All names together, in bytes. */
  maxTotalNameBytes: number;
  /** The unpack process is killed at this deadline (go.ts). */
  timeoutMs: number;
  /** The unpack process's V8 heap (go.ts). */
  maxHeapMb: number;
}

interface Entry { name: string; dir: boolean; executable: boolean; method: number; crc: number; compressedSize: number; size: number; dataStart: number }
interface Listing { entries: Entry[]; data: Buffer }

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50, SLASH = 0x2f;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;
const refuse = (why: string): never => { throw new Error(`refused: the toolchain zip ${why}`); };

/** Reads the archive (at most `maxZipBytes`, never through a link) and checks it is the pinned one. */
function readPinned(zipPath: string, sha256: string, limits: ZipLimits): Buffer {
  const fd = openSync(zipPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse("is not a plain file");
    if (st.size > limits.maxZipBytes) refuse(`is larger than ${limits.maxZipBytes} bytes (${st.size})`);
    const data = Buffer.alloc(st.size);
    for (let at = 0; at < st.size;) { const n = readSync(fd, data, at, st.size - at, at); if (n === 0) refuse("shrank while it was read"); at += n; }
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== sha256) refuse(`is not the pinned one (sha256 ${actual}, pinned ${sha256})`);
    return data;
  } finally { closeSync(fd); }
}

/** Checks every entry of the pinned archive against `within` (a relative folder) before anything is written. */
function listZip(data: Buffer, within: string, limits: ZipLimits): Listing {
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
  /** Collision keys: the path, Unicode-decomposed and case-folded as this Mac's disk compares names, "/" as "\0". */
  const keys: { key: string; dir: boolean; name: string }[] = [];
  let totalBytes = 0, nameBytes = 0;
  for (let i = 0, at = cdOffset; i < count; i++) {
    if (at + 46 > eocd || data.readUInt32LE(at) !== CENTRAL) refuse(`has a damaged central directory at entry ${i}`);
    const madeBy = data.readUInt16LE(at + 4) >> 8, flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16), compressedSize = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLen = data.readUInt16LE(at + 28), next = at + 46 + nameLen + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    const external = data.readUInt32LE(at + 38), localOffset = data.readUInt32LE(at + 42);
    if (next > eocd) refuse(`has a damaged central directory at entry ${i}`);
    // Bounded before any string is built from the name: its length, its depth, and all names together.
    if (nameLen > limits.maxNameBytes) refuse(`has a name longer than ${limits.maxNameBytes} bytes (entry ${i}, ${nameLen} bytes)`);
    nameBytes += nameLen;
    if (nameBytes > limits.maxTotalNameBytes) refuse(`has names that add up to more than ${limits.maxTotalNameBytes} bytes`);
    const rawName = data.subarray(at + 46, at + 46 + nameLen);
    let slashes = 0;
    for (const b of rawName) if (b === SLASH) slashes++;
    if (slashes > limits.maxDepth) refuse(`has a path deeper than ${limits.maxDepth} folders (entry ${i})`);
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
    keys.push({ key: body.normalize("NFD").toLowerCase().normalize("NFD").replaceAll("/", "\u0000"), dir, name });
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
  // Collisions, in one sort (linear memory): equal keys are one path on disk; with "/" sorted as "\0", every path
  // inside a file's name follows it directly, so a file where a folder goes is the next key starting with it.
  keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let k = 1; k < keys.length; k++) {
    const prev = keys[k - 1]!, cur = keys[k]!;
    if (cur.key === prev.key) refuse(`has the same path twice: ${JSON.stringify(cur.name)}`);
    if (!prev.dir && cur.key.startsWith(`${prev.key}\u0000`)) refuse(`has a file where a folder goes: ${JSON.stringify(prev.name)}`);
  }
  // Entries that share data can't expand past the limit either: every entry inflates to its declared size at
  // most, and the declared sizes together are bounded above.
  return { entries, data };
}

/** Writes a checked listing into `dest`, a fresh folder the caller made, never through a link (O_EXCL | O_NOFOLLOW). */
function extractZip(listing: Listing, dest: string, limits: ZipLimits): { files: number; bytes: number } {
  let written = 0, files = 0;
  const made = new Set<string>();
  const folder = (p: string) => { if (!made.has(p)) { mkdirSync(p, { recursive: true, mode: 0o755 }); made.add(p); } };
  for (const e of listing.entries) {
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

/** The whole unpack, as the worker process runs it: pinned bytes, a checked listing, then the bounded writes. */
export function unpackZip(zipPath: string, dest: string, within: string, sha256: string, limits: ZipLimits): { files: number; bytes: number } {
  return extractZip(listZip(readPinned(zipPath, sha256, limits), within, limits), dest, limits);
}
