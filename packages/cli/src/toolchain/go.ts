import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISK_FLOOR_BYTES, GO_TOOLCHAIN_ZIPS } from "../config/pins.ts";
import type { ZipLimits } from "./zip.ts";

/**
 * A pinned, offline Go for task sessions (decision 123). A session's own Go was the host's (Homebrew
 * go1.24.5), with an empty module cache, so a project whose go.mod asks for a newer Go made `go` try to
 * download that toolchain, and inside the sandbox Go's TLS check fails (it verifies through macOS's
 * trust service, which Seatbelt closes: `x509: OSStatus -26276`). Sessions could build and test nothing.
 *
 * When a fixture holds the toolchain go.mod asks for, the runner unpacks that toolchain once per run into a
 * folder of its own, and sessions get it with the fixture's module cache, both reopened read-only, plus
 * GOTOOLCHAIN=local and GOPROXY=off, so nothing is downloaded. Their build cache stays private and writable
 * (the session cache). The fixture layout is the gate's: an extracted module cache (GOMODCACHE) whose
 * cache/download holds the toolchain module's zip. It fails closed: only an absent fixture, or no zip for the
 * version go.mod asks for, means today's behaviour (the host's go, reported as such). A zip that is present but
 * unpinned, not the pinned one, malformed, too big, too slow, or anything else wrong stops the run before any
 * session, with "refused:" and the reason.
 */

/** What the session gets: folders it reads but never writes, PATH entries inside them, and Go's variables. */
export interface SessionToolchain {
  version: string;
  readOnlyDirs: string[];
  pathPrefix: string[];
  env: Record<string, string>;
}

/** What a run records about its sessions' Go. */
export type ToolchainReport =
  | { status: "ready"; version: string; modCache: string }
  | { status: "unavailable"; reason: string }
  | { status: "not-needed" }
  /** The run stopped before any session (written by the eval arms with the refusal). */
  | { status: "refused"; reason: string };

export interface PreparedToolchain {
  report: ToolchainReport;
  toolchain?: SessionToolchain;
  /** The runner-made folder holding the unpacked toolchain; removeGoToolchain removes it after the run. */
  dir?: string;
}

const VERSION = /^go1\.\d{1,3}(?:\.\d{1,3})?(?:(?:rc|beta)\d{1,3})?$/;
const MiB = 1024 * 1024;

/**
 * Bounds for the toolchain zip, unpacked outside any sandbox. go1.26.10 darwin-arm64 is 69.6 MB with 11,523
 * entries and 211.7 MB expanded; these leave room for later versions. It unpacks in about 23 s at load 17, so
 * the deadline at which the unpack process is killed leaves room for a loaded machine.
 */
export const GO_TOOLCHAIN_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: 256 * MiB, maxEntries: 20_000, maxTotalBytes: 512 * MiB,
  maxNameBytes: 1024, maxDepth: 64, maxTotalNameBytes: 8 * MiB,
  timeoutMs: 300_000, maxHeapMb: 512,
};

/** The host facts preparation reads; tests replace them. */
export const toolchainHost = {
  /** Bytes an unprivileged writer may still use on the volume holding `dir`. */
  freeBytes: (dir: string): number => { const s = statfsSync(dir); return s.bavail * s.bsize; },
  /** The SHA-256 a toolchain zip must have, by `<version>.<os>-<arch>` (config/pins.ts). */
  pinnedZipSha256: (key: string): string | undefined => GO_TOOLCHAIN_ZIPS[key],
};

const ZIP_WORKER = fileURLToPath(new URL("./zip-worker.ts", import.meta.url));

/**
 * Unpacks in a child process the runner supervises: the runner's own Node, with a capped heap, no inherited
 * environment (NODE_OPTIONS, UNZIP and the like can't change it), killed at the deadline. Anything but a clean
 * success is a refusal; the caller removes the partial folder.
 */
function unpackSupervised(zip: string, dest: string, within: string, sha256: string, limits: ZipLimits): void {
  const r = spawnSync(process.execPath, [`--max-old-space-size=${limits.maxHeapMb}`, ZIP_WORKER, zip, dest, within, sha256, JSON.stringify(limits)], {
    env: {}, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1024 * 1024,
    timeout: limits.timeoutMs, killSignal: "SIGKILL",
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error(`refused: unpacking the toolchain zip took longer than ${limits.timeoutMs} ms, so it was stopped`);
  if (r.error) throw new Error(`refused: the toolchain unpack could not run: ${r.error.message}`);
  let reply: { ok?: unknown; error?: unknown } = {};
  try { reply = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as typeof reply; } catch { /* no reply: a crash */ }
  if (r.status === 0 && reply.ok === true) return;
  const why = typeof reply.error === "string" ? reply.error : `the toolchain unpack failed (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`}): ${r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500)}`;
  throw new Error(why.startsWith("refused:") ? why : `refused: ${why}`);
}

/** The toolchain a go.mod asks for: its `toolchain` line, else its `go` line; anything malformed is undefined. */
export function goModToolchain(goMod: string): string | undefined {
  const lines = goMod.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim());
  const directive = (name: string) => lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1).trim();
  const toolchain = directive("toolchain");
  const go = directive("go");
  const version = toolchain ?? (go !== undefined ? `go${go}` : undefined);
  return version !== undefined && VERSION.test(version) ? version : undefined;
}

/** Go's name for this machine, as toolchain module versions spell it (darwin-arm64, linux-amd64). */
export function goPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const goArch = arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;
  return `${platform}-${goArch}`;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Every entry below `root` is a plain folder or file: a link could point the session at something else. */
function refuseLinks(root: string, what: string): void {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`refused: the ${what} holds a symlink: ${p}`);
    if (st.isDirectory()) refuseLinks(p, what);
    else if (!st.isFile()) throw new Error(`refused: the ${what} holds something that is neither a file nor a folder: ${p}`);
  }
}

const unavailable = (reason: string): PreparedToolchain => ({ report: { status: "unavailable", reason } });

/**
 * Prepares the Go a run's sessions get. `fixture` is the module cache the gate reads (never its checks);
 * `dest` a fresh, runner-made folder outside every session-writable folder (the caller's to check).
 * Returns "unavailable" only when the fixture, or its zip for the version go.mod asks for, is absent (or go.mod
 * names no version); everything else that is wrong throws "refused: …", which stops the run (fail closed).
 */
export function prepareGoToolchain(i: { workspace: string; fixture: string | undefined; dest: string; platform?: string; /** Test seam. */ limits?: ZipLimits }): PreparedToolchain {
  const limits = i.limits ?? GO_TOOLCHAIN_ZIP_LIMITS;
  const goModPath = join(i.workspace, "go.mod");
  if (!existsSync(goModPath)) return { report: { status: "not-needed" } };
  const goMod = readFileSync(goModPath, "utf8");
  const version = goModToolchain(goMod);
  if (version === undefined) {
    if (/^\s*(?:go|toolchain)\s/m.test(goMod)) throw new Error("refused: go.mod's go or toolchain line names no version this runner can read");
    return unavailable("go.mod names no go version: sessions get the host's go");
  }
  if (i.fixture === undefined) return unavailable("no Go fixture for this task: sessions get the host's go");
  const st = lstatSync(i.fixture, { throwIfNoEntry: false });
  if (st === undefined) return unavailable(`no Go fixture at ${i.fixture}: sessions get the host's go`);
  if (st.isSymbolicLink()) throw new Error(`refused: the Go fixture is a symlink: ${i.fixture}`);
  if (!st.isDirectory()) throw new Error(`refused: the Go fixture is not a folder: ${i.fixture}`);
  const fixture = realpathSync(i.fixture);
  if (fixture !== resolve(i.fixture)) throw new Error(`refused: the Go fixture is reached through a linked folder: ${i.fixture} is ${fixture}`);
  refuseLinks(fixture, "Go fixture");
  const platform = i.platform ?? goPlatform();
  const module = `toolchain@v0.0.1-${version}.${platform}`;
  const zip = join(fixture, "cache", "download", "golang.org", "toolchain", "@v", `v0.0.1-${version}.${platform}.zip`);
  if (lstatSync(zip, { throwIfNoEntry: false }) === undefined) return unavailable(`the Go fixture has no ${version} toolchain for ${platform}: sessions get the host's go`);
  // From here on the toolchain is present, so anything wrong stops the run. First, trust: the pinned hash.
  const pinned = toolchainHost.pinnedZipSha256(`${version}.${platform}`);
  if (pinned === undefined) throw new Error(`refused: Go unavailable: no pinned toolchain for ${version} ${platform} (config/pins.ts GO_TOOLCHAIN_ZIPS)`);

  const dest = resolve(i.dest);
  // The unpacked toolchain sits beside the fixture, never in it: the fixture is the gate's input and stays as it was.
  const realDest = realPathOf(dest);
  if (under(realDest, fixture) || under(fixture, realDest)) throw new Error(`refused: the toolchain folder and the Go fixture overlap: ${dest}`);
  if (existsSync(dest)) throw new Error(`refused: the toolchain folder must be fresh: ${dest}`);
  // Room for the largest unpack the limits allow, above the disk floor (decision 63).
  const free = toolchainHost.freeBytes(nearestExisting(dest));
  if (free - limits.maxTotalBytes < DISK_FLOOR_BYTES) throw new Error(`refused: not enough free disk to unpack the ${version} toolchain: ${free} bytes free, and up to ${limits.maxTotalBytes} bytes must fit above the ${DISK_FLOOR_BYTES}-byte floor`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    unpackSupervised(zip, dest, `golang.org/${module}`, pinned, limits);
    const goBin = join(dest, "golang.org", module, "bin", "go");
    const bin = lstatSync(goBin, { throwIfNoEntry: false });
    if (!bin?.isFile() || (bin.mode & 0o111) === 0) throw new Error(`refused: the ${version} toolchain zip has no bin/go`);
  } catch (e) {
    removeGoToolchain(dest);
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(why.startsWith("refused:") ? why : `refused: ${why}`);
  }
  const dir = realpathSync(dest);
  return {
    report: { status: "ready", version, modCache: fixture },
    dir,
    toolchain: {
      version,
      readOnlyDirs: [dir, fixture],
      pathPrefix: [join(dir, "golang.org", module, "bin")],
      // As the gate's go-env.sh: the pinned toolchain only, the module cache read in place, no proxy, no checksum
      // database, go.mod and go.sum never rewritten, no VCS stamping, and no cgo (its link needs clang's cache in
      // the per-user temp folder, which sessions can't read, decision 95).
      env: { GOTOOLCHAIN: "local", GOMODCACHE: fixture, GOPROXY: "off", GOSUMDB: "off", GOFLAGS: "-buildvcs=false -mod=readonly", CGO_ENABLED: "0" },
    },
  };
}

function nearestExisting(p: string): string {
  let d = p;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

/** The real path `p` will have: its nearest existing folder resolved, the rest appended. */
function realPathOf(p: string): string {
  const d = nearestExisting(p);
  return join(realpathSync(d), p.slice(d.length));
}

/** `chmod u+rwx` on folders only, opened without following links, then removal: Go leaves its trees read-only. */
function makeRemovable(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { chmodSync(path, (fstatSync(fd).mode & 0o7777) | 0o700); } finally { closeSync(fd); }
  for (const name of readdirSync(path)) makeRemovable(join(path, name));
}

/** Removes a run's unpacked toolchain; a missing folder is fine. */
export function removeGoToolchain(dir: string): void {
  makeRemovable(dir);
  rmSync(dir, { recursive: true, force: true });
}
