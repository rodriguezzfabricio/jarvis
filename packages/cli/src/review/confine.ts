import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";

/**
 * The Codex reviewer's confinement (decision 110). Codex's `--sandbox read-only` stops writes, not reads,
 * so the whole Codex process tree runs under one outer macOS Seatbelt profile instead: reads are denied
 * by default and reopened only for the system, the toolchain, the Codex package, the review checkout,
 * the inputs and outputs Jarvis names, a private CODEX_HOME holding only the auth file, and a private
 * temp folder. Writes go only to those outputs, that home and that temp folder. The only network
 * route is a runner-owned proxy that tunnels to Codex's API hosts and nothing else.
 *
 * Codex's own sandbox is off inside it: on this macOS a Seatbelt-confined process can't apply a second,
 * different profile (`sandbox_apply: Operation not permitted`), so Codex's per-command sandbox would
 * fail every command. The outer profile covers those commands too, since children inherit it.
 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
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

export interface ApiProxy {
  port: number;
  /** Requests the proxy turned away, for the review's raw output. */
  refused: string[];
  close(): Promise<void>;
}
export interface ApiProxyOptions {
  /** Test seam: where an allowed tunnel connects. Production connects to the named host on 443. */
  connectUpstream?: (host: string, port: number) => Socket;
}

/** A CONNECT-only proxy on 127.0.0.1: tunnels to an allowed API host on port 443, refuses everything else. */
export function startApiProxy(options: ApiProxyOptions = {}): Promise<ApiProxy> {
  const upstream = options.connectUpstream ?? ((host: string, port: number) => connect({ host, port }));
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
    const up = upstream(target[1]!, 443);
    track(up);
    up.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
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
  /** The runner's API proxy: the only network destination. */
  proxyPort: number;
}

/** The system and toolchain a confined Codex needs to start, read by real path. */
export const SYSTEM_READ_DIRS = [
  "/System", "/usr/lib", "/usr/share", "/usr/bin", "/usr/sbin", "/usr/libexec", "/bin", "/sbin", "/private/etc",
  "/private/var/db/timezone", "/private/var/db/dyld", "/private/var/db/mds", "/private/var/select",
  "/Library/Apple", "/Library/Preferences/Logging", "/Library/Developer/CommandLineTools", "/opt/homebrew",
] as const;
const SYSTEM_READ_FILES = ["/", "/private/var/db/xcode_select_link", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/autofs_nowait"];
const SYSTEM_EXEC_DIRS = ["/System", "/usr/lib", "/usr/bin", "/usr/sbin", "/usr/libexec", "/bin", "/sbin", "/Library/Apple", "/Library/Developer/CommandLineTools", "/opt/homebrew"];
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
    const execDirs = [codexReadRoot(o.bin)];
    const readFiles = [realpathSync(o.bin), ...(o.readFiles ?? []).map((f) => realpathSync(f))];
    // A folder that holds the runner home (ledger, secrets, hidden checks) is never opened.
    for (const dir of [...readDirs, ...writeDirs, ...execDirs]) {
      if (dir === "/" || under(jarvisDir, dir) || under(lexicalJarvis, dir)) throw new ConfinementError(`refusing to open a folder that holds ${jarvisDir}: ${dir}`);
    }
    proxy = await startApiProxy(o.proxy);
    const profile = join(root, "profile.sb");
    writeFileSync(profile, seatbeltProfile({ readDirs, readFiles, writeDirs, writeFiles, execDirs, proxyPort: proxy.port }), { flag: "wx", mode: 0o600 });
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
