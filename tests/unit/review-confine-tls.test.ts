import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CLIENT_HELLO, scanClientHello, startApiProxy, type ApiProxy, type ApiProxyOptions } from "../../packages/cli/src/review/confine.ts";

// Decision 110: the proxy reads the TLS ClientHello before it dials, so a tunnel opened for an API host
// can't carry a handshake that names another site on the same CDN (domain fronting by SNI).
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u24 = (n: number) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const ext = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
const sniExt = (names: string[], nameType = 0) => {
  const entries = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from([nameType]), u16(Buffer.byteLength(n, "latin1")), Buffer.from(n, "latin1")])));
  return ext(0, Buffer.concat([u16(entries.length), entries]));
};
/** A ClientHello handshake message (no record header), shaped like a TLS 1.3 client's. */
function hello(o: { sni?: string | null; names?: string[]; extensions?: Buffer[]; msgType?: number } = {}): Buffer {
  const names = o.names ?? (o.sni === null ? [] : [o.sni ?? "api.openai.com"]);
  const exts = Buffer.concat([...(names.length ? [sniExt(names)] : []), ext(0x002b, Buffer.from([2, 3, 4])), ...(o.extensions ?? [])]);
  const body = Buffer.concat([Buffer.from([3, 3]), randomBytes(32), Buffer.from([32]), randomBytes(32), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), u16(exts.length), exts]);
  return Buffer.concat([Buffer.from([o.msgType ?? 1]), u24(body.length), body]);
}
/** Wraps handshake bytes in TLS records of the given sizes (the rest in one more record). */
function records(handshake: Buffer, sizes: number[] = [], type = 0x16): Buffer {
  const out: Buffer[] = []; let off = 0;
  for (const size of [...sizes, handshake.length]) {
    if (off >= handshake.length) break;
    const part = handshake.subarray(off, off + size); off += part.length;
    out.push(Buffer.from([type, 3, 1]), u16(part.length), part);
  }
  return Buffer.concat(out);
}
const padding = (n: number) => ext(21, Buffer.alloc(n));

describe("ClientHello scan", () => {
  it("reads the SNI of a complete ClientHello", () => {
    expect(scanClientHello(records(hello()))).toEqual({ sni: "api.openai.com" });
  });
  it("waits for more bytes until the ClientHello is complete", () => {
    const full = records(hello());
    for (const k of [0, 1, 4, 5, 9, 60, full.length - 1]) expect(scanClientHello(full.subarray(0, k))).toEqual({ need: true });
  });
  it("reassembles a ClientHello split across TLS records", () => {
    expect(scanClientHello(records(hello({ sni: "chatgpt.com" }), [1, 3, 40]))).toEqual({ sni: "chatgpt.com" });
    const split = records(hello(), [2, 2]);
    expect(scanClientHello(split.subarray(0, 12))).toEqual({ need: true });
  });
  it.each([
    ["plain HTTP", Buffer.from("GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n"), /not TLS/],
    ["an application-data record", records(hello(), [], 0x17), /not TLS/],
    ["a record version other than 3.x", Buffer.concat([Buffer.from([0x16, 4, 1]), u16(4), Buffer.from([1, 0, 0, 0])]), /malformed TLS record/],
    ["an empty record", Buffer.concat([Buffer.from([0x16, 3, 1]), u16(0)]), /malformed TLS record/],
    ["a record over 16 KiB", Buffer.concat([Buffer.from([0x16, 3, 1]), u16(16385)]), /malformed TLS record/],
    ["a record of another type before the ClientHello ends", (() => { const h = hello(); return Buffer.concat([records(h.subarray(0, 10)), records(h.subarray(10), [], 0x14)]); })(), /before the ClientHello ended/],
    ["a handshake that isn't a ClientHello", records(hello({ msgType: 2 })), /not a ClientHello/],
    ["no SNI", records(hello({ sni: null })), /no SNI/],
    ["two SNI names", records(hello({ names: ["api.openai.com", "evil.example"] })), /one host name/],
    ["an SNI entry that isn't a host name", records(hello({ sni: null, extensions: [sniExt(["api.openai.com"], 1)] })), /one host name/],
    ["the encrypted_client_hello extension", records(hello({ extensions: [ext(0xfe0d, randomBytes(40))] })), /encrypted ClientHello/],
    ["a repeated extension", records(hello({ extensions: [ext(0x002b, Buffer.from([2, 3, 4]))] })), /repeated extension/],
    ["bytes after the ClientHello in its record", records(Buffer.concat([hello(), Buffer.from([1, 0, 0, 0])])), /after the ClientHello/],
    ["a ClientHello over the size limit", records(hello({ extensions: [padding(MAX_CLIENT_HELLO)] }), [16384]), /too large/],
  ])("refuses %s", (_name, data, reason) => {
    const result = scanClientHello(data);
    expect(result).toHaveProperty("refuse");
    expect((result as { refuse: string }).refuse).toMatch(reason);
  });
  it("refuses an oversize ClientHello as soon as its declared length is known", () => {
    const big = records(hello({ extensions: [padding(MAX_CLIENT_HELLO)] }), [16384]);
    expect(scanClientHello(big.subarray(0, 9))).toEqual({ refuse: expect.stringMatching(/too large/) });
  });
  it("refuses a ClientHello whose lengths don't add up", () => {
    const h = hello();
    const cut = Buffer.concat([Buffer.from([1]), u24(40), h.subarray(4, 44)]);
    expect(scanClientHello(records(cut))).toEqual({ refuse: expect.stringMatching(/malformed ClientHello/) });
    const lying = Buffer.from(h); lying.writeUInt16BE(0xffff, 4 + 2 + 32 + 1 + 32);
    expect(scanClientHello(records(lying))).toEqual({ refuse: expect.stringMatching(/malformed ClientHello/) });
  });
  it("accepts a large but legal ClientHello", () => {
    expect(scanClientHello(records(hello({ extensions: [padding(8000)] }), [4000]))).toEqual({ sni: "api.openai.com" });
  });
});

describe("API proxy checks the TLS ClientHello before it dials", () => {
  async function upstream(): Promise<{ port: number; got: () => Buffer; dialed: () => number }> {
    const chunks: Buffer[] = []; const open = new Set<Socket>(); let dials = 0;
    const server: Server = createServer((s) => { dials++; open.add(s); s.on("data", (d: Buffer) => { chunks.push(d); s.write("pong"); }); s.on("error", () => {}); });
    closers.push(() => new Promise((done) => { for (const s of open) s.destroy(); server.close(done); }));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { port: (server.address() as { port: number }).port, got: () => Buffer.concat(chunks), dialed: () => dials };
  }
  async function proxy(up: { port: number }, extra: ApiProxyOptions = {}): Promise<ApiProxy> {
    const p = await startApiProxy({ connectUpstream: () => connect(up.port, "127.0.0.1"), ...extra }); closers.push(() => p.close()); return p;
  }
  /** CONNECT, then send each chunk after the 200 with a pause between them; resolves on "pong" or close. */
  const through = (port: number, target: string, chunks: Buffer[], gapMs = 5, deadlineMs = 4000) => new Promise<{ status: string; pong: boolean | "still open" }>((resolve) => {
    const s = connect(port, "127.0.0.1"); let head = ""; let status = ""; let sent = false;
    const done = (pong: boolean | "still open") => { clearTimeout(deadline); s.destroy(); resolve({ status, pong }); };
    const deadline = setTimeout(() => done("still open"), deadlineMs);
    s.once("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("data", async (d: Buffer) => {
      if (!status) {
        head += d.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        status = head.split("\r\n")[0]!;
        if (!status.includes(" 200 ") || sent) return;
        sent = true;
        for (const c of chunks) { if (s.destroyed) return; s.write(c); await new Promise((r) => setTimeout(r, gapMs)); }
        return;
      }
      if (d.includes("pong")) done(true);
    });
    s.once("close", () => { clearTimeout(deadline); resolve({ status, pong: false }); });
    s.once("error", () => {});
  });

  it("forwards a ClientHello whose SNI is the CONNECT host, byte for byte", async () => {
    const up = await upstream(), p = await proxy(up);
    const h = records(hello({ sni: "api.openai.com" }));
    expect(await through(p.port, "api.openai.com:443", [h])).toEqual({ status: "HTTP/1.1 200 Connection Established", pong: true });
    expect(up.got().equals(h)).toBe(true);
    expect(p.refused).toEqual([]);
  });
  it("forwards a real TLS client's ClientHello for the CONNECT host", async () => {
    const up = await upstream(), p = await proxy(up);
    const raw = connect(p.port, "127.0.0.1");
    await new Promise<void>((done) => { raw.once("connect", () => raw.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n")); raw.once("data", () => done()); });
    const t = tlsConnect({ socket: raw, servername: "chatgpt.com" }); t.on("error", () => {}); closers.push(() => t.destroy());
    for (let i = 0; i < 100 && up.got().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(scanClientHello(up.got())).toEqual({ sni: "chatgpt.com" });
    expect(p.refused).toEqual([]);
  });
  it("refuses a real TLS client whose SNI names another host, and never dials", async () => {
    const up = await upstream(), p = await proxy(up);
    const raw = connect(p.port, "127.0.0.1");
    await new Promise<void>((done) => { raw.once("connect", () => raw.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n")); raw.once("data", () => done()); });
    const t = tlsConnect({ socket: raw, servername: "attacker.example" }); t.on("error", () => {});
    await new Promise((done) => t.once("close", done));
    expect(up.dialed()).toBe(0);
    expect(p.refused).toEqual([expect.stringMatching(/^CONNECT api\.openai\.com:443: SNI attacker\.example/)]);
  });
  it.each([
    ["an SNI for another site on the same CDN", "api.openai.com:443", () => [records(hello({ sni: "attacker.example.com" }))], /SNI attacker\.example\.com/],
    ["an SNI for a different API host than the CONNECT", "chatgpt.com:443", () => [records(hello({ sni: "api.openai.com" }))], /SNI api\.openai\.com/],
    ["an SNI that differs only in case", "api.openai.com:443", () => [records(hello({ sni: "API.openai.com" }))], /SNI/],
    ["no SNI", "api.openai.com:443", () => [records(hello({ sni: null }))], /no SNI/],
    ["a non-TLS payload", "api.openai.com:443", () => [Buffer.from("GET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n")], /not TLS/],
    ["an encrypted ClientHello", "api.openai.com:443", () => [records(hello({ extensions: [ext(0xfe0d, randomBytes(64))] }))], /encrypted ClientHello/],
    ["an oversize ClientHello", "api.openai.com:443", () => { const b = records(hello({ extensions: [padding(MAX_CLIENT_HELLO)] }), [16384]); return [b.subarray(0, 4000), b.subarray(4000)]; }, /too large/],
  ])("refuses %s and never dials", async (_name, target, chunks, reason) => {
    const up = await upstream(), p = await proxy(up);
    const r = await through(p.port, target, chunks());
    expect(r).toEqual({ status: "HTTP/1.1 200 Connection Established", pong: false });
    expect(up.dialed()).toBe(0);
    expect(p.refused).toHaveLength(1);
    expect(p.refused[0]).toMatch(new RegExp(`^CONNECT ${target.replace(/\./g, "\\.")}: `));
    expect(p.refused[0]).toMatch(reason);
  });
  it("reassembles a ClientHello fragmented across TCP chunks", async () => {
    const up = await upstream(), p = await proxy(up);
    const h = records(hello({ extensions: [padding(3000)] }));
    const chunks = [h.subarray(0, 1), h.subarray(1, 4), h.subarray(4, 7), h.subarray(7, 100), h.subarray(100)];
    expect(await through(p.port, "api.openai.com:443", chunks)).toEqual({ status: "HTTP/1.1 200 Connection Established", pong: true });
    expect(up.got().equals(h)).toBe(true);
  });
  it("reassembles a ClientHello fragmented across TLS records and TCP chunks", async () => {
    const up = await upstream(), p = await proxy(up);
    const h = records(hello({ extensions: [padding(6000)] }), [3, 2000, 2000]);
    const chunks = [h.subarray(0, 6), h.subarray(6, 2010), h.subarray(2010)];
    expect(await through(p.port, "api.openai.com:443", chunks)).toEqual({ status: "HTTP/1.1 200 Connection Established", pong: true });
    expect(up.got().equals(h)).toBe(true);
  });
  it("refuses a ClientHello spread over so many tiny records that the buffer passes its bound", async () => {
    const up = await upstream(), p = await proxy(up);
    const h = hello({ extensions: [padding(6000)] });
    const tiny = records(h, Array.from({ length: h.length }, () => 1));
    expect(scanClientHello(tiny)).toEqual({ sni: "api.openai.com" });
    expect(tiny.length - 10).toBeGreaterThan(2 * MAX_CLIENT_HELLO);
    expect(await through(p.port, "api.openai.com:443", [tiny.subarray(0, 20000), tiny.subarray(20000, tiny.length - 10)])).toEqual({ status: "HTTP/1.1 200 Connection Established", pong: false });
    expect(up.dialed()).toBe(0);
    expect(p.refused).toEqual([expect.stringMatching(/too large/)]);
  });
  it("tunnels everything after an accepted ClientHello unchanged", async () => {
    const up = await upstream(), p = await proxy(up);
    const h = records(hello()), later = Buffer.from("\x17\x03\x03\x00\x05hello");
    expect((await through(p.port, "api.openai.com:443", [Buffer.concat([h, later])])).pong).toBe(true);
    for (let i = 0; i < 50 && up.got().length < h.length + later.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(up.got().equals(Buffer.concat([h, later]))).toBe(true);
  });
  it("closes a tunnel whose ClientHello doesn't arrive in time", async () => {
    const up = await upstream(), p = await proxy(up, { helloTimeoutMs: 100 });
    const h = records(hello());
    const started = Date.now();
    expect(await through(p.port, "api.openai.com:443", [h.subarray(0, 20)])).toEqual({ status: "HTTP/1.1 200 Connection Established", pong: false });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(up.dialed()).toBe(0);
    expect(p.refused).toEqual([expect.stringMatching(/^CONNECT api\.openai\.com:443: no complete ClientHello/)]);
  });
  it.each(["[::1]:443", "[2606:4700::6810:1]:443", "104.18.32.47:443", "2130706433:443", "0x7f000001:443"])("refuses the IP-literal CONNECT target %s", async (target) => {
    const up = await upstream(), p = await proxy(up);
    expect((await through(p.port, target, [records(hello())])).status).toBe("HTTP/1.1 403 Forbidden");
    expect(up.dialed()).toBe(0);
  });
});
