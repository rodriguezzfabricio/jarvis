import { createServer, type Server, type RequestListener, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NtfyNotifier } from "../../packages/cli/src/notify/ntfy.ts";
import { actionsFor } from "../../packages/cli/src/notify/notifier.ts";

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});
/** Settles a promise into a value, so a rejection fails as an assertion rather than a runner error. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: string }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error: String(error) }));
}
// Exercise a fake HTTP server's request handler in memory when the worker sandbox denies listen.
// This keeps wire-format assertions active; the separate smoke test uses real loopback fetch.
async function fake(handler: RequestListener) {
  vi.stubGlobal("fetch", async (url: URL | string, options: RequestInit = {}) => {
    const target = new URL(url);
    const req = Readable.from(options.body ? [String(options.body)] : []);
    Object.assign(req, { url: target.pathname + target.search, method: options.method ?? "GET" });
    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      const res = {
        writeHead(code: number) { status = code; return res; },
        end(body = "") { resolve(new Response(body, { status })); },
      };
      Promise.resolve(handler(req as IncomingMessage, res as unknown as ServerResponse)).catch(reject);
    });
  });
  return "http://127.0.0.1:12345";
}

describe("ntfy HTTP adapter", () => {
  it("publishes JSON with fixed-body HTTP POST buttons to the reply topic", async () => {
    const received: { path: string; method: string; body: string }[] = [];
    const baseUrl = await fake(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      received.push({ path: req.url!, method: req.method!, body });
      res.end('{}');
    });
    const n = new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply" });
    await n.send({ kind: "approval", text: "Short summary" }, actionsFor("approval", "r", "n"));
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.path).toBe("/");
    expect(JSON.parse(received[0]!.body)).toMatchObject({ topic: "out", message: "Short summary", actions: [
      { action: "http", label: "Approve", url: `${baseUrl}/reply`, method: "POST", body: "approve:r:n" },
      { action: "http", label: "Reject", url: `${baseUrl}/reply`, method: "POST", body: "reject:r:n" },
    ] });
    await n.send({ kind: "finished", text: "🙂".repeat(2000) }, []);
    expect(Buffer.byteLength(JSON.parse(received[1]!.body).message)).toBeLessThan(4096);
    await n.send({ kind: "usage-wait", text: "short", waitMs: 1 }, []);
    expect(received).toHaveLength(2);
    await expect(n.send({ kind: "question", text: "x" }, Array(4).fill(actionsFor("question", "r", "n")[0]))).rejects.toThrow(/3/);
    expect(received).toHaveLength(2);
  });
  it("polls NDJSON, ignores control events, and advances since only after a valid response", async () => {
    const paths: string[] = [];
    let response = '{"id":"open","event":"open"}\n{"id":"one","event":"message","message":"hello"}\n{"id":"two","event":"message","message":"approve:r:n"}\n';
    const baseUrl = await fake((req, res) => { paths.push(req.url!); res.end(response); });
    const n = new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply", since: "saved" });
    expect(await settled(n.poll())).toEqual({ value: [{ id: "one", text: "hello" }, { id: "two", text: "approve:r:n" }] });
    expect(paths[0]).toBe("/reply/json?poll=1&since=saved");
    expect(n.lastId).toBe("two");
    response = '{"id":"three","event":"message","message":"ok"}\nbad';
    await expect(n.poll()).rejects.toThrow();
    expect(n.lastId).toBe("two");
    response = '';
    expect(await n.poll()).toEqual([]);
    expect(paths[2]).toBe("/reply/json?poll=1&since=two");
  });
  it("refuses HTTP failures, redirects, malformed events and unsafe topic paths", async () => {
    let status = 503;
    let response = '';
    const baseUrl = await fake((_req, res) => { res.writeHead(status, { Location: '/elsewhere' }); res.end(response); });
    const n = new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply" });
    await expect(n.send({ kind: "blocked", text: "Blocked" }, [])).rejects.toThrow(/503/);
    status = 302;
    await expect(n.poll()).rejects.toThrow(/302/);
    status = 200;
    response = '{"event":"message","message":"missing id"}';
    await expect(n.poll()).rejects.toThrow();
    expect(n.lastId).toMatch(/^\d+$/);
    expect(() => new NtfyNotifier({ baseUrl, topic: "../bad", replyTopic: "reply" })).toThrow();
  });
  it("defaults since to construction time and preserves an explicit saved cursor", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_999);
    try {
      const paths: string[] = [];
      const baseUrl = await fake((req, res) => { paths.push(req.url!); res.end(''); });
      const n = new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply" });
      now.mockReturnValue(1_800_000_060_000);
      await n.poll();
      expect(n.lastId).toBe("1800000000");
      expect(paths).toEqual(["/reply/json?poll=1&since=1800000000"]);
    } finally { now.mockRestore(); }
  });
  it("skips unknown event types while strictly validating message events", async () => {
    const baseUrl = await fake((_req, res) => res.end('{"event":"future","id":7,"message":null}\n{"event":"message","id":"known","message":"hello"}\n'));
    const n = new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply", since: "saved" });
    expect(await settled(n.poll())).toEqual({ value: [{ id: "known", text: "hello" }] });
    expect(n.lastId).toBe("known");
  });
  it("permits plain HTTP only for loopback hosts", () => {
    for (const baseUrl of ["http://ntfy.example", "http://192.168.1.4", "http://0.0.0.0", "http://127.0.0.1.example", "http://[::2]"]) {
      expect(() => new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply" })).toThrow(/https|loopback/i);
    }
    for (const baseUrl of ["http://127.0.0.1", "http://127.2.3.4", "http://localhost", "http://[::1]", "https://ntfy.example"]) {
      expect(() => new NtfyNotifier({ baseUrl, topic: "out", replyTopic: "reply" })).not.toThrow();
    }
  });

});

// No external service or credential. The integrator can run this outside the worker sandbox.
it("publishes and polls through a real 127.0.0.1 HTTP server", async (context) => {
  const received: string[] = [];
  server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      received.push(body);
      res.end('{}');
    } else res.end('{"event":"message","id":"local","message":"hello"}\n');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    context.skip("worker sandbox denies 127.0.0.1 listen (EPERM); HTTP contracts run in memory");
    return;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const n = new NtfyNotifier({ baseUrl: `http://127.0.0.1:${address.port}`, topic: "out", replyTopic: "reply" });
  await n.send({ kind: "finished", text: "Done" }, []);
  expect(JSON.parse(received[0]!)).toMatchObject({ topic: "out", message: "Done" });
  expect(await n.poll()).toEqual([{ id: "local", text: "hello" }]);
});
