import { brotliDecompressSync, constants, crc32, inflateSync } from "node:zlib";

/**
 * Images and fonts, read only as far as needed to tell their pixel and glyph payload from everything else
 * (Codex review of decision 79's narrowing, rounds 1 and 2). Nothing is rendered or executed.
 *
 * A file earns an exemption only if its whole structure is well formed: a PNG starts with IHDR, every
 * chunk's CRC matches and its IDAT stream inflates to exactly the image's size; a JPEG, GIF or WebP parses
 * to its end marker; a font's every table lies inside the file, doesn't overlap another or the directory,
 * and every compressed table decompresses to its declared length. A malformed file gets no exemption: all
 * of its bytes are scanned as text, with what its compressed parts decode to as far as they go, wherever
 * the structure broke (recovered).
 *
 * Even then pixel data, palettes and glyph tables are only scanned for long printable runs (32 or more
 * characters), not exempt outright, as is the whole file; every other byte (text chunks, EXIF and XMP,
 * comments, font name tables, headers and directories, unknown chunks, trailing data) is scanned as text.
 */

interface MediaParts {
  /** Byte ranges [start, end) whose content is scanned through `text` or `pixels`, not raw. */
  covered: [number, number][];
  /** Content scanned for printable runs of MIN_RUN or more characters. */
  text: Buffer[];
  /** Pixel and glyph payload, scanned only for printable runs of MIN_PIXEL_RUN or more characters. */
  pixels: Buffer[];
}

/** Font tables that hold glyph outlines, bitmaps and metrics, not text. */
const GLYPH_TABLES = new Set(["glyf", "loca", "CFF ", "CFF2", "gvar", "hmtx", "vmtx", "hdmx", "EBDT", "EBLC", "CBDT", "CBLC", "sbix"]);

/** Shortest printable run extracted from binary bytes (a padded "u:pw" login is 8 characters). */
const MIN_RUN = 8;
/** Shortest printable run extracted from pixel and glyph payload: random bytes practically never make one. */
const MIN_PIXEL_RUN = 32;
/** Largest decoded image whose IDAT stream is inflated to check its size. */
const MAX_PIXEL_BYTES = 256 * 1024 * 1024;
/** Sane table counts: real fonts have a few dozen. */
const MAX_TABLES = 512;

class Budget {
  remaining: number;
  constructor(remaining: number) {
    this.remaining = remaining;
  }
  /** Bounded decompression that must use all of `data`: undefined if it doesn't; past the budget, this throws. */
  decompress(data: Buffer, brotli = false): Buffer | undefined {
    try {
      const options = { info: true, maxOutputLength: Math.max(1, this.remaining) };
      const r = (brotli ? brotliDecompressSync(data, options) : inflateSync(data, options)) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (r.engine.bytesWritten !== data.length) return undefined;
      this.remaining -= r.buffer.length;
      return r.buffer;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new Error("expanded byte limit");
      return undefined;
    }
  }
  /**
   * What `data` decompresses to as far as it goes, for scanning a malformed file: a truncated stream up to
   * its end, a damaged one up to the damage (its longest prefix that decodes), bytes after it ignored.
   * Bounded like decompress: past the budget, this throws.
   */
  salvage(data: Buffer, brotli = false): Buffer {
    const options = { maxOutputLength: Math.max(1, this.remaining), finishFlush: brotli ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH };
    const decode = (d: Buffer): Buffer | undefined => {
      try {
        return brotli ? brotliDecompressSync(d, options) : inflateSync(d, options);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new Error("expanded byte limit");
        return undefined;
      }
    };
    let out = decode(data);
    if (!out) {
      // A prefix decodes if and only if it ends before the damage: binary search for the longest one.
      out = Buffer.alloc(0);
      for (let lo = 1, hi = data.length - 1; lo <= hi; ) {
        const mid = (lo + hi) >> 1;
        const prefix = decode(data.subarray(0, mid));
        if (prefix) [out, lo] = [prefix, mid + 1];
        else hi = mid - 1;
      }
    }
    this.remaining -= out.length;
    return out;
  }
}

/** The byte length of a PNG's filtered image data, from its IHDR; undefined if the header is invalid. */
function pngImageBytes(ihdr: Buffer): number | undefined {
  const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
  const [depth, color, compression, filter, interlace] = [ihdr[8]!, ihdr[9]!, ihdr[10], ihdr[11], ihdr[12]!];
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) return undefined;
  const row = (w: number) => 1 + Math.ceil((w * channels[color]! * depth) / 8);
  if (interlace === 0) return height * row(width);
  // Adam7: seven passes, each a smaller image (x start, y start, x step, y step).
  let total = 0;
  for (const [xs, ys, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const) {
    const w = width > xs ? Math.ceil((width - xs) / dx) : 0;
    const h = height > ys ? Math.ceil((height - ys) / dy) : 0;
    if (w && h) total += h * row(w);
  }
  return total;
}

function png(buf: Buffer, budget: Budget, parts: MediaParts): boolean {
  let image: number | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; ; ) {
    if (at + 12 > buf.length) return false; // no IEND
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const end = at + 8 + length;
    if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type) || end + 4 > buf.length) return false;
    if (crc32(buf.subarray(at + 4, end)) !== buf.readUInt32BE(end)) return false;
    if (at === 8 && (type !== "IHDR" || length !== 13)) return false;
    const data = buf.subarray(at + 8, end);
    parts.covered.push([at + 8, end]);
    if (type === "IHDR") {
      if (at !== 8 || (image = pngImageBytes(data)) === undefined) return false;
    } else if (type === "IDAT") {
      idat.push(data);
      parts.pixels.push(data);
    } else if (type === "fdAT" || type === "PLTE") parts.pixels.push(data);
    else if (type === "zTXt" || type === "iCCP" || type === "iTXt") {
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
      if (compressed && !text) return false;
      parts.text.push(text ? Buffer.concat([data.subarray(0, body), Buffer.from("\n"), text]) : data);
    } else parts.text.push(data);
    at = end + 4;
    if (type === "IEND") break;
  }
  // The pixel stream inflates to exactly the image's size and nothing follows it. Otherwise what it does
  // inflate to is no image: it is scanned as text (recovered).
  if (idat.length === 0 || image === undefined || image > MAX_PIXEL_BYTES) return false;
  const stream = Buffer.concat(idat);
  try {
    const r = inflateSync(stream, { info: true, maxOutputLength: image + 1 }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return r.buffer.length === image && r.engine.bytesWritten === stream.length;
  } catch {
    return false;
  }
}

function jpeg(buf: Buffer, parts: MediaParts): boolean {
  for (let at = 2; at + 2 <= buf.length && buf[at] === 0xff; ) {
    const marker = buf[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9) return true;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (at + 4 > buf.length) return false;
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buf.length) return false;
    parts.covered.push([at + 4, at + 2 + length]);
    parts.text.push(buf.subarray(at + 4, at + 2 + length));
    at += 2 + length;
    if (marker !== 0xda) continue;
    // Entropy-coded scan data runs to the next marker that is neither a stuffed 0xff00 nor a restart.
    const start = at;
    for (;;) {
      at = buf.indexOf(0xff, at);
      if (at < 0 || at + 1 >= buf.length) return false;
      const next = buf[at + 1]!;
      if (next !== 0 && !(next >= 0xd0 && next <= 0xd7)) break;
      at += 2;
    }
    parts.covered.push([start, at]);
    parts.pixels.push(buf.subarray(start, at));
  }
  return false;
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

function gif(buf: Buffer, parts: MediaParts): boolean {
  const palette = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  if (buf.length < 13) return false;
  let at = 13 + palette(buf[10]!);
  if (at > buf.length) return false;
  parts.covered.push([13, at]);
  parts.pixels.push(buf.subarray(13, at));
  while (at < buf.length) {
    const b = buf[at];
    if (b === 0x3b) return true;
    // Sub-block data is scanned without its length bytes, so text split across sub-blocks reads as one.
    if (b === 0x21 && at + 2 <= buf.length) {
      const chain = subBlocks(buf, at + 2);
      if (!chain) return false;
      parts.covered.push([at + 2, chain.end]);
      parts.text.push(chain.data);
      at = chain.end;
    } else if (b === 0x2c && at + 11 <= buf.length) {
      const colors = palette(buf[at + 9]!);
      const data = at + 11 + colors;
      const chain = subBlocks(buf, data);
      if (!chain) return false;
      parts.covered.push([at + 10, chain.end]);
      parts.pixels.push(buf.subarray(at + 10, data - 1), chain.data);
      at = chain.end;
    } else return false;
  }
  return false;
}

/** RIFF chunks of a WebP file, to exactly `end`: VP8, VP8L and ALPH frames are pixels; ANMF frames hold more chunks. */
function riff(buf: Buffer, at: number, end: number, parts: MediaParts): boolean {
  while (at < end) {
    if (at + 8 > end) return false;
    const id = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const start = at + 8;
    if (!/^[\x20-\x7e]{4}$/.test(id) || start + size > end) return false;
    parts.covered.push([start, start + size]);
    if (id === "ANMF") {
      if (size < 16) return false;
      parts.text.push(buf.subarray(start, start + 16));
      if (!riff(buf, start + 16, start + size, parts)) return false;
    } else if (id === "VP8 " || id === "VP8L" || id === "ALPH") parts.pixels.push(buf.subarray(start, start + size));
    else parts.text.push(buf.subarray(start, start + size));
    at = Math.min(end, start + size + (size & 1));
  }
  return true;
}

/** Table ranges that lie inside the file and overlap neither each other (except shared identical ranges) nor `reserved`. */
function validTables(tables: { tag: string; start: number; end: number }[], reserved: [number, number][], length: number): boolean {
  const ranges = tables.map((t) => [t.start, t.end] as [number, number]);
  if (tables.some((t) => !/^[\x20-\x7e]{4}$/.test(t.tag) || t.start > t.end || t.end > length)) return false;
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
  if (ranges.some((r) => reserved.some((d) => overlaps(r, d)))) return false;
  const sorted = [...new Map(ranges.map((r) => [`${r[0]}:${r[1]}`, r])).values()].sort((a, b) => a[0] - b[0]);
  return sorted.every((r, i) => i === 0 || sorted[i - 1]![1] <= r[0]);
}

/** sfnt table directories at `bases` (TrueType, OpenType, or each font of a collection); `header` is reserved too. */
function sfnt(buf: Buffer, bases: number[], header: number, parts: MediaParts): boolean {
  const directories: [number, number][] = [[0, header]];
  const tables: { tag: string; start: number; end: number }[] = [];
  for (const base of bases) {
    if (base + 12 > buf.length) return false;
    const count = buf.readUInt16BE(base + 4);
    const end = base + 12 + 16 * count;
    if (count === 0 || count > MAX_TABLES || end > buf.length) return false;
    directories.push([base, end]);
    for (let i = 0; i < count; i++) {
      const entry = base + 12 + 16 * i;
      const start = buf.readUInt32BE(entry + 8);
      tables.push({ tag: buf.toString("latin1", entry, entry + 4), start, end: start + buf.readUInt32BE(entry + 12) });
    }
  }
  if (!validTables(tables, directories, buf.length)) return false;
  // Directories stay uncovered: they are scanned as text with the rest.
  for (const t of new Map(tables.map((t) => [`${t.start}:${t.end}`, t])).values()) {
    parts.covered.push([t.start, t.end]);
    (GLYPH_TABLES.has(t.tag) ? parts.pixels : parts.text).push(buf.subarray(t.start, t.end));
  }
  return true;
}

function woff(buf: Buffer, budget: Budget, parts: MediaParts): boolean {
  if (buf.length < 44 || buf.readUInt32BE(8) !== buf.length) return false;
  const count = buf.readUInt16BE(12);
  const directory = 44 + 20 * count;
  if (count === 0 || count > MAX_TABLES || directory > buf.length) return false;
  const tables: { tag: string; start: number; end: number; original: number }[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 44 + 20 * i;
    const start = buf.readUInt32BE(entry + 4);
    tables.push({ tag: buf.toString("latin1", entry, entry + 4), start, end: start + buf.readUInt32BE(entry + 8), original: buf.readUInt32BE(entry + 12) });
  }
  // Optional metadata (zlib XML) and private blocks.
  const [metaStart, metaLength, privStart, privLength] = [buf.readUInt32BE(24), buf.readUInt32BE(28), buf.readUInt32BE(36), buf.readUInt32BE(40)];
  const blocks = [...(metaLength ? [{ tag: "meta", start: metaStart, end: metaStart + metaLength }] : []), ...(privLength ? [{ tag: "priv", start: privStart, end: privStart + privLength }] : [])];
  if (!validTables([...tables, ...blocks], [[0, directory]], buf.length)) return false;
  for (const t of tables) {
    const data = buf.subarray(t.start, t.end);
    if (data.length > t.original) return false;
    // A table shorter than its original length is zlib data that must inflate to exactly that length.
    const table = data.length < t.original ? budget.decompress(data) : data;
    if (!table || table.length !== t.original) return false;
    parts.covered.push([t.start, t.end]);
    (GLYPH_TABLES.has(t.tag) ? parts.pixels : parts.text).push(table);
  }
  if (metaLength) {
    const meta = budget.decompress(buf.subarray(metaStart, metaStart + metaLength));
    if (!meta) return false;
    parts.covered.push([metaStart, metaStart + metaLength]);
    parts.text.push(meta);
  }
  return true;
}

/** WOFF2's known table tags, by their 6-bit index in a table directory entry. */
const WOFF2_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".match(/.{4} ?/g)!.map((t) => t.slice(0, 4));

/** A WOFF2 table directory: its tables' tags and lengths, and where the Brotli stream starts after it. */
function woff2Directory(buf: Buffer): { tables: { tag: string; length: number }[]; at: number } | undefined {
  if (buf.length < 48) return undefined;
  const count = buf.readUInt16BE(12);
  if (count === 0 || count > MAX_TABLES) return undefined;
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
  for (let i = 0; i < count; i++) {
    if (at >= buf.length) return undefined;
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
    if (tag === undefined || !/^[\x20-\x7e]{4}$/.test(tag) || original < 0 || length < 0) return undefined;
    tables.push({ tag, length });
  }
  return { tables, at };
}

/** WOFF2: one Brotli stream holding every table, in directory order. Collections get no exemption. */
function woff2(buf: Buffer, budget: Budget, parts: MediaParts): boolean {
  if (buf.length < 48 || buf.readUInt32BE(8) !== buf.length || buf.toString("latin1", 4, 8) === "ttcf") return false;
  const directory = woff2Directory(buf);
  if (!directory) return false;
  const { tables, at } = directory;
  const end = at + buf.readUInt32BE(20);
  if (end > buf.length) return false;
  const stream = budget.decompress(buf.subarray(at, end), true);
  if (!stream || tables.reduce((n, t) => n + t.length, 0) !== stream.length) return false;
  parts.covered.push([at, end]);
  let offset = 0;
  for (const t of tables) {
    (GLYPH_TABLES.has(t.tag) ? parts.pixels : parts.text).push(stream.subarray(offset, offset + t.length));
    offset += t.length;
  }
  // Optional metadata: Brotli XML.
  const [metaStart, metaLength] = [buf.readUInt32BE(28), buf.readUInt32BE(32)];
  if (metaLength) {
    if (metaStart < end || metaStart + metaLength > buf.length) return false;
    const meta = budget.decompress(buf.subarray(metaStart, metaStart + metaLength), true);
    if (!meta) return false;
    parts.covered.push([metaStart, metaStart + metaLength]);
    parts.text.push(meta);
  }
  return true;
}

/**
 * What a malformed file's compressed parts decode to, found without trusting the structure that failed
 * (Codex round 2 re-check: one bad chunk, or one byte after a zlib stream, hid every compressed part). A
 * PNG's text chunks and IDAT stream are found by chunk name wherever they are, a WOFF's tables through its
 * directory whatever their declared lengths, a WOFF2's table stream after its directory; each stream is
 * decoded as far as it goes (Budget.salvage).
 */
function recovered(buf: Buffer, budget: Budget): Buffer[] {
  const out: Buffer[] = [];
  const head = buf.toString("latin1", 0, 4);
  if (head === "\x89PNG") {
    const idat: Buffer[] = [];
    for (const type of ["zTXt", "iCCP", "iTXt", "IDAT"]) {
      for (let p = buf.indexOf(type, 12, "latin1"); p >= 0; p = buf.indexOf(type, p + 1, "latin1")) {
        const data = buf.subarray(p + 4, Math.min(buf.length, p + 4 + buf.readUInt32BE(p - 4)));
        if (type === "IDAT") {
          idat.push(data);
          continue;
        }
        // keyword\0 then (zTXt, iCCP) method and zlib data, or (iTXt) flag, method, language\0, keyword\0, text.
        const k = data.indexOf(0);
        if (k < 0 || (type === "iTXt" && data[k + 1] !== 1)) continue;
        const language = type === "iTXt" ? data.indexOf(0, k + 3) : -1;
        const body = type !== "iTXt" ? k + 2 : language < 0 ? -1 : data.indexOf(0, language + 1) + 1;
        if (body > 0) out.push(budget.salvage(data.subarray(body)));
      }
    }
    if (idat.length) out.push(budget.salvage(Buffer.concat(idat)));
  } else if (head === "wOFF" && buf.length >= 44) {
    // The metadata block, and every table stored at other than its original length (zlib data).
    const blocks: [number, number][] = [[buf.readUInt32BE(24), buf.readUInt32BE(28)]];
    const count = Math.min(buf.readUInt16BE(12), MAX_TABLES, Math.floor((buf.length - 44) / 20));
    for (let entry = 44; entry < 44 + 20 * count; entry += 20) {
      if (buf.readUInt32BE(entry + 8) !== buf.readUInt32BE(entry + 12)) blocks.push([buf.readUInt32BE(entry + 4), buf.readUInt32BE(entry + 8)]);
    }
    for (const [start, length] of blocks) if (length && start < buf.length) out.push(budget.salvage(buf.subarray(start, start + length)));
  } else if (head === "wOF2" && buf.length >= 48) {
    const directory = woff2Directory(buf);
    if (directory) out.push(budget.salvage(buf.subarray(directory.at, directory.at + buf.readUInt32BE(20)), true));
    const [metaStart, metaLength] = [buf.readUInt32BE(28), buf.readUInt32BE(32)];
    if (metaLength && metaStart < buf.length) out.push(budget.salvage(buf.subarray(metaStart, metaStart + metaLength), true));
  }
  return out;
}

/** Printable ASCII, UTF-16LE and UTF-16BE runs of at least `min` characters. */
function printableRuns(buf: Buffer, min: number): string[] {
  const latin1 = buf.toString("latin1");
  const runs = [...latin1.matchAll(new RegExp(`[\\x20-\\x7e\\t\\r\\n]{${min},}`, "g"))].map((m) => m[0]);
  for (const re of [new RegExp(`(?:[\\x20-\\x7e\\t\\r\\n]\\x00){${min},}`, "g"), new RegExp(`(?:\\x00[\\x20-\\x7e\\t\\r\\n]){${min},}`, "g")]) {
    for (const m of latin1.matchAll(re)) runs.push(m[0].replace(/\x00/g, ""));
  }
  return runs;
}

/** Parses a well-formed image or font into parts; false if it is malformed anywhere. */
function parse(buf: Buffer, budget: Budget, parts: MediaParts): boolean {
  const head = buf.toString("latin1", 0, 4);
  if (head === "\x89PNG") return png(buf, budget, parts);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf, parts);
  if (head === "GIF8") return gif(buf, parts);
  if (head === "RIFF") return buf.length >= 12 && 8 + buf.readUInt32LE(4) <= buf.length && riff(buf, 12, 8 + buf.readUInt32LE(4), parts);
  if (head === "wOFF") return woff(buf, budget, parts);
  if (head === "wOF2") return woff2(buf, budget, parts);
  if (head === "ttcf") {
    if (buf.length < 12) return false;
    const count = buf.readUInt32BE(8);
    if (count === 0 || count > MAX_TABLES || 12 + 4 * count > buf.length) return false;
    return sfnt(buf, Array.from({ length: count }, (_, i) => buf.readUInt32BE(12 + 4 * i)), 12 + 4 * count, parts);
  }
  return sfnt(buf, [0], 0, parts);
}

/** True if an image or font is well formed enough to earn its pixel and glyph exemption. */
export function isWellFormedMedia(buf: Buffer, maxBytes = 16 * 1024 * 1024): boolean {
  return parse(buf, new Budget(maxBytes), { covered: [], text: [], pixels: [] });
}

/**
 * The text of an image or font for the scanner, one printable run per line. A malformed file is scanned
 * whole as text, every byte. Decompression is bounded by maxBytes; past it, this throws.
 */
export function mediaText(buf: Buffer, maxBytes: number): string {
  const parts: MediaParts = { covered: [], text: [], pixels: [] };
  // Malformed: every byte as text, with whatever its compressed parts decode to.
  if (!parse(buf, new Budget(maxBytes), parts)) {
    return [...new Set([buf, ...parts.text, ...recovered(buf, new Budget(maxBytes))].flatMap((b) => printableRuns(b, MIN_RUN)))].join("\n");
  }
  const uncovered: Buffer[] = [];
  let at = 0;
  for (const [start, end] of parts.covered.sort((a, b) => a[0] - b[0])) {
    if (start > at) uncovered.push(buf.subarray(at, start));
    at = Math.max(at, end);
  }
  if (at < buf.length) uncovered.push(buf.subarray(at));
  // Long runs of the whole file too, whatever the structure says: a key split between a table and the
  // bytes after it is still one run of the file.
  const long = [...parts.pixels, buf].flatMap((b) => printableRuns(b, MIN_PIXEL_RUN));
  return [...new Set([...[...parts.text, ...uncovered].flatMap((b) => printableRuns(b, MIN_RUN)), ...long])].join("\n");
}
