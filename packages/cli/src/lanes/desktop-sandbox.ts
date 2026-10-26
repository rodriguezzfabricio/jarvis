import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import { tempRoots } from "../sandbox/temp.ts";
import { launchDesktop, type DesktopProcess } from "./desktop-process.ts";
import { assertNoBundleLinks, insideTree } from "./materialize.ts";

/** Unavailable confinement is missing coverage, never a successful native smoke test. */
export class NativeSandboxUnavailable extends Error {}
export interface NativeSandboxPolicy {
  /** Canonical paths. Only the copied bundle and two fresh private directories are opened. */
  bundle: string;
  scratch: string;
  home: string;
  jarvisHome?: string;
  hostTmp?: string;
}
export interface NativeSandboxOptions {
  home: string;
  /** Runner-owned build output parent, outside ~/.jarvis. No live candidate may write here. */
  workRoot: string;
}
export interface NativeSandboxDeps {
  session?: (spec: SessionSpec) => Promise<SessionOutcome>;
  launch?: (spec: SessionSpec) => Promise<DesktopProcess>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}
const SANDBOX = "/usr/bin/sandbox-exec";
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// System frameworks only; never the Homebrew prefix, runner config, or system temporary files.
const SYSTEM = ["/System/Library", "/usr/lib", "/usr/bin", "/usr/sbin", "/bin", "/sbin", "/Library/Apple"];
const SYSTEM_DATA = ["/usr/share", "/private/var/db/timezone", "/private/var/db/dyld"];
// WindowServer is needed for native UI. No LaunchServices, AppleEvents, preferences or credential service.
const MACH = ["com.apple.windowserver.active", "com.apple.logd", "com.apple.logd.events", "com.apple.secinitd"];
const overlaps = (a: string, b: string) => insideTree(a, b) || insideTree(b, a);
function literal(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || /["\\\u0000-\u001f\u007f]/.test(path)) throw new NativeSandboxUnavailable("unsafe Seatbelt path");
  return JSON.stringify(path);
}
const subpaths = (paths: readonly string[]) => paths.map(p => `(subpath ${literal(p)})`).join(" ");

function validatePolicy(p: NativeSandboxPolicy): void {
  const denied = [join(p.home, ".jarvis"), ...(p.jarvisHome ? [p.jarvisHome] : [])];
  for (const path of [p.bundle, p.scratch, p.home, ...denied, ...tempRoots(p.hostTmp)]) literal(path);
  if (!p.bundle.endsWith(".app") || overlaps(p.bundle, p.scratch)) throw new NativeSandboxUnavailable("invalid or overlapping native sandbox roots");
  for (const grant of [p.bundle, p.scratch]) {
    if (insideTree(grant, p.home) || denied.some(dir => overlaps(grant, dir)) || tempRoots(p.hostTmp).some(dir => insideTree(grant, dir))) throw new NativeSandboxUnavailable("native sandbox grant includes protected files");
  }
}

/** One outer Seatbelt profile. Metadata resolves paths; data reads and all network default to denied. */
export function nativeSeatbeltProfile(p: NativeSandboxPolicy): string {
  validatePolicy(p);
  const privateDirs = [join(p.scratch, "home"), join(p.scratch, "tmp")];
  const exceptions = [p.bundle, ...privateDirs].map(dir => `(require-not (subpath ${literal(dir)}))`).join(" ");
  const denyOutside = (dir: string) => `(deny file-read* file-write* file-map-executable (require-all (subpath ${literal(dir)}) ${exceptions}))`;
  return [
    "(version 1)", "(deny default)", "(deny network*)",
    "(allow process-exec process-fork)", "(allow signal (target same-sandbox))", "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)", "(allow file-read-metadata file-test-existence)",
    `(allow file-read* file-map-executable ${subpaths(SYSTEM)})`,
    // The root folder itself (not below it): dyld reads it at startup, and every binary aborts without it.
    `(allow file-read* ${subpaths(SYSTEM_DATA)} (literal "/") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))`,
    '(allow file-read* file-write* (literal "/dev/null"))',
    `(allow mach-lookup ${MACH.map(name => `(global-name ${JSON.stringify(name)})`).join(" ")})`,
    `(allow file-read* file-map-executable ${subpaths([p.bundle])})`,
    `(allow file-read* file-write* ${subpaths(privateDirs)})`,
    ...[p.home, ...tempRoots(p.hostTmp)].map(denyOutside),
    `(deny file-read* file-write* file-map-executable ${subpaths([...new Set([join(p.home, ".jarvis"), ...(p.jarvisHome ? [p.jarvisHome] : [])])])})`,
    "",
  ].join("\n");
}

function checkBundle(bundle: string, workRoot: string): string {
  if (!isAbsolute(bundle) || !bundle.endsWith(".app") || lstatSync(bundle).isSymbolicLink()) throw new NativeSandboxUnavailable("invalid native bundle");
  const real = realpathSync(bundle);
  if (!insideTree(workRoot, real) || real === workRoot || !lstatSync(real).isDirectory()) throw new NativeSandboxUnavailable("native bundle escapes runner output");
  assertNoBundleLinks(real);
  const noHardlinks = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isDirectory()) noHardlinks(path);
      else if (stat.nlink !== 1) throw new NativeSandboxUnavailable("native bundle contains a hard link");
    }
  };
  noHardlinks(real);
  if (!lstatSync(join(real, "Contents/Info.plist")).isFile() || !lstatSync(join(real, "Contents/MacOS")).isDirectory()) throw new NativeSandboxUnavailable("incomplete native bundle");
  return real;
}
const good = (r: SessionOutcome) => r.code === 0 && !r.timedOut && !r.overflowed;

async function proveConfinement(scratch: string, spec: (bin: string, args: string[]) => SessionSpec, session: NonNullable<NativeSandboxDeps["session"]>): Promise<void> {
  const token = randomBytes(24).toString("hex");
  const deniedPath = join(scratch, "denied-canary"), allowedPath = join(scratch, "tmp/allowed-canary");
  for (const path of [deniedPath, allowedPath]) writeFileSync(path, token, { flag: "wx", mode: 0o600 });
  const denied = await session(spec("/bin/cat", [deniedPath]));
  if (denied.code !== 1 || denied.timedOut || denied.overflowed || denied.stdout !== "") throw new NativeSandboxUnavailable("native sandbox denied-read canary failed");
  const allowed = await session(spec("/bin/cat", [allowedPath]));
  if (!good(allowed) || allowed.stdout !== token) throw new NativeSandboxUnavailable("native sandbox could not be applied (positive canary failed; nested profiles are unsupported)");
  rmSync(allowedPath);
}

async function executable(bundle: string, spec: (bin: string, args: string[]) => SessionSpec, session: NonNullable<NativeSandboxDeps["session"]>): Promise<string> {
  // The system plist parser runs inside the same sandbox; no candidate text enters a shell command.
  const result = await session(spec("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(bundle, "Contents/Info.plist")]));
  const name = result.stdout.replace(/\n$/, "");
  if (!good(result) || !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}$/.test(name)) throw new NativeSandboxUnavailable("invalid native bundle executable");
  const path = join(bundle, "Contents/MacOS", name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o111) === 0) throw new NativeSandboxUnavailable("native executable is not a private executable file");
  return path;
}

/**
 * Runner only, after build processes stop. sandbox-exec execs the app in place, so the detached
 * group's leader is the app's PID (no `open`, LaunchServices, shell wrapper, or sandbox nesting).
 * Private files survive until group cleanup succeeds. Never retries an unconfined launch.
 */
export async function launchSandboxedDesktop(bundlePath: string, options: NativeSandboxOptions, deps: NativeSandboxDeps = {}): Promise<DesktopProcess> {
  let scratch: string | undefined;
  try {
    if ((deps.platform ?? process.platform) !== "darwin") throw new NativeSandboxUnavailable("native sandbox needs macOS Seatbelt");
    if (!(deps.exists ?? existsSync)(SANDBOX)) throw new NativeSandboxUnavailable("native sandbox-exec unavailable");
    const home = realpathSync(options.home), workRoot = realpathSync(options.workRoot);
    const bundle = checkBundle(bundlePath, workRoot);
    const jarvis = join(home, ".jarvis"), jarvisHome = existsSync(jarvis) ? realpathSync(jarvis) : jarvis;
    scratch = realpathSync(mkdtempSync(join(workRoot, "native-private-")));
    const profileText = nativeSeatbeltProfile({ bundle, scratch, home, jarvisHome });
    for (const dir of ["home", "tmp"]) mkdirSync(join(scratch, dir), { mode: 0o700 });
    const profile = join(scratch, "profile.sb"); writeFileSync(profile, profileText, { flag: "wx", mode: 0o600 });
    const env = { PATH, HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), LANG: "en_US.UTF-8" };
    const spec = (bin: string, args: string[]): SessionSpec => ({ bin: SANDBOX, args: ["-f", profile, bin, ...args], cwd: bundle, env, timeoutMs: 10_000, maxOutputBytes: 4096, killGraceMs: 1000 });
    const session = deps.session ?? runSession;
    await proveConfinement(scratch, spec, session);
    const bin = await executable(bundle, spec, session);
    const app = await (deps.launch ?? launchDesktop)(spec(bin, []));
    const owned = scratch;
    return { pid: app.pid, alive: () => app.alive(), waitForExit: ms => app.waitForExit(ms), stop: async () => { await app.stop(); rmSync(owned, { recursive: true, force: true }); } };
  } catch (error) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    throw error instanceof NativeSandboxUnavailable ? error : new NativeSandboxUnavailable(error instanceof Error ? error.message : String(error));
  }
}
