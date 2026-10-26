import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
 * cache/download holds the toolchain module's zip. No fixture means today's behaviour, reported as such.
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
  | { status: "not-needed" };

export interface PreparedToolchain {
  report: ToolchainReport;
  toolchain?: SessionToolchain;
  /** The runner-made folder holding the unpacked toolchain; removeGoToolchain removes it after the run. */
  dir?: string;
}

const VERSION = /^go1\.\d{1,3}(?:\.\d{1,3})?(?:(?:rc|beta)\d{1,3})?$/;

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
 * Throws on a fixture that is, or holds, a link: that is tampering or a mistake, never a missing fixture.
 */
export function prepareGoToolchain(i: { workspace: string; fixture: string | undefined; dest: string; platform?: string }): PreparedToolchain {
  const goModPath = join(i.workspace, "go.mod");
  if (!existsSync(goModPath)) return { report: { status: "not-needed" } };
  const version = goModToolchain(readFileSync(goModPath, "utf8"));
  if (version === undefined) return unavailable("go.mod names no go version this runner can pin");
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
  if (!lstatSync(zip, { throwIfNoEntry: false })?.isFile()) return unavailable(`the Go fixture has no ${version} toolchain for ${platform}: sessions get the host's go`);

  const dest = resolve(i.dest);
  // The unpacked toolchain sits beside the fixture, never in it: the fixture is the gate's input and stays as it was.
  const realDest = realPathOf(dest);
  if (under(realDest, fixture) || under(fixture, realDest)) throw new Error(`refused: the toolchain folder and the Go fixture overlap: ${dest}`);
  if (existsSync(dest)) throw new Error(`refused: the toolchain folder must be fresh: ${dest}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    execFileSync("/usr/bin/unzip", ["-q", zip, "-d", dest], { stdio: ["ignore", "ignore", "pipe"] });
    refuseLinks(dest, "unpacked Go toolchain");
    const goBin = join(dest, "golang.org", module, "bin", "go");
    const bin = lstatSync(goBin, { throwIfNoEntry: false });
    if (!bin?.isFile() || (bin.mode & 0o111) === 0) throw new Error(`the ${version} toolchain module has no bin/go`);
  } catch (e) {
    removeGoToolchain(dest);
    if (e instanceof Error && e.message.startsWith("refused:")) throw e;
    return unavailable(`could not unpack the ${version} toolchain from the Go fixture (${e instanceof Error ? e.message : String(e)}): sessions get the host's go`);
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

/** The real path `p` will have: its nearest existing folder resolved, the rest appended. */
function realPathOf(p: string): string {
  let d = p;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
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
