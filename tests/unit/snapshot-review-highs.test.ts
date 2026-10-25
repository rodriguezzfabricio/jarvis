import { createHash, generateKeyPairSync } from "node:crypto";
import { brotliCompressSync, crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { findCredentials, findSnapshotCredentials } from "../../packages/cli/src/eval/snapshot.ts";
import { isCredentialShaped } from "../../packages/cli/src/eval/snapshot-literals.ts";

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
function png(...extra: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(noise("idat", 20_000))), chunk("IEND", Buffer.alloc(0))]);
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
