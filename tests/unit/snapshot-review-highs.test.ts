import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { brotliCompressSync, crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { findCredentials, findSnapshotCredentials } from "../../packages/cli/src/eval/snapshot.ts";
import { isCredentialShaped } from "../../packages/cli/src/eval/snapshot-literals.ts";
import { isWellFormedMedia } from "../../packages/cli/src/eval/snapshot-media.ts";

/**
 * Codex review of the false-positive narrowing (decision 79): six inputs the narrowed scanner let through.
 * Each must be refused again; the nearest ordinary forms (FreeHire's own) must still pass.
 */

const scan = (name: string, content: string | Buffer) => findSnapshotCredentials(name, Buffer.from(content));
const refused = (name: string, content: string | Buffer) => scan(name, content).length > 0;
const noise = (seed: string, n: number) => {
  const out: Buffer[] = [];
  let h = Buffer.from(seed);
  while (out.length * 32 < n) out.push((h = createHash("sha256").update(h).digest()));
  return Buffer.concat(out).subarray(0, n);
};
/** The review's synthetic PKCS#8 Ed25519 key, as base64 DER. */
const KEY_B64 = "MC4CAQAwBQYDK2VwBCIEIJssjD0GYgJn+gLerdO59tLBF+oKOd6NTjgZs6C4bSAv";
const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16();

// Minimal but structurally valid media files.
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, "latin1"), data, u32(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])))]);
const ihdr = Buffer.concat([u32(64), u32(64), Buffer.from([8, 2, 0, 0, 0])]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 64x64 RGB, not interlaced: 64 rows of a filter byte and 192 sample bytes. */
const PIXELS = 64 * (1 + 64 * 3);
function png(...extra: Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(noise("idat", PIXELS))), chunk("IEND", Buffer.alloc(0))]);
}
const text = (keyword: string, value: string | Buffer) => chunk("tEXt", Buffer.concat([Buffer.from(`${keyword}\0`, "latin1"), Buffer.from(value)]));
const ztxt = (keyword: string, value: string) => chunk("zTXt", Buffer.concat([Buffer.from(`${keyword}\0\0`, "latin1"), deflateSync(value)]));
const itxt = (keyword: string, value: string, compressed = false) =>
  chunk("iTXt", Buffer.concat([Buffer.from(`${keyword}\0`, "latin1"), Buffer.from([compressed ? 1 : 0, 0]), Buffer.from("\0\0"), compressed ? deflateSync(value) : Buffer.from(value)]));
/** Entropy-coded scan data has every 0xff stuffed with 0x00. */
const scanData = (n: number) => Buffer.from([...noise("scan", n)].flatMap((b) => (b === 0xff ? [0xff, 0x00] : [b])));
const segment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);
function jpeg(...extra: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), ...extra, segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), scanData(20_000), Buffer.from([0xff, 0xd9])]);
}
const subBlocks = (data: Buffer) => {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) { const p = data.subarray(i, i + 255); parts.push(Buffer.from([p.length]), p); }
  return Buffer.concat([...parts, Buffer.from([0])]);
};
function gif(comment: string): Buffer {
  const lsd = Buffer.from([16, 0, 16, 0, 0, 0, 0]);
  const image = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 16, 0, 16, 0, 0, 2]), subBlocks(noise("lzw", 4000))]);
  return Buffer.concat([Buffer.from("GIF89a"), lsd, Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from(comment)), image, Buffer.from([0x3b])]);
}
const riff = (fourcc: string, data: Buffer) => Buffer.concat([Buffer.from(fourcc, "latin1"), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP"), riff("VP8 ", noise("vp8", 20_000)), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(body.length), body]);
}
/** A TrueType font with a glyf table of noise and a name table holding one Windows (UTF-16BE) string. */
function ttf(name: string): Buffer {
  const str = utf16be(name);
  const nameTable = Buffer.concat([u16(0), u16(1), u16(6 + 12), u16(3), u16(1), u16(0x409), u16(0), u16(str.length), u16(0), str]);
  const glyf = noise("glyf", 20_000);
  const tables: [string, Buffer][] = [["glyf", glyf], ["name", nameTable]];
  let offset = 12 + 16 * tables.length;
  const dir = tables.map(([tag, data]) => {
    const entry = Buffer.concat([Buffer.from(tag), u32(0), u32(offset), u32(data.length)]);
    offset += Math.ceil(data.length / 4) * 4;
    return entry;
  });
  const body = tables.map(([, data]) => Buffer.concat([data, Buffer.alloc(Math.ceil(data.length / 4) * 4 - data.length)]));
  return Buffer.concat([u32(0x00010000), u16(tables.length), u16(0), u16(0), u16(0), ...dir, ...body]);
}
/** A WOFF2 font: name (known tag 5) and glyf (10, transform 3: stored as is) in one Brotli stream. */
function woff2(name: string): Buffer {
  const str = utf16be(name);
  const nameTable = Buffer.concat([u16(0), u16(1), u16(6 + 12), u16(3), u16(1), u16(0x409), u16(0), u16(str.length), u16(0), str]);
  const glyf = noise("woff2-glyf", 20_000);
  const base128 = (n: number) => { const out = [n & 0x7f]; while ((n >>>= 7)) out.unshift(0x80 | (n & 0x7f)); return Buffer.from(out); };
  const dir = Buffer.concat([Buffer.from([0xc0 | 10]), base128(glyf.length), Buffer.from([5]), base128(nameTable.length)]);
  const stream = brotliCompressSync(Buffer.concat([glyf, nameTable]));
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(12 + 32 + glyf.length + nameTable.length, 16);
  header.writeUInt32BE(stream.length, 20);
  const file = Buffer.concat([header, dir, stream]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

describe("1. text inside images and fonts goes through the decoding pipeline", () => {
  it.each([
    ["PNG tEXt holding a base64 private key", "logo.png", png(text("Comment", KEY_B64))],
    ["PNG zTXt holding a PEM key", "logo.png", png(ztxt("Comment", pem))],
    ["PNG iTXt (compressed XMP) holding a base64 key", "logo.png", png(itxt("XML:com.adobe.xmp", `<x:xmpmeta><dc:description>${KEY_B64}</dc:description></x:xmpmeta>`, true))],
    ["UTF-16 PEM in a private PNG chunk", "logo.png", png(chunk("prVt", Buffer.from(pem, "utf16le")))],
    ["UTF-16 PEM appended after IEND", "logo.png", Buffer.concat([png(), Buffer.from(pem, "utf16le")])],
    ["JPEG comment holding a base64 key", "photo.jpg", jpeg(segment(0xfe, Buffer.from(KEY_B64)))],
    ["JPEG XMP holding a base64 key", "photo.jpg", jpeg(segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:rights>${KEY_B64}</dc:rights></x:xmpmeta>`)))],
    ["GIF comment holding a base64 key", "anim.gif", gif(`key ${KEY_B64}`)],
    ["WebP XMP holding a base64 key", "hero.webp", webp(riff("XMP ", Buffer.from(`<x:xmpmeta>${KEY_B64}</x:xmpmeta>`)))],
    ["TrueType name table holding a UTF-16BE PEM", "Carlito-Bold.ttf", ttf(pem)],
    ["WOFF2 name table holding a UTF-16BE base64 key", "font.woff2", woff2(KEY_B64)],
  ])("refuses %s", (_label, name, bytes) => {
    expect(refused(name, bytes)).toBe(true);
  });

  it.each([
    ["a PNG with ordinary text chunks", "screenshot.png", png(text("Software", "Adobe ImageReady"), itxt("XML:com.adobe.xmp", '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Figma" tiff:Orientation="1"/></rdf:RDF></x:xmpmeta>'))],
    ["a JPEG with JFIF, EXIF and a base64 JPEG thumbnail in XMP", "photo.jpg", jpeg(segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0MM\0*\0\0\0\x08", "latin1"), noise("exif", 600)])), segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><xmpGImg:image>${jpeg().toString("base64")}</xmpGImg:image></x:xmpmeta>`)))],
    ["a GIF with an ordinary comment", "anim.gif", gif("Created with ezgif.com GIF maker")],
    ["a WebP with ordinary XMP", "hero.webp", webp(riff("XMP ", Buffer.from('<x:xmpmeta><rdf:Description xmp:CreatorTool="Squoosh"/></x:xmpmeta>')))],
    ["a TrueType font with a license in its name table", "Carlito-Bold.ttf", ttf("Copyright (c) 2010-2013 by tyPoland Lukasz Dziedzic with Reserved Font Name \"Carlito\". Licensed under the SIL Open Font License, Version 1.1: http://scripts.sil.org/OFL")],
    ["a WOFF2 font with a family name", "font.woff2", woff2("Inter Variable")],
  ])("keeps %s", (_label, name, bytes) => {
    expect(scan(name, bytes)).toEqual([]);
  });
});

describe("2. Brotli inside base64 is probed before decoded bytes are discarded", () => {
  it("refuses an npm token in a base64 Brotli stream", () => {
    expect(scan("notes.md", "ixOAbnBtX3E4WnIydkxtMFR4U3ludGhldGljOXF2TTJhYmNkZWZnaGlqWgM=\n")).toContain("npm token");
  });
});

describe("3. wrapped base64 is joined by what it decodes to, not by line widths", () => {
  it.each([
    ["uneven lines", "MC4CAQAwBQYDK2Vw\nBCIEIJssjD0GYgJn+gLe\nrdO59tLBF+oKOd6NTjgZs6C4bSAv\n"],
    ["8-character lines", `${KEY_B64.match(/.{1,8}/g)!.join("\n")}\n`],
    ["a short first line", "MC4C\nAQAwBQYDK2VwBCIEIJssjD0GYgJn\n+gLerdO59tLBF+oKOd6NTjgZs6C4bSAv\n"],
    ["lines between words in the same column", `Private\n${KEY_B64.match(/.{1,12}/g)!.join("\n")}\nDone\n`],
  ])("refuses a private key in %s", (_label, text) => {
    expect(scan("notes.md", text)).toContain("binary private key");
  });

  it("refuses base64 text wrapped at uneven widths", () => {
    const encoded = Buffer.from("token npm_q8Zr2vLm0TxSynthetic9qvM2abcdefghijZ").toString("base64");
    expect(scan("notes.md", `${encoded.slice(0, 10)}\n${encoded.slice(10, 37)}\n${encoded.slice(37)}\n`)).toContain("npm token");
  });
});

describe("4. random letters under a credential name are credential-shaped", () => {
  it("refuses a long random lowercase literal", () => {
    expect(scan("auth.ts", 'const jwtSecret = "vrnqkydfslxozctwuphgmeabjivnsqkr"; jwt.sign(payload, jwtSecret);\n')).toContain('credential literal "jwtSecret"');
  });

  it("judges letters by how they read, not by their case", () => {
    for (const v of ["vrnqkydfslxozctwuphgmeabjivnsqkr", "VRNQKYDFSLXOZCTWUPHGMEABJIVNSQKR", "Vrnqkydfslxozctwuphg", "xkqzmpwrtvbnhjgf", "session-vrnqkydfslxozctw"]) expect(isCredentialShaped(v), v).toBe(true);
    for (const v of ["validpassword", "supersecretvalue", "correcthorsebatterystaple", "integration", "orchestratorSecret", "abcdefghijklmnop", "ExponentPushToken", "whsec_integration"]) expect(isCredentialShaped(v), v).toBe(false);
  });
});

describe("5. local hosts do not exempt real credentials; placeholder values do", () => {
  it.each([
    'const db = "postgres://svc:e7Kq2mVx9PzR4tLw@localhost:5432/app";',
    "postgres://svc:q8Zr2@localhost/app",
    "postgres://svc:vrnqkydfslxozctw@db:5432/app",
  ])("refuses a real password at a local host: %s", (text) => {
    expect(findCredentials(text)).toContain("credential URL");
  });

  it("refuses a real key in a localhost query", () => {
    expect(findCredentials('fetch("http://localhost:9000/?api_key=e7Kq2mVx9PzR4tLw")')).toContain("credential URL query");
  });

  it.each([
    "postgres://postgres:postgres@localhost:5432/app",
    "postgres://hire:hire@localhost:5432/hire",
    "redis://:password@redis:6379/0",
    "mysql://root:changeme@127.0.0.1/app",
    "http://minioadmin:minioadmin@minio:9000",
    "postgres://app:dev_password@db:5432/app",
    "postgres://app:xxxxxxxx@db:5432/app",
    "http://localhost:9000/?api_key=test&token=dev",
    "https://jobs.example.test/apply?token=s3cr3t",
    // FreeHire's own test inputs.
    "http://user:sup3rsecret@proxy.example:8080",
    "postgres://u:p@localhost:5432/db",
    "postgres://u:pool_max_conns%3D99@localhost:5432/db",
    "postgres://nobody:nobody@127.0.0.1:1/nothing?sslmode=disable&connect_timeout=1",
  ])("keeps %s", (url) => {
    expect(findCredentials(`url: ${url}`)).toEqual([]);
  });
});

describe("6. short padded base64 logins in a credential context", () => {
  it("refuses a canonical padded login under a credential-ish name", () => {
    expect(scan("registry.ts", 'const registryLogin = "dTpxOFpyMg==";\n')).toContain("base64 user:password");
  });

  it("keeps short padded base64 outside a credential context", () => {
    expect(scan("hash.ts", 'const digest = "dTpxOFpyMg==";\n')).toEqual([]);
  });
});

/** Codex round 2 re-check: four more inputs, against findings 1 and 3. K is the review's base64 key. */
const K = KEY_B64;
const pemK = `-----BEGIN PRIVATE KEY-----\n${K}\n-----END PRIVATE KEY-----\n`;

describe("round 2, 1: media exemptions need a well-formed file, and pixel data is not a hiding place", () => {
  it.each([
    ["UTF-16 PEM in an IDAT with no IHDR", "logo.png", Buffer.concat([PNG_SIGNATURE, chunk("IDAT", Buffer.from(pemK, "utf16le")), chunk("IEND", Buffer.alloc(0))])],
    ["UTF-16BE PEM in an IDAT with no IHDR", "logo.png", Buffer.concat([PNG_SIGNATURE, chunk("IDAT", utf16be(pemK)), chunk("IEND", Buffer.alloc(0))])],
    ["a base64 key in an IDAT that does not inflate to the image's size", "logo.png", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(K))), chunk("IEND", Buffer.alloc(0))])],
    ["a base64 key after the zlib stream inside an IDAT", "logo.png", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", Buffer.concat([deflateSync(noise("idat", PIXELS)), Buffer.from(K)])), chunk("IEND", Buffer.alloc(0))])],
    ["a base64 key in a chunk with a bad CRC", "logo.png", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), Buffer.concat([u32(64), Buffer.from("IDAT"), Buffer.from(K), u32(0)]), chunk("IEND", Buffer.alloc(0))])],
    ["a UTF-16 base64 key inside JPEG scan data", "photo.jpg", Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), scanData(5000), Buffer.from(K, "utf16le"), scanData(5000), Buffer.from([0xff, 0xd9])])],
    ["a base64 key inside GIF image data", "anim.gif", (() => {
      const lzw = Buffer.concat([noise("lzw", 2000), Buffer.from(K), noise("lzw2", 2000)]);
      return Buffer.concat([Buffer.from("GIF89a"), Buffer.from([16, 0, 16, 0, 0, 0, 0]), Buffer.from([0x2c, 0, 0, 0, 0, 16, 0, 16, 0, 0, 2]), subBlocks(lzw), Buffer.from([0x3b])]);
    })()],
  ])("refuses %s", (_label, name, bytes) => {
    expect(refused(name, bytes)).toBe(true);
  });

  it("refuses a UTF-16 AWS key id (shorter than a long run) inside JPEG scan data", () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), scanData(5000), Buffer.from("AKIAQ8ZR2VLM0TXSYN7K", "utf16le"), scanData(5000), Buffer.from([0xff, 0xd9])]);
    expect(isWellFormedMedia(jpg)).toBe(true);
    expect(scan("photo.jpg", jpg)).toContain("AWS access key");
  });

  // Shorter than a long run (32), so only the format's own text extraction can find it.
  const SHORT = "password = q8Zr2vLm0Tx";
  it.each([
    ["after a PNG's IEND", "logo.png", Buffer.concat([png(), Buffer.from(`\0${SHORT}\0`)])],
    ["in a PNG tEXt chunk", "logo.png", png(text("Comment", SHORT))],
    ["in a JPEG comment", "photo.jpg", jpeg(segment(0xfe, Buffer.from(SHORT)))],
    ["in a GIF comment", "anim.gif", gif(SHORT)],
    ["in WebP XMP", "hero.webp", webp(riff("XMP ", Buffer.from(SHORT)))],
    ["in a TrueType name table", "font.ttf", ttf(SHORT)],
    ["in a WOFF2 name table", "font.woff2", woff2(SHORT)],
  ])("refuses a short credential assignment %s", (_label, name, bytes) => {
    expect(isWellFormedMedia(bytes)).toBe(true);
    expect(scan(name, bytes)).toContain('credential literal "password"');
  });

  it("keeps a well-formed PNG whose pixels are noise", () => {
    expect(scan("screenshot.png", png())).toEqual([]);
  });
});

describe("round 2: only a well-formed file earns an exemption", () => {
  /** A WOFF 1 font with a zlib name table (`after` follows its zlib stream, inside the table) and a stored glyf table. */
  const woff1 = (after = Buffer.alloc(0)) => {
    const str = utf16be("Inter");
    const nameTable = Buffer.concat([u16(0), u16(1), u16(6 + 12), u16(3), u16(1), u16(0x409), u16(0), u16(str.length), u16(0), str, Buffer.alloc(64)]);
    const packed = Buffer.concat([deflateSync(nameTable), after]);
    const glyf = noise("woff-glyf", 400);
    const header = Buffer.alloc(44);
    header.write("wOFF", 0, "latin1");
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt16BE(2, 12);
    const at = 44 + 40;
    const dir = Buffer.concat([Buffer.from("glyf"), u32(at), u32(glyf.length), u32(glyf.length), u32(0), Buffer.from("name"), u32(at + glyf.length), u32(packed.length), u32(nameTable.length), u32(0)]);
    const file = Buffer.concat([header, dir, glyf, packed]);
    file.writeUInt32BE(file.length, 8);
    return file;
  };
  const woff = woff1();
  /** An sfnt with `count` four-byte tables, each inside the file and after the directory. */
  const fontWithTables = (count: number) => {
    const data = 12 + 16 * count;
    const dir = Array.from({ length: count }, (_, i) => Buffer.concat([Buffer.from(`t${String(i).padStart(3, "0")}`), u32(0), u32(data + 4 * i), u32(4)]));
    return Buffer.concat([u32(0x00010000), u16(count), u16(0), u16(0), u16(0), ...dir, noise("tables", 4 * count)]);
  };
  const gifImage = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 16, 0, 16, 0, 0, 2]), subBlocks(noise("lzw", 400))]);

  it("refuses a short credential after the zlib stream of a WOFF table", () => {
    expect(scan("font.woff", woff1(Buffer.from("\0password = q8Zr2vLm0Tx\0")))).toContain('credential literal "password"');
  });

  it("accepts a font with as many tables as the limit", () => {
    expect(isWellFormedMedia(fontWithTables(512))).toBe(true);
  });

  it("accepts the well-formed fixtures the keep cases use", () => {
    for (const [label, bytes] of [["png", png(text("Software", "x"))], ["jpeg", jpeg()], ["gif", gif("hello")], ["webp", webp()], ["ttf", ttf("Inter")], ["woff", woff], ["woff2", woff2("Inter")]] as const) {
      expect(isWellFormedMedia(bytes), label).toBe(true);
    }
  });

  it.each([
    ["a PNG with no IHDR", Buffer.concat([PNG_SIGNATURE, chunk("IDAT", deflateSync(noise("idat", PIXELS))), chunk("IEND", Buffer.alloc(0))])],
    ["a PNG with a bad CRC", (() => { const b = png(); b.writeUInt8(b.readUInt8(b.length - 13) ^ 1, b.length - 13); return b; })()],
    ["a PNG with no IEND", png().subarray(0, -12)],
    ["a PNG whose IDAT inflates to the wrong size", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(noise("idat", PIXELS - 1))), chunk("IEND", Buffer.alloc(0))])],
    ["a PNG with bytes after its IDAT stream", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", Buffer.concat([deflateSync(noise("idat", PIXELS)), Buffer.from("x")])), chunk("IEND", Buffer.alloc(0))])],
    // Its IDAT inflates to the size a 3-bit RGB image would have, so only the header's validity rejects it.
    ["a PNG with an invalid bit depth", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", Buffer.concat([u32(64), u32(64), Buffer.from([3, 2, 0, 0, 0])])), chunk("IDAT", deflateSync(noise("idat", 64 * (1 + Math.ceil((64 * 3 * 3) / 8))))), chunk("IEND", Buffer.alloc(0))])],
    ["a JPEG with no EOI", jpeg().subarray(0, -2)],
    ["a GIF with no trailer", gif("hello").subarray(0, -1)],
    ["a GIF with a truncated image", Buffer.concat([Buffer.from("GIF89a"), Buffer.from([16, 0, 16, 0, 0, 0, 0]), gifImage.subarray(0, 100)])],
    ["a WebP chunk past the RIFF end", (() => { const b = webp(riff("XMP ", Buffer.from("<x/>"))); b.writeUInt32LE(b.readUInt32LE(4) - 2, 4); return b; })()],
    ["the review's forged font directory", Buffer.concat([Buffer.from("0001000000040000ff000000", "hex"), Buffer.from(K)])],
    ["a font table past the end of the file", (() => { const b = ttf("Inter"); b.writeUInt32BE(b.length, 12 + 16 + 8); return b; })()],
    ["overlapping font tables", (() => { const b = ttf("Inter"); b.writeUInt32BE(b.readUInt32BE(12 + 8) + 4, 12 + 16 + 8); return b; })()],
    ["a font table over its directory", (() => { const b = ttf("Inter"); b.writeUInt32BE(0, 12 + 16 + 8); return b; })()],
    ["a font table with an unprintable tag", (() => { const b = ttf("Inter"); b[12 + 16] = 0; return b; })()],
    ["a WOFF with the wrong length", (() => { const b = Buffer.from(woff); b.writeUInt32BE(b.length + 1, 8); return b; })()],
    ["a WOFF table that does not inflate to its length", (() => { const b = Buffer.from(woff); b.writeUInt32BE(b.readUInt32BE(44 + 20 + 12) + 1, 44 + 20 + 12); return b; })()],
    ["a WOFF table with bytes after its zlib stream", woff1(Buffer.from("x"))],
    ["a font with no tables", Buffer.concat([u32(0x00010000), u16(0), u16(0), u16(0), u16(0), noise("tables", 64)])],
    ["a font with more tables than any real font", fontWithTables(513)],
    ["a WOFF2 with a corrupted table directory", (() => { const b = woff2("Inter"); return Buffer.concat([b.subarray(0, 48), Buffer.from([0xc0 | 10, 0x01]), b.subarray(50)]); })()],
  ])("rejects %s", (_label, bytes) => {
    expect(isWellFormedMedia(bytes)).toBe(false);
  });
});

describe("round 2, 3: font directories are validated before anything is exempt", () => {
  it("refuses the review's forged directory: four entries with invalid offsets, the key in the directory", () => {
    expect(refused("font.ttf", Buffer.concat([Buffer.from("0001000000040000ff000000", "hex"), Buffer.from(K)]))).toBe(true);
  });

  it("refuses a key inside a table declared as glyphs", () => {
    const font = ttf("Inter");
    const glyf = font.indexOf(noise("glyf", 64));
    expect(refused("font.ttf", Buffer.concat([font.subarray(0, glyf + 100), Buffer.from(K), font.subarray(glyf + 100 + K.length)]))).toBe(true);
  });

  it("refuses overlapping or out-of-file tables, and a directory that runs past the file", () => {
    const font = ttf("Inter");
    const name = Buffer.from(font);
    name.writeUInt32BE(font.length + 4, 12 + 16 + 8); // the name table's offset, past the end
    expect(refused("font.ttf", Buffer.concat([name, Buffer.from(K)]))).toBe(true);
    const short = Buffer.concat([Buffer.from("00010000ffff0000ff000000", "hex"), Buffer.from(K)]);
    expect(refused("font.ttf", short)).toBe(true);
  });
});

describe("round 2, 2: wrapped columns keep a short last line", () => {
  it.each([7, 9])("refuses a key wrapped at %i characters (last line shorter than 4)", (width) => {
    expect(scan("notes.md", `${K.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n")}\n`)).toContain("binary private key");
  });
});

describe("round 2, 4: wrapped DER candidates are bounded", () => {
  it("refuses, within a 128 MB heap, 14,000 lines that each announce a 64 KB DER value", () => {
    const lines = Array.from({ length: 14_000 }, (_, i) => Buffer.from([0x30, 0x82, 0xff, 0xf8, i >> 8, i & 255]).toString("base64")).join("\n");
    const module = new URL("../../packages/cli/src/eval/snapshot.ts", import.meta.url).pathname;
    const code = `const { findSnapshotCredentials } = await import(${JSON.stringify(module)}); const hits = findSnapshotCredentials("notes.md", Buffer.from(process.argv[1])); console.log(JSON.stringify(hits));`;
    const r = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", code, lines], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const hits = JSON.parse(r.stdout) as string[];
    expect(hits).toContain("wrapped base64 candidate limit; needs review");
  }, 60_000);
});

/**
 * Round 2 re-check: a malformed file is scanned whole, so what its compressed parts hold must be decoded
 * too. A structural error before a zTXt chunk, or one byte after a zlib stream, hid every compressed part.
 */
describe("round 2: a malformed file's compressed parts are still decoded", () => {
  const ztxtRaw = (stream: Buffer) => chunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0", "latin1"), stream]));
  const badCrc = Buffer.concat([u32(1), Buffer.from("tEXt"), Buffer.from("x"), u32(0)]);
  const pngOf = (...chunks: Buffer[]) => Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), ...chunks, chunk("IDAT", deflateSync(noise("idat", PIXELS))), chunk("IEND", Buffer.alloc(0))]);
  /** A zlib stream damaged near its end, so that decoding it whole fails: it decodes up to the damage. */
  const damaged = (data: Buffer) => { const z = Buffer.from(deflateSync(data)); z.writeUInt8(z.readUInt8(z.length - 30) ^ 0xff, z.length - 30); return z; };
  const woffOf = (table: Buffer, stored: Buffer, original = table.length) => {
    const header = Buffer.alloc(44);
    header.write("wOFF", 0, "latin1");
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt16BE(1, 12);
    const file = Buffer.concat([header, Buffer.from("name"), u32(64), u32(stored.length), u32(original), u32(0), stored]);
    file.writeUInt32BE(file.length, 8);
    return file;
  };
  /** A WOFF2 font whose directory declares one name table of `declared` bytes, over `stream` compressed. */
  const woff2Of = (stream: Buffer, declared: number) => {
    const packed = brotliCompressSync(stream);
    const header = Buffer.alloc(48);
    header.write("wOF2", 0, "latin1");
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt16BE(1, 12);
    header.writeUInt32BE(12 + 16 + declared, 16);
    header.writeUInt32BE(packed.length, 20);
    const file = Buffer.concat([header, Buffer.from([5, declared]), packed]);
    file.writeUInt32BE(file.length, 8);
    return file;
  };
  const nameK = Buffer.concat([Buffer.alloc(18), Buffer.from(K), Buffer.alloc(40)]);

  it.each([
    ["a zTXt PEM followed by one more byte", "logo.png", pngOf(ztxtRaw(Buffer.concat([deflateSync(pemK), Buffer.from("x")])))],
    ["a zTXt PEM after a chunk with a bad CRC", "logo.png", pngOf(badCrc, ztxt("Comment", pemK))],
    ["a truncated zTXt PEM stream", "logo.png", pngOf(ztxtRaw(deflateSync(pemK).subarray(0, -6)))],
    ["a damaged zTXt stream, the PEM before the damage", "logo.png", pngOf(ztxtRaw(damaged(Buffer.from(pemK + "padding ".repeat(400)))))],
    ["a compressed iTXt PEM in a PNG with no IEND", "logo.png", pngOf(itxt("XML:com.adobe.xmp", pemK, true)).subarray(0, -12)],
    ["an IDAT stream holding a PEM, before a chunk with a bad CRC", "logo.png", Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pemK)), badCrc, chunk("IEND", Buffer.alloc(0))])],
    ["a WOFF zlib table holding a key, with the wrong original length", "font.woff", woffOf(nameK, deflateSync(nameK), nameK.length + 1)],
    ["a WOFF zlib table holding a key, followed by one more byte", "font.woff", woffOf(nameK, Buffer.concat([deflateSync(nameK), Buffer.from("x")]))],
    ["a WOFF2 stream holding a key after its declared table", "font.woff2", woff2Of(Buffer.concat([Buffer.alloc(40), Buffer.from(K)]), 40)],
    ["a WOFF2 stream shorter than its declared table, holding a key", "font.woff2", woff2Of(Buffer.concat([Buffer.alloc(8), Buffer.from(K)]), 120)],
  ])("refuses %s", (_label, name, bytes) => {
    expect(isWellFormedMedia(bytes)).toBe(false);
    expect(refused(name, bytes)).toBe(true);
  });

  it("refuses a short credential in a WOFF2 stream past its declared table", () => {
    const font = woff2Of(Buffer.concat([Buffer.alloc(40), Buffer.from("\0password = q8Zr2vLm0Tx\0")]), 40);
    expect(isWellFormedMedia(font)).toBe(false);
    expect(scan("font.woff2", font)).toContain('credential literal "password"');
  });

  it("keeps the well-formed versions", () => {
    for (const [name, bytes] of [["logo.png", pngOf(ztxt("Comment", "hello"))], ["font.woff", woffOf(Buffer.alloc(80), deflateSync(Buffer.alloc(80)))], ["font.woff2", woff2Of(Buffer.alloc(40), 40)]] as const) {
      expect(isWellFormedMedia(bytes), name).toBe(true);
      expect(scan(name, bytes), name).toEqual([]);
    }
  });
});
