import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { apiHostAllowed, assertConfinable, openCodexJail, seatbeltProfile, startApiProxy, type ApiProxy } from "../../packages/cli/src/review/confine.ts";

const roots: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const darwin = process.platform === "darwin";
const temp = (name: string) => { const r = realpathSync(mkdtempSync(join(tmpdir(), name))); roots.push(r); return r; };
const policy = { readDirs: ["/review/checkout"], readFiles: ["/review/schema.json"], writeDirs: ["/review/out"], writeFiles: ["/review/auth.json"], execDirs: ["/review/codex"], proxyPort: 4242 };

describe("Codex API host allowlist", () => {
  it.each(["chatgpt.com", "ab.chatgpt.com", "openai.com", "api.openai.com", "files.openai.com"])("allows %s", (host) => expect(apiHostAllowed(host)).toBe(true));
  it.each(["example.com", "openai.com.example.com", "evilopenai.com", "chatgpt.com.", "API.OPENAI.COM", "127.0.0.1", "localhost", "api.openai.com:443", "-x.openai.com", ""])("refuses %s", (host) => expect(apiHostAllowed(host)).toBe(false));
});

describe("Seatbelt profile", () => {
  const text = seatbeltProfile(policy);
  it("is closed by default and never reopens everything", () => {
    expect(text.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
    expect(text).not.toMatch(/\(allow default\)/);
    expect(text).not.toMatch(/\(allow file-read\*\)/);
    expect(text).not.toMatch(/\(allow file-write\*\)/);
    expect(text).not.toMatch(/\(allow network\*|\(allow network-outbound\)|\(allow network-inbound|\(allow network-bind/);
  });
  it("opens the network only to the proxy port on loopback", () => {
    expect(text.match(/network[^\n]*/g)).toEqual(['network-outbound (remote ip "localhost:4242"))']);
  });
  it("never opens LaunchServices, AppleEvents, preferences or the keychain daemon", () => {
    for (const name of ["coreservices", "launchservicesd", "appleevents", "cfprefsd", "SecurityServer", "pasteboard"]) expect(text).not.toContain(name);
    expect(text).not.toMatch(/user-preference|appleevent-send|lsopen/);
  });
  it("opens the named folders and files and no other user folder", () => {
    expect(text).toContain('(allow file-read* (subpath "/review/checkout") (subpath "/review/codex") (literal "/review/schema.json"))');
    expect(text).toContain('(allow file-read* file-write* (subpath "/review/out") (literal "/review/auth.json"))');
    expect(text).not.toMatch(/"\/Users|"\/private\/var\/folders|"\/private\/tmp|"\/tmp/);
    expect(text).not.toMatch(/subpath "\/usr"\)|subpath "\/Library"\)|subpath "\/private\/var"\)|subpath "\/private"\)/);
  });
  it.each(['/a"b', "/a\\b", "/a\nb", "relative/path", "/a\u0000b"])("refuses a path it can't place safely: %j", (bad) => {
    expect(() => seatbeltProfile({ ...policy, readDirs: [bad] })).toThrow(/Seatbelt profile/);
  });
  it.each([0, -1, 65536, 1.5, Number.NaN])("refuses proxy port %s", (port) => expect(() => seatbeltProfile({ ...policy, proxyPort: port })).toThrow(/port/));
});

describe("API proxy", () => {
  async function proxy(upstream?: () => Socket): Promise<ApiProxy> {
    const p = await startApiProxy(upstream ? { connectUpstream: upstream } : {}); closers.push(() => p.close()); return p;
  }
  const tunnel = (port: number, target: string) => new Promise<string>((resolve) => {
    const s = connect(port, "127.0.0.1"); let reply = "";
    s.once("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("data", (d) => { reply += d; if (reply.includes("\r\n\r\n")) { s.write("ping"); } if (reply.includes("pong")) { s.destroy(); resolve(reply); } if (reply.startsWith("HTTP/1.1 403")) { s.destroy(); resolve(reply.split("\r\n")[0]!); } });
    s.once("close", () => resolve(reply.split("\r\n")[0] ?? ""));
    s.once("error", (e) => resolve(`error:${(e as NodeJS.ErrnoException).code}`));
  });
  it("tunnels an allowed host on 443 to its upstream", async () => {
    const echo: Server = createServer((s) => s.on("data", () => s.write("pong"))); closers.push(() => echo.close());
    await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done));
    const targets: string[] = [];
    const p = await proxy(() => connect((echo.address() as { port: number }).port, "127.0.0.1"));
    const reply = await tunnel(p.port, "api.openai.com:443");
    expect(reply).toContain("HTTP/1.1 200 Connection Established");
    expect(reply).toContain("pong");
    expect(p.refused).toEqual(targets);
  });
  it.each(["example.com:443", "api.openai.com:80", "api.openai.com:8443", "127.0.0.1:443", "localhost:443", "api.openai.com"])("refuses CONNECT %s", async (target) => {
    let dialed = false;
    const p = await proxy(() => { dialed = true; return connect(1, "127.0.0.1"); });
    expect(await tunnel(p.port, target)).toBe("HTTP/1.1 403 Forbidden");
    expect(dialed).toBe(false);
    expect(p.refused).toEqual([`CONNECT ${target}`]);
  });
  it("refuses plain HTTP requests", async () => {
    const p = await proxy(() => { throw new Error("never dialed"); });
    const status = await new Promise<number | undefined>((resolve) => {
      request({ host: "127.0.0.1", port: p.port, path: "http://example.com/", headers: { host: "example.com" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(undefined)).end();
    });
    expect(status).toBe(403);
    expect(p.refused).toEqual(["GET http://example.com/"]);
  });
});

describe("Codex jail", () => {
  function fixture() {
    const root = temp("review-jail-");
    const home = join(root, "home"), workspace = join(root, "checkout"), tools = join(root, "tools"), out = join(root, "out");
    for (const d of [home, workspace, tools, out]) mkdirSync(d);
    const bin = join(tools, "codex"); writeFileSync(bin, "#!/bin/sh\n", { mode: 0o700 });
    return { root, home, workspace, tools, out, bin };
  }
  it("refuses a platform without Seatbelt and a missing sandbox-exec or binary", () => {
    const f = fixture();
    expect(() => assertConfinable({ bin: f.bin, platform: "linux" })).toThrow(/Seatbelt/);
    expect(() => assertConfinable({ bin: f.bin, platform: "darwin", sandboxExec: join(f.root, "none") })).toThrow(/sandbox-exec/);
    expect(() => assertConfinable({ bin: join(f.root, "none"), platform: "darwin", sandboxExec: "/bin/sh" })).toThrow(/binary/);
  });
  it.skipIf(!darwin)("refuses to open a folder that holds the runner home", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".jarvis"));
    await expect(openCodexJail({ home: f.home, bin: f.bin, workspace: f.home })).rejects.toThrow(/refusing to open/);
    await expect(openCodexJail({ home: f.home, bin: f.bin, workspace: f.workspace, writeDirs: [f.root] })).rejects.toThrow(/refusing to open/);
  });
  it.skipIf(!darwin)("refuses to open the real folder behind a linked runner home", async () => {
    const f = fixture();
    const real = join(f.root, "elsewhere", "jarvis"); mkdirSync(real, { recursive: true });
    symlinkSync(real, join(f.home, ".jarvis"));
    await expect(openCodexJail({ home: f.home, bin: f.bin, workspace: join(f.root, "elsewhere") })).rejects.toThrow(/refusing to open/);
  });
  it.skipIf(!darwin)("gives Codex a private home holding only the auth link, and removes everything on close", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".jarvis/codex-home"), { recursive: true });
    writeFileSync(join(f.home, ".jarvis/codex-home/auth.json"), "{\"placeholder\":true}");
    writeFileSync(join(f.home, ".jarvis/codex-home/history.sqlite"), "history");
    const jail = await openCodexJail({ home: f.home, bin: f.bin, workspace: f.workspace, writeDirs: [f.out] });
    expect(readdirSync(jail.codexHome).sort()).toEqual(["auth.json", "home"]);
    expect(readFileSync(join(jail.codexHome, "auth.json"), "utf8")).toBe("{\"placeholder\":true}");
    expect(jail.env.CODEX_HOME).toBe(jail.codexHome);
    expect(jail.wrap("/x/codex", ["--version"])).toEqual({ bin: "/usr/bin/sandbox-exec", args: ["-f", jail.profile, "/x/codex", "--version"] });
    const profile = readFileSync(jail.profile, "utf8");
    expect(profile).toContain(`(literal ${JSON.stringify(join(f.home, ".jarvis/codex-home/auth.json"))})`);
    expect(profile).not.toContain(`(subpath ${JSON.stringify(join(f.home, ".jarvis/codex-home"))})`);
    const port = jail.proxy.port;
    await jail.close();
    expect(existsSync(jail.root)).toBe(false);
    await expect(new Promise((resolve, reject) => connect(port, "127.0.0.1").once("connect", resolve).once("error", reject))).rejects.toThrow(/ECONNREFUSED/);
  });
  it.skipIf(!darwin)("leaves nothing behind when the probe fails", async () => {
    const f = fixture();
    const ignoring = join(f.tools, "ignoring-sandbox-exec");
    writeFileSync(ignoring, "#!/bin/sh\nshift 2\nexec \"$@\"\n", { mode: 0o700 });
    const profiles: string[] = [];
    const session = (spec: SessionSpec) => { profiles.push(spec.args[1]!); return runSession(spec); };
    await expect(openCodexJail({ home: f.home, bin: f.bin, workspace: f.workspace, sandboxExec: ignoring, session })).rejects.toThrow(/canary/);
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) expect(existsSync(dirname(p))).toBe(false);
  });
});
