import { brotliDecompressSync, inflateSync } from "node:zlib";

/**
 * Images and fonts, read only as far as needed to tell their pixel and glyph payload from everything else
 * (Codex review of decision 79's narrowing: a key in a PNG tEXt chunk, or UTF-16 PEM in an image, passed).
 * Text chunks, EXIF and XMP, comments, font name tables, unknown chunks and bytes outside the structure all
 * reach the scanner; only pixel data, palettes and glyph tables are exempt. Nothing is rendered or executed.
 */

interface MediaParts {
  /** Byte ranges [start, end) the parser understood: structure, pixels and glyphs. Not scanned raw. */
  parsed: [number, number][];
  /** Every understood non-pixel, non-glyph payload, decompressed where it was compressed. */
  payloads: Buffer[];
}

/** Font tables that hold glyph outlines, bitmaps and metrics, not text. */
const GLYPH_TABLES = new Set(["glyf", "loca", "CFF ", "CFF2", "gvar", "hmtx", "vmtx", "hdmx", "EBDT", "EBLC", "CBDT", "CBLC", "sbix"]);

/** Shortest printable run extracted from binary bytes (a padded "u:pw" login is 8 characters). */
const MIN_RUN = 8;

class Budget {
  remaining: number;
  constructor(remaining: number) {
    this.remaining = remaining;
  }
  /** Bounded decompression: undefined if the data doesn't decompress; past the budget, this throws. */
  decompress(data: Buffer, brotli = false): Buffer | undefined {
    try {
      const out = (brotli ? brotliDecompressSync : inflateSync)(data, { maxOutputLength: Math.max(1, this.remaining) });
      this.remaining -= out.length;
      return out;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new Error("expanded byte limit");
      return undefined;
    }
  }
}

function png(buf: Buffer, budget: Budget, parts: MediaParts): void {
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const end = at + 8 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end + 4 > buf.length) return;
    parts.parsed.push([at, end + 4]);
    const data = buf.subarray(at + 8, end);
    if (type === "zTXt" || type === "iCCP" || type === "iTXt") {
      // keyword\0 then (zTXt, iCCP) method and zlib data, or (iTXt) flag, method, language\0, keyword\0, text.
      const k = data.indexOf(0);
      let body = k + 2;
      let compressed = type !== "iTXt";
      if (type === "iTXt" && k >= 0) {
        compressed = data[k + 1] === 1;
        const language = data.indexOf(0, k + 3);
        body = language < 0 ? 0 : data.indexOf(0, language + 1) + 1;
      }
      const text = k >= 0 && body > 0 && compressed ? budget.decompress(data.subarray(body)) : undefined;
      parts.payloads.push(text ? Buffer.concat([data.subarray(0, body), Buffer.from("\n"), text]) : data);
    } else if (type !== "IDAT" && type !== "fdAT" && type !== "PLTE") parts.payloads.push(data);
    at = end + 4;
    if (type === "IEND") return;
  }
}

function jpeg(buf: Buffer, parts: MediaParts): void {
  parts.parsed.push([0, 2]);
  for (let at = 2; at + 2 <= buf.length && buf[at] === 0xff; ) {
    const marker = buf[at + 1]!;
    if (marker === 0xff) {
      parts.parsed.push([at, at + 1]);
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      parts.parsed.push([at, at + 2]);
      if (marker === 0xd9) return;
      at += 2;
      continue;
    }
    if (at + 4 > buf.length) return;
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buf.length) return;
    parts.parsed.push([at, at + 2 + length]);
    parts.payloads.push(buf.subarray(at + 4, at + 2 + length));
    at += 2 + length;
    if (marker !== 0xda) continue;
    // Entropy-coded scan data runs to the next marker that is neither a stuffed 0xff00 nor a restart.
    const start = at;
    for (;;) {
      at = buf.indexOf(0xff, at);
      if (at < 0 || at + 1 >= buf.length) return void parts.parsed.push([start, buf.length]);
      const next = buf[at + 1]!;
      if (next !== 0 && !(next >= 0xd0 && next <= 0xd7)) break;
      at += 2;
    }
    parts.parsed.push([start, at]);
  }
}

/** A GIF sub-block chain from `at`: its data without length bytes, and the offset after its terminator. */
function subBlocks(buf: Buffer, at: number): { data: Buffer; end: number } | undefined {
  const data: Buffer[] = [];
  while (at < buf.length) {
    const n = buf[at]!;
    if (n === 0) return { data: Buffer.concat(data), end: at + 1 };
    if (at + 1 + n > buf.length) return undefined;
    data.push(buf.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
  return undefined;
}

function gif(buf: Buffer, parts: MediaParts): void {
  const palette = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  if (buf.length < 13) return;
  let at = 13 + palette(buf[10]!);
  parts.parsed.push([0, at]);
  while (at < buf.length) {
    const b = buf[at];
    if (b === 0x3b) return void parts.parsed.push([at, at + 1]);
    if (b === 0x21 && at + 2 <= buf.length) {
      // Extensions (comments, application data, plain text) are scanned without their length bytes, so
      // text split across sub-blocks reads as one.
      const chain = subBlocks(buf, at + 2);
      if (!chain) return;
      parts.parsed.push([at, chain.end]);
      parts.payloads.push(chain.data);
      at = chain.end;
    } else if (b === 0x2c && at + 10 <= buf.length) {
      const chain = subBlocks(buf, at + 11 + palette(buf[at + 9]!));
      if (!chain) return;
      parts.parsed.push([at, chain.end]);
      at = chain.end;
    } else return;
  }
}

/** RIFF chunks of a WebP file: VP8, VP8L and ALPH frames are pixels; ANMF frames hold more chunks. */
function riff(buf: Buffer, at: number, end: number, parts: MediaParts): void {
  while (at + 8 <= end) {
    const id = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > end) return;
    parts.parsed.push([at, Math.min(end, start + size + (size & 1))]);
    if (id === "ANMF" && size >= 16) {
      parts.payloads.push(buf.subarray(start, start + 16));
      riff(buf, start + 16, start + size, parts);
    } else if (id !== "VP8 " && id !== "VP8L" && id !== "ALPH") parts.payloads.push(buf.subarray(start, start + size));
    at = start + size + (size & 1);
  }
}

/** An sfnt table directory at `base` (TrueType, OpenType, one font of a collection). */
function sfnt(buf: Buffer, base: number, parts: MediaParts): void {
  if (base + 12 > buf.length) return;
  const count = buf.readUInt16BE(base + 4);
  if (base + 12 + 16 * count > buf.length) return;
  parts.parsed.push([base, base + 12 + 16 * count]);
  for (let i = 0; i < count; i++) {
    const entry = base + 12 + 16 * i;
    const offset = buf.readUInt32BE(entry + 8);
    const length = buf.readUInt32BE(entry + 12);
    if (offset + length > buf.length) continue;
    parts.parsed.push([offset, offset + length]);
    if (!GLYPH_TABLES.has(buf.toString("latin1", entry, entry + 4))) parts.payloads.push(buf.subarray(offset, offset + length));
  }
}

function woff(buf: Buffer, budget: Budget, parts: MediaParts): void {
  if (buf.length < 44) return;
  const count = buf.readUInt16BE(12);
  if (44 + 20 * count > buf.length) return;
  parts.parsed.push([0, 44 + 20 * count]);
  for (let i = 0; i < count; i++) {
    const entry = 44 + 20 * i;
    const offset = buf.readUInt32BE(entry + 4);
    const length = buf.readUInt32BE(entry + 8);
    if (offset + length > buf.length) continue;
    const data = buf.subarray(offset, offset + length);
    // A table shorter than its original length is zlib data; one that doesn't inflate is scanned raw.
    const table = length < buf.readUInt32BE(entry + 12) ? budget.decompress(data) : data;
    if (!table) continue;
    parts.parsed.push([offset, offset + length]);
    if (!GLYPH_TABLES.has(buf.toString("latin1", entry, entry + 4))) parts.payloads.push(table);
  }
}

/** WOFF2's known table tags, by their 6-bit index in a table directory entry. */
const WOFF2_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".match(/.{4} ?/g)!.map((t) => t.slice(0, 4));

/** WOFF2: one Brotli stream holding every table, in directory order. Collections are scanned whole. */
function woff2(buf: Buffer, budget: Budget, parts: MediaParts): void {
  if (buf.length < 48 || buf.toString("latin1", 4, 8) === "ttcf") return;
  let at = 48;
  const base128 = () => {
    let n = 0;
    for (let i = 0; i < 5 && at < buf.length; i++) {
      const b = buf[at++]!;
      n = n * 128 + (b & 0x7f);
      if (!(b & 0x80)) return n;
    }
    return -1;
  };
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0, count = buf.readUInt16BE(12); i < count; i++) {
    if (at >= buf.length) return;
    const flags = buf[at++]!;
    let tag = WOFF2_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 0x3f) {
      tag = buf.toString("latin1", at, at + 4);
      at += 4;
    }
    const version = flags >> 6;
    const original = base128();
    // glyf and loca are transformed at version 0; every other table at any version but 0.
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    const length = transformed ? base128() : original;
    if (tag === undefined || original < 0 || length < 0) return;
    tables.push({ tag, length });
  }
  const end = at + buf.readUInt32BE(20);
  if (end > buf.length) return;
  const stream = budget.decompress(buf.subarray(at, end), true);
  if (!stream) return;
  parts.parsed.push([0, end]);
  let offset = 0;
  for (const t of tables) {
    if (!GLYPH_TABLES.has(t.tag)) parts.payloads.push(stream.subarray(offset, offset + t.length));
    offset += t.length;
  }
  if (offset < stream.length) parts.payloads.push(stream.subarray(offset));
}

/** Printable ASCII, UTF-16LE and UTF-16BE runs of binary bytes. */
function printableRuns(buf: Buffer): string[] {
  const latin1 = buf.toString("latin1");
  const runs = [...latin1.matchAll(new RegExp(`[\\x20-\\x7e\\t\\r\\n]{${MIN_RUN},}`, "g"))].map((m) => m[0]);
  for (const re of [new RegExp(`(?:[\\x20-\\x7e\\t\\r\\n]\\x00){${MIN_RUN},}`, "g"), new RegExp(`(?:\\x00[\\x20-\\x7e\\t\\r\\n]){${MIN_RUN},}`, "g")]) {
    for (const m of latin1.matchAll(re)) runs.push(m[0].replace(/\x00/g, ""));
  }
  return runs;
}

/**
 * The text of an image or font for the scanner, one printable run per line: of every payload but pixels
 * and glyphs (decompressed text chunks and font tables included), and of every byte the parser didn't
 * understand. A file whose structure stops parsing is exempt only as far as it parsed. Decompression is
 * bounded by maxBytes; past it, this throws.
 */
export function mediaText(buf: Buffer, maxBytes: number): string {
  const parts: MediaParts = { parsed: [], payloads: [] };
  const budget = new Budget(maxBytes);
  const head = buf.toString("latin1", 0, 4);
  if (head === "\x89PNG") {
    parts.parsed.push([0, 8]);
    png(buf, budget, parts);
  } else if (buf[0] === 0xff && buf[1] === 0xd8) jpeg(buf, parts);
  else if (head === "GIF8") gif(buf, parts);
  else if (head === "RIFF" && buf.length >= 12) {
    parts.parsed.push([0, 12]);
    riff(buf, 12, Math.min(buf.length, 8 + buf.readUInt32LE(4)), parts);
  } else if (head === "wOFF") woff(buf, budget, parts);
  else if (head === "wOF2") woff2(buf, budget, parts);
  else if (head === "ttcf" && buf.length >= 12) {
    const count = buf.readUInt32BE(8);
    if (12 + 4 * count <= buf.length) {
      parts.parsed.push([0, 12 + 4 * count]);
      for (let i = 0; i < count; i++) sfnt(buf, buf.readUInt32BE(12 + 4 * i), parts);
    }
  } else sfnt(buf, 0, parts);
  const unparsed: Buffer[] = [];
  let at = 0;
  for (const [start, end] of parts.parsed.sort((a, b) => a[0] - b[0])) {
    if (start > at) unparsed.push(buf.subarray(at, start));
    at = Math.max(at, end);
  }
  if (at < buf.length) unparsed.push(buf.subarray(at));
  return [...parts.payloads, ...unparsed].flatMap(printableRuns).join("\n");
}
