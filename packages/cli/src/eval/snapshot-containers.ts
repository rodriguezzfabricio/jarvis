import { isUtf8 } from "node:buffer";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

export interface ScanMember {
  name: string;
  data: Buffer;
}

/** DER lengths are definite, bounded and contained by their parent. No ASN.1 values are executed. */
function derParts(buf: Buffer, start: number, end: number): { tag: number; body: Buffer }[] {
  const parts: { tag: number; body: Buffer }[] = [];
  for (let i = start; i < end;) {
    const tag = buf[i++];
    let length = buf[i++];
    if (tag === undefined || length === undefined) return [];
    if (length & 0x80) {
      const bytes = length & 0x7f;
      if (bytes === 0 || bytes > 4 || i + bytes > end) return [];
      length = buf.readUIntBE(i, bytes);
      i += bytes;
    }
    if (i + length > end || parts.length > 32) return [];
    parts.push({ tag, body: buf.subarray(i, i + length) });
    i += length;
  }
  return parts;
}

/** Encrypted keys and credential containers require review even when their suffix looks harmless. */
export function credentialContainer(buf: Buffer): boolean {
  const text = buf.toString("latin1", 0, Math.min(buf.length, 4096));
  if (/^PuTTY-User-Key-File-[23]: ssh-/m.test(text) && /^Private-Lines: [1-9]\d*\r?$/m.test(text)) return true;
  if (buf[0] !== 0x30) return false;
  const root = derParts(buf, 0, buf.length);
  if (root.length !== 1 || root[0]!.tag !== 0x30) return false;
  const body = root[0]!.body;
  const parts = derParts(body, 0, body.length);
  const algorithm = parts[0];
  if (algorithm?.tag === 0x30 && parts[1]?.tag === 0x04) {
    const oid = derParts(algorithm.body, 0, algorithm.body.length)[0];
    // PKCS#5 PBES1/PBES2 or PKCS#12 PBE, followed by encrypted key bytes.
    if (oid?.tag === 0x06 && /^(2a864886f70d0105|2a864886f70d010c01)/.test(oid.body.toString("hex"))) return true;
  }
  if (parts[0]?.tag === 0x02 && parts[0].body.equals(Buffer.from([3])) && parts[1]?.tag === 0x30) {
    const oid = derParts(parts[1].body, 0, parts[1].body.length)[0];
    // PFX version 3 and a PKCS#7 ContentInfo (data, signedData or encryptedData).
    if (oid?.tag === 0x06 && /^2a864886f70d0107(?:01|02|06)$/.test(oid.body.toString("hex"))) return true;
  }
  return false;
}

function zipMembers(buf: Buffer, maxBytes: number): ScanMember[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("unsupported or truncated ZIP; needs review");
  const count = buf.readUInt16LE(end + 10);
  if (buf.readUInt32LE(end + 4) !== 0 || count === 0xffff || count > 1000) throw new Error("ZIP member limit or unsupported volume; needs review");
  let at = buf.readUInt32LE(end + 16);
  const out: ScanMember[] = [];
  let remaining = maxBytes;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== 0x02014b50) throw new Error("invalid ZIP directory; needs review");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    if (flags & 1) throw new Error("encrypted ZIP; needs review");
    if (size > remaining) throw new Error("expanded byte limit; needs review");
    if (at + 46 + nameLength > end || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("invalid ZIP member; needs review");
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw new Error("truncated ZIP member; needs review");
    const data = buf.subarray(start, start + compressed);
    let expanded: Buffer;
    if (method === 0) expanded = data;
    else if (method === 8) expanded = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) });
    else throw new Error("unsupported ZIP compression; needs review");
    if (expanded.length !== size) throw new Error("invalid ZIP member size; needs review");
    remaining -= expanded.length;
    out.push({ name, data: expanded });
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

function tarMembers(buf: Buffer, maxBytes: number): ScanMember[] {
  const out: ScanMember[] = [];
  let remaining = maxBytes;
  for (let at = 0; at + 512 <= buf.length; ) {
    const header = buf.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return out;
    const rawSize = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error("unsupported tar size; needs review");
    const size = Number.parseInt(rawSize, 8);
    const checksum = Number.parseInt(header.toString("ascii", 148, 156), 8);
    const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== sum || at + 512 + size > buf.length) throw new Error("invalid tar; needs review");
    if (size > remaining || out.length >= 1000) throw new Error("tar expanded byte or member limit; needs review");
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    out.push({ name, data: buf.subarray(at + 512, at + 512 + size) });
    remaining -= size;
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("truncated tar; needs review");
}

/** In-memory decoding only: member paths never reach the filesystem. maxBytes caps aggregate output. */
export function containerMembers(name: string, buf: Buffer, maxBytes: number): ScanMember[] | undefined {
  const opts = { maxOutputLength: Math.max(1, maxBytes) };
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return zipMembers(buf, maxBytes);
  if (buf.length >= 512 && buf.toString("ascii", 257, 262) === "ustar") return tarMembers(buf, maxBytes);
  let expanded: Buffer;
  if (buf[0] === 0x1f && buf[1] === 0x8b) expanded = gunzipSync(buf, opts);
  else if (buf.length > 2 && (buf[0]! & 0x0f) === 8 && (buf[0]! >>> 4) <= 7 && ((buf[0]! << 8) + buf[1]!) % 31 === 0) {
    try {
      expanded = inflateSync(buf, opts);
    } catch (e) {
      // A weak zlib header (notably "x ") occurs in ordinary source. Failed text probes stay text.
      if (isUtf8(buf) && (e as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") return undefined;
      throw e;
    }
  }
  else {
    // Brotli has no magic bytes. Probe binary data and .br files; an unsuccessful probe is ordinary data.
    if (isUtf8(buf) && !/\.br$/i.test(name)) return undefined;
    try {
      expanded = brotliDecompressSync(buf, opts);
    } catch (e) {
      if (/\.br$/i.test(name) || (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw e;
      return undefined;
    }
    if (!expanded.length) return undefined;
  }
  if (expanded.length > maxBytes) throw new Error("expanded byte limit; needs review");
  return [{ name: name.replace(/\.(gz|zlib|br)$/i, ""), data: expanded }];
}
