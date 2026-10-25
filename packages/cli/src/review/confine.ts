import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";

/**
 * The Codex reviewer's confinement (decision 110). Codex's `--sandbox read-only` stops writes, not reads,
 * so the whole Codex process tree runs under one outer macOS Seatbelt profile instead: reads are denied
 * by default and reopened only for the system, the Homebrew kegs the Codex launcher loads (never the
 * rest of the prefix: its var and etc hold services' keys), the Codex package, the review checkout,
 * the inputs and outputs Jarvis names, a private CODEX_HOME holding only the auth file, and a private
 * temp folder. Writes go only to those outputs, that home and that temp folder. The only network
 * route is a runner-owned proxy that tunnels to Codex's API hosts, and only for a TLS handshake that
 * names the host the tunnel was opened for.
 *
 * Codex's own sandbox is off inside it: on this macOS a Seatbelt-confined process can't apply a second,
 * different profile (`sandbox_apply: Operation not permitted`), so Codex's per-command sandbox would
 * fail every command. The outer profile covers those commands too, since children inherit it.
 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** `/opt/homebrew/bin` is there so the launcher's `#!/usr/bin/env node` resolves; only the kegs node loads are readable. */
export const CODEX_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/** Codex's API hosts (observed: chatgpt.com, ab.chatgpt.com, api.openai.com, files.openai.com). */
export const CODEX_API_DOMAINS = ["chatgpt.com", "openai.com"] as const;

export class ConfinementError extends Error {}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** True only for one of Codex's API domains or a subdomain of one, spelled as a lowercase DNS name. */
export function apiHostAllowed(host: string): boolean {
  if (host.length > 253 || !host.split(".").every((label) => LABEL.test(label))) return false;
  return CODEX_API_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The largest ClientHello the proxy waits for. Real ones are 0.5–2 KiB, post-quantum key shares included. */
export const MAX_CLIENT_HELLO = 16 * 1024;
/** How long a tunnel may take to send its whole ClientHello. */
export const CLIENT_HELLO_TIMEOUT_MS = 10_000;
/** encrypted_client_hello and its ESNI predecessor: either hides the real server name from the proxy. */
const ENCRYPTED_HELLO_EXTENSIONS = new Set([0xfe0d, 0xffce]);
const TLS_HANDSHAKE = 0x16, CLIENT_HELLO = 1, MAX_RECORD = 16384;

export type HelloScan = { need: true } | { sni: string } | { refuse: string };

/**
 * Reads the TLS ClientHello at the start of a tunnel, reassembled from as many records as it spans.
 * `need` until it is complete; then its single host name, or why the tunnel must be refused. Anything
 * that isn't a plain, well-formed ClientHello with exactly one host name is refused.
 */
export function scanClientHello(data: Buffer): HelloScan {
  // One pass over the records, linear in the bytes buffered: the declared size is known from the first
  // four handshake bytes, and the fragments are joined only once the whole ClientHello is in hand.
  const fragments: Buffer[] = [];
  let off = 0, have = 0, complete = 0, size: number | undefined;
  const header = Buffer.alloc(4);
  while (off < data.length) {
    if (data[off] !== TLS_HANDSHAKE) return { refuse: off === 0 ? "not TLS" : "a non-handshake record before the ClientHello ended" };
    if (data.length - off < 5) break;
    const length = data.readUInt16BE(off + 3);
    if (data[off + 1] !== 3 || length === 0 || length > MAX_RECORD) return { refuse: "malformed TLS record" };
    const fragment = data.subarray(off + 5, off + 5 + length);
    if (have < 4) fragment.copy(header, have, 0, Math.min(fragment.length, 4 - have));
    fragments.push(fragment); have += fragment.length;
    if (have >= 1 && header[0] !== CLIENT_HELLO) return { refuse: "the first handshake message is not a ClientHello" };
    if (size === undefined && have >= 4) {
      size = 4 + header.readUIntBE(1, 3);
      if (size > MAX_CLIENT_HELLO) return { refuse: `ClientHello too large (${size} bytes)` };
    }
    if (fragment.length < length) break;
    off += 5 + length; complete = have;
    if (size !== undefined && complete >= size) break;
  }
  if (size === undefined || complete < size) return { need: true };
  if (complete > size) return { refuse: "bytes after the ClientHello in its record" };
  return parseClientHello(Buffer.concat(fragments).subarray(4, size));
}

class Malformed extends Error {}
function parseClientHello(body: Buffer): HelloScan {
  let at = 0;
  const take = (n: number) => { if (at + n > body.length) throw new Malformed(); const part = body.subarray(at, at + n); at += n; return part; };
  const u8 = () => take(1)[0]!, u16 = () => take(2).readUInt16BE(0);
  try {
    take(2 + 32);
    const session = u8(); if (session > 32) throw new Malformed(); take(session);
    const suites = u16(); if (suites < 2 || suites % 2) throw new Malformed(); take(suites);
    const compression = u8(); if (compression < 1) throw new Malformed(); take(compression);
    if (at === body.length) return { refuse: "no SNI" };
    if (u16() !== body.length - at) throw new Malformed();
    const seen = new Set<number>();
    let sni: string | undefined;
    while (at < body.length) {
      const type = u16(), data = take(u16());
      if (seen.has(type)) return { refuse: `repeated extension ${type}` };
      seen.add(type);
      if (ENCRYPTED_HELLO_EXTENSIONS.has(type)) return { refuse: "encrypted ClientHello" };
      if (type === 0) {
        const name = serverName(data);
        if (name === undefined) return { refuse: "SNI must hold exactly one host name" };
        sni = name;
      }
    }
    return sni === undefined ? { refuse: "no SNI" } : { sni };
  } catch (error) {
    if (error instanceof Malformed) return { refuse: "malformed ClientHello" };
    throw error;
  }
}
/** The server_name extension's only entry, if it is exactly one host_name. */
function serverName(data: Buffer): string | undefined {
  if (data.length < 5 || data.readUInt16BE(0) !== data.length - 2 || data[2] !== 0) return undefined;
  const length = data.readUInt16BE(3);
  if (length === 0 || 5 + length !== data.length) return undefined;
  return data.subarray(5).toString("latin1");
}

export interface ApiProxy {
  port: number;
  /** Requests the proxy turned away, for the review's raw output. */
  refused: string[];
  close(): Promise<void>;
}
export interface ApiProxyOptions {
  /** Test seam: where an allowed tunnel connects. Production connects to the named host on 443. */
  connectUpstream?: (host: string, port: number) => Socket;
  /** Test seam: how long a tunnel may take to send its ClientHello. */
  helloTimeoutMs?: number;
}

/**
 * A CONNECT-only proxy on 127.0.0.1. It tunnels only to an allowed API host on port 443, and only after
 * the tunnel's first bytes are a complete TLS ClientHello whose SNI is that same host, so a tunnel opened
 * for an API host can't carry a handshake for another site on the same CDN. It dials nothing until then.
 * IP literals never pass `apiHostAllowed` (no label of one ends in an API domain), so they are refused too.
 * The HTTP Host inside the encrypted stream can't be checked without intercepting TLS (decision 110).
 */
export function startApiProxy(options: ApiProxyOptions = {}): Promise<ApiProxy> {
  const upstream = options.connectUpstream ?? ((host: string, port: number) => connect({ host, port }));
  const helloTimeoutMs = options.helloTimeoutMs ?? CLIENT_HELLO_TIMEOUT_MS;
  const refused: string[] = [];
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const server = createServer((req, res) => {
    refused.push(`${req.method ?? "?"} ${req.url ?? ""}`);
    res.writeHead(403, { connection: "close" }).end();
  });
  server.on("connection", track);
  server.on("connect", (req, client: Socket, head: Buffer) => {
    const target = /^([^:\s]+):(\d+)$/.exec(req.url ?? "");
    if (!target || target[2] !== "443" || !apiHostAllowed(target[1]!)) {
      refused.push(`CONNECT ${req.url ?? ""}`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const host = target[1]!;
    let buffered = head, settled = false;
    const refuse = (reason: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); client.off("data", onData);
      refused.push(`CONNECT ${host}:443: ${reason}`);
      client.destroy();
    };
    const timer = setTimeout(() => refuse("no complete ClientHello in time"), helloTimeoutMs);
    const check = () => {
      const scan = scanClientHello(buffered);
      if ("refuse" in scan) return refuse(scan.refuse);
      if ("need" in scan) return buffered.length > 2 * MAX_CLIENT_HELLO ? refuse("ClientHello too large") : undefined;
      if (scan.sni !== host || !apiHostAllowed(scan.sni)) return refuse(`SNI ${scan.sni} is not the CONNECT host`);
      settled = true; clearTimeout(timer); client.off("data", onData); client.pause();
      const up = upstream(host, 443);
      track(up);
      up.once("connect", () => {
        up.write(buffered);
        up.pipe(client);
        client.pipe(up);
        client.resume();
      });
      up.on("error", () => client.destroy());
      client.on("close", () => up.destroy());
    };
    const onData = (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); check(); };
    client.on("error", () => { clearTimeout(timer); client.destroy(); });
    client.once("close", () => { settled = true; clearTimeout(timer); });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.on("data", onData);
    if (buffered.length) check();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as AddressInfo).port,
      refused,
      close: () => new Promise<void>((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
    }));
  });
}

export interface SeatbeltPolicy {
  /** Real paths readable with everything below them. */
  readDirs: string[];
  readFiles: string[];
  /** Real paths readable and writable with everything below them. */
  writeDirs: string[];
  writeFiles: string[];
  /** Real paths whose executables and libraries may be mapped (the toolchain and the Codex package). */
  execDirs: string[];
  /** Real paths denied after every grant, even inside an allowed folder (Homebrew's var and etc). */
  denyDirs: string[];
  /** The runner's API proxy: the only network destination. */
  proxyPort: number;
}

/** Homebrew's prefix. Its var and etc hold services' keys and data (a Tor hidden-service key, PostgreSQL). */
export const HOMEBREW = "/opt/homebrew";
/** The parts of a Homebrew prefix the profile denies outright, whatever else it opens. */
export const homebrewDenied = (brew: string) => [join(brew, "var"), join(brew, "etc")];

const LC_RPATH = 0x8000001c;
/** LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB; never LC_ID_DYLIB. */
const DYLIB_LOADS = new Set([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023]);
const MACHO_64 = 0xfeedfacf, MACHO_32 = 0xfeedface, FAT = 0xcafebabe, FAT_64 = 0xcafebabf;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, readSync(fd, buffer, 0, length, position));
}
interface Image { libraries: string[]; rpaths: string[]; interpreter?: string[] }
/** What a file asks the loader for: a script's `#!` line, or a Mach-O image's libraries and rpaths (every slice). */
function imageOf(path: string): Image {
  const fd = openSync(path, "r");
  try {
    const head = readAt(fd, 0, 4096);
    if (head[0] === 0x23 && head[1] === 0x21) return { libraries: [], rpaths: [], interpreter: head.subarray(2).toString("latin1").split("\n")[0]!.trim().split(/[ \t]+/) };
    const image: Image = { libraries: [], rpaths: [] };
    if (head.length < 8) return image;
    const slices: number[] = [];
    const fat = head.readUInt32BE(0), count = head.readUInt32BE(4);
    if ((fat === FAT || fat === FAT_64) && count > 0 && count <= 16) {
      const entry = fat === FAT_64 ? 32 : 20;
      for (let i = 0; i < count && 8 + (i + 1) * entry <= head.length; i++) {
        const at = 8 + i * entry;
        slices.push(fat === FAT_64 ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8));
      }
    } else slices.push(0);
    for (const base of slices) {
      const header = readAt(fd, base, 32);
      if (header.length < 28) continue;
      const magic = header.readUInt32LE(0);
      if (magic !== MACHO_64 && magic !== MACHO_32) continue;
      const ncmds = header.readUInt32LE(16), size = header.readUInt32LE(20);
      if (size > 4 * 1024 * 1024) throw new ConfinementError(`unreadable Mach-O image: ${path}`);
      const cmds = readAt(fd, base + (magic === MACHO_64 ? 32 : 28), size);
      for (let i = 0, at = 0; i < ncmds && at + 8 <= cmds.length; i++) {
        const cmd = cmds.readUInt32LE(at), cmdsize = cmds.readUInt32LE(at + 4);
        if (cmdsize < 12 || at + cmdsize > cmds.length) throw new ConfinementError(`unreadable Mach-O image: ${path}`);
        if (DYLIB_LOADS.has(cmd) || cmd === LC_RPATH) {
          const field = cmds.subarray(at + cmds.readUInt32LE(at + 8), at + cmdsize), end = field.indexOf(0);
          (cmd === LC_RPATH ? image.rpaths : image.libraries).push(field.subarray(0, end < 0 ? field.length : end).toString("utf8"));
        }
        at += cmdsize;
      }
    }
    return image;
  } finally { closeSync(fd); }
}

/**
 * The Homebrew kegs a confined launcher needs: the keg of its interpreter (a `#!` line, `env` resolved on
 * `searchPath`) and of every library those images load, followed through @rpath, @loader_path and
 * @executable_path. Libraries outside the prefix are the system's and already open. A library inside the
 * prefix but outside `Cellar/<name>/<version>` is refused: nothing else of the prefix is ever opened.
 */
export function homebrewKegs(bin: string, o: { homebrew?: string; searchPath?: string } = {}): string[] {
  const root = o.homebrew ?? HOMEBREW;
  const brew = existsSync(root) ? realpathSync(root) : root;
  const searchPath = (o.searchPath ?? CODEX_PATH).split(":").filter(isAbsolute);
  const kegs = new Set<string>(), seen = new Set<string>();
  const kegOf = (real: string) => {
    const parts = real.slice(brew.length + 1).split("/");
    if (parts[0] !== "Cellar" || parts.length < 4) throw new ConfinementError(`the Codex launcher loads a file outside a Homebrew keg: ${real}`);
    return join(brew, ...parts.slice(0, 3));
  };
  const existing = (path: string) => (isAbsolute(path) && existsSync(path) && statSync(path).isFile() ? path : undefined);
  const visit = (path: string, executable: string | undefined, inherited: readonly string[]) => {
    const real = realpathSync(path);
    if (seen.has(real)) return;
    seen.add(real);
    if (under(real, brew)) kegs.add(kegOf(real));
    const image = imageOf(real);
    if (image.interpreter) {
      const [program, ...args] = image.interpreter;
      if (!program || !existing(program)) return;
      visit(program, undefined, []);
      if (basename(program) !== "env") return;
      const name = args.find((a) => !a.startsWith("-") && !a.includes("="));
      const found = name && (name.includes("/") ? existing(name) : searchPath.map((d) => existing(join(d, name))).find(Boolean));
      if (found) visit(found, undefined, []);
      return;
    }
    const exe = executable ?? real;
    const at = (p: string) => p.startsWith("@loader_path") ? join(dirname(real), p.slice(12)) : p.startsWith("@executable_path") ? join(dirname(exe), p.slice(16)) : p;
    const rpaths = [...image.rpaths.map(at), ...inherited];
    for (const library of image.libraries) {
      const candidates = library.startsWith("@rpath/") ? rpaths.map((r) => join(r, library.slice(7))) : [at(library)];
      const found = candidates.map((c) => existing(resolve(c))).find(Boolean);
      if (found && under(realpathSync(found), brew)) visit(found, exe, rpaths);
    }
  };
  visit(bin, undefined, []);
  return [...kegs].sort();
}

/** The system and toolchain a confined Codex needs to start, read by real path. */
export const SYSTEM_READ_DIRS = [
  "/System", "/usr/lib", "/usr/share", "/usr/bin", "/usr/sbin", "/usr/libexec", "/bin", "/sbin", "/private/etc",
  "/private/var/db/timezone", "/private/var/db/dyld", "/private/var/db/mds", "/private/var/select",
  "/Library/Apple", "/Library/Preferences/Logging", "/Library/Developer/CommandLineTools",
] as const;
const SYSTEM_READ_FILES = ["/", "/private/var/db/xcode_select_link", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/autofs_nowait"];
const SYSTEM_EXEC_DIRS = ["/System", "/usr/lib", "/usr/bin", "/usr/sbin", "/usr/libexec", "/bin", "/sbin", "/Library/Apple", "/Library/Developer/CommandLineTools"];
/** Directory, logging, trust and power services; never LaunchServices, AppleEvents or preferences, which act outside the profile. */
const MACH_SERVICES = [
  "com.apple.analyticsd", "com.apple.analyticsd.messagetracer", "com.apple.appsleep", "com.apple.bsd.dirhelper", "com.apple.diagnosticd",
  "com.apple.dt.automationmode.reader", "com.apple.espd", "com.apple.logd", "com.apple.logd.events", "com.apple.secinitd",
  "com.apple.system.DirectoryService.libinfo_v1", "com.apple.system.logger", "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.trustd", "com.apple.trustd.agent",
  "com.apple.TrustEvaluationAgent", "com.apple.xpc.activity.unmanaged", "com.apple.PowerManagement.control", "com.apple.SystemConfiguration.configd",
];

/** A path as an SBPL string literal; anything that could end the literal or the line is refused. */
function sbplPath(path: string): string {
  if (!isAbsolute(path) || /["\\\u0000-\u001f\u007f]/.test(path)) throw new ConfinementError(`path can't be placed in a Seatbelt profile: ${JSON.stringify(path)}`);
  return JSON.stringify(path);
}
const subpaths = (paths: readonly string[]) => paths.map((p) => `(subpath ${sbplPath(p)})`).join(" ");
const literals = (paths: readonly string[]) => paths.map((p) => `(literal ${sbplPath(p)})`).join(" ");

/** Closed by default: everything not opened here is denied, network included. */
export function seatbeltProfile(policy: SeatbeltPolicy): string {
  if (!Number.isInteger(policy.proxyPort) || policy.proxyPort < 1 || policy.proxyPort > 65535) throw new ConfinementError("invalid proxy port");
  const rule = (ops: string, filters: string) => (filters ? `(allow ${ops} ${filters})` : "");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow sysctl-write (sysctl-name \"kern.grade_cputype\"))",
    "(allow iokit-open (iokit-registry-entry-class \"RootDomainUserClient\"))",
    "(allow system-mac-syscall (mac-policy-name \"vnguard\"))",
    "(allow system-mac-syscall (require-all (mac-policy-name \"Sandbox\") (mac-syscall-number 67)))",
    "(allow ipc-posix-sem)",
    "(allow ipc-posix-shm-read* (ipc-posix-name \"apple.shm.notification_center\"))",
    `(allow mach-lookup ${MACH_SERVICES.map((s) => `(global-name ${JSON.stringify(s)})`).join(" ")})`,
    "(allow pseudo-tty)",
    // Metadata (stat, readlink) is open everywhere so paths resolve; contents and listings are not.
    "(allow file-read-metadata file-test-existence)",
    rule("file-read*", `${subpaths(SYSTEM_READ_DIRS)} ${literals(SYSTEM_READ_FILES)}`),
    rule("file-map-executable", subpaths([...SYSTEM_EXEC_DIRS, ...policy.execDirs])),
    "(allow file-read* file-write* (literal \"/dev/null\") (literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (literal \"/dev/ptmx\") (regex #\"^/dev/fd/[0-9]+$\") (regex #\"^/dev/ttys[0-9]+$\"))",
    "(allow file-ioctl (literal \"/dev/tty\") (literal \"/dev/ptmx\") (regex #\"^/dev/ttys[0-9]+$\"))",
    rule("file-read*", `${subpaths([...policy.readDirs, ...policy.execDirs])} ${literals(policy.readFiles)}`.trim()),
    rule("file-read* file-write*", `${subpaths(policy.writeDirs)} ${literals(policy.writeFiles)}`.trim()),
    // Last, so no grant above can reopen them.
    policy.denyDirs.length ? `(deny file-read* file-write* file-map-executable ${subpaths(policy.denyDirs)})` : "",
    `(allow network-outbound (remote ip "localhost:${policy.proxyPort}"))`,
    "",
  ].filter((line, i, all) => line !== "" || i === all.length - 1).join("\n");
}

/** The folder holding the Codex binary and its runtime: the npm package root for the pinned `bin/codex.js`. */
export function codexReadRoot(bin: string): string {
  const real = realpathSync(bin);
  return basename(dirname(real)) === "bin" && real.endsWith(".js") ? dirname(dirname(real)) : dirname(real);
}

/** macOS's own root bundle. Codex's platform verifier would need securityd, which the profile doesn't open. */
export const CA_BUNDLE = "/private/etc/ssl/cert.pem";

/** The only environment a confined Codex sees. */
export function codexEnvironment(jail: { codexHome: string; tmp: string; proxyPort: number }, user: string = userInfo().username): Record<string, string> {
  const proxy = `http://127.0.0.1:${jail.proxyPort}`;
  return {
    HOME: join(jail.codexHome, "home"), USER: user, PATH: CODEX_PATH, CODEX_HOME: jail.codexHome, TMPDIR: jail.tmp,
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, CODEX_CA_CERTIFICATE: CA_BUNDLE, SSL_CERT_FILE: CA_BUNDLE,
    // Homebrew's node opens <prefix>/etc/openssl@3/openssl.cnf at startup and exits if it can't; that folder stays denied.
    OPENSSL_CONF: "/dev/null",
  };
}

export interface CodexJailOptions {
  /** The runner's home: the auth file is `<home>/.jarvis/codex-home/auth.json`, by real path. */
  home: string;
  /** The absolute Codex binary. */
  bin: string;
  /** The review checkout, read-only. */
  workspace: string;
  /** Inputs Jarvis hands the reviewer by path (a schema), read-only. */
  readFiles?: string[];
  /** Outputs the reviewer writes (its verdict folder). */
  writeDirs?: string[];
  session?: (spec: SessionSpec) => Promise<SessionOutcome>;
  /** Test seams. */
  sandboxExec?: string;
  platform?: NodeJS.Platform;
  proxy?: ApiProxyOptions;
  /** The Homebrew prefix (default /opt/homebrew): only the kegs the launcher loads are opened, and var and etc are denied. */
  homebrew?: string;
}
export interface CodexJail {
  root: string;
  codexHome: string;
  tmp: string;
  /** A private output folder (readable and writable). */
  out: string;
  profile: string;
  env: Record<string, string>;
  proxy: ApiProxy;
  wrap(bin: string, args: readonly string[]): { bin: string; args: string[] };
  close(): Promise<void>;
}

/** Checks that cost nothing and must hold before any confined review: refuses rather than run unconfined. */
export function assertConfinable(o: Pick<CodexJailOptions, "bin" | "sandboxExec" | "platform">): void {
  if ((o.platform ?? process.platform) !== "darwin") throw new ConfinementError("Codex reviews are confined with macOS Seatbelt; this platform has none");
  if (!existsSync(o.sandboxExec ?? SANDBOX_EXEC)) throw new ConfinementError("sandbox-exec is missing");
  if (!isAbsolute(o.bin) || !existsSync(o.bin)) throw new ConfinementError("the Codex binary is missing");
}

/**
 * Builds the profile, starts the proxy, and proves the profile holds before anything runs under it: a
 * canary beside the allowed folders must be unreadable and a file inside them readable. Any failure
 * throws and leaves nothing running.
 */
export async function openCodexJail(o: CodexJailOptions): Promise<CodexJail> {
  assertConfinable(o);
  const sandboxExec = o.sandboxExec ?? SANDBOX_EXEC;
  const session = o.session ?? runSession;
  const lexicalJarvis = join(realpathSync(o.home), ".jarvis");
  const jarvisDir = existsSync(lexicalJarvis) ? realpathSync(lexicalJarvis) : lexicalJarvis;
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "jcx-")));
  let proxy: ApiProxy | undefined;
  try {
    const codexHome = join(root, "codex-home"), tmp = join(root, "tmp"), out = join(root, "out");
    for (const dir of [codexHome, join(codexHome, "home"), tmp, out]) mkdirSync(dir, { mode: 0o700 });
    // The private home holds only the auth file, by its real path (it may be a link to the user's own).
    const writeFiles: string[] = [];
    const auth = join(jarvisDir, "codex-home", "auth.json");
    if (existsSync(auth)) {
      const target = realpathSync(auth);
      if (!lstatSync(target).isFile()) throw new ConfinementError("the Codex auth file is not a regular file");
      symlinkSync(target, join(codexHome, "auth.json"));
      writeFiles.push(target);
    }
    const readDirs = [realpathSync(o.workspace)];
    const writeDirs = [codexHome, tmp, out, ...(o.writeDirs ?? []).map((d) => realpathSync(d))];
    const brew = o.homebrew ?? HOMEBREW;
    const execDirs = [codexReadRoot(o.bin), ...homebrewKegs(o.bin, { homebrew: brew })];
    const denyDirs = homebrewDenied(existsSync(brew) ? realpathSync(brew) : brew);
    const readFiles = [realpathSync(o.bin), ...(o.readFiles ?? []).map((f) => realpathSync(f))];
    // A folder that holds the runner home (ledger, secrets, hidden checks) is never opened.
    for (const dir of [...readDirs, ...writeDirs, ...execDirs]) {
      if (dir === "/" || under(jarvisDir, dir) || under(lexicalJarvis, dir)) throw new ConfinementError(`refusing to open a folder that holds ${jarvisDir}: ${dir}`);
    }
    proxy = await startApiProxy(o.proxy);
    const profile = join(root, "profile.sb");
    writeFileSync(profile, seatbeltProfile({ readDirs, readFiles, writeDirs, writeFiles, execDirs, denyDirs, proxyPort: proxy.port }), { flag: "wx", mode: 0o600 });
    const token = randomBytes(16).toString("hex");
    const canary = join(root, "canary"), probe = join(tmp, "probe");
    writeFileSync(canary, token, { mode: 0o600 });
    writeFileSync(probe, token, { mode: 0o600 });
    const cat = (path: string) => session({ bin: sandboxExec, args: ["-f", profile, "/bin/cat", path], cwd: tmp, env: { PATH: CODEX_PATH }, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const denied = await cat(canary), allowed = await cat(probe);
    if (denied.code === 0 || denied.stdout.includes(token)) throw new ConfinementError("the Seatbelt profile let a canary outside the allowed folders be read");
    if (allowed.code !== 0 || allowed.stdout !== token) throw new ConfinementError(`the Seatbelt profile could not be applied (exit ${String(allowed.code)}): ${allowed.stderr.trim().slice(0, 200)}`);
    rmSync(probe);
    const env = codexEnvironment({ codexHome, tmp, proxyPort: proxy.port });
    const open = proxy;
    return {
      root, codexHome, tmp, out, profile, env, proxy: open,
      wrap: (bin, args) => ({ bin: sandboxExec, args: ["-f", profile, bin, ...args] }),
      close: async () => { await open.close(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await proxy?.close();
    rmSync(root, { recursive: true, force: true });
    throw error instanceof ConfinementError ? error : new ConfinementError(error instanceof Error ? error.message : String(error));
  }
}
