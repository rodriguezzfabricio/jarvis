import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUST_FIXTURES } from "../config/pins.ts";
import type { SessionToolchain } from "./go.ts";

/**
 * A pinned, offline Rust for task sessions (decision 163, the Rust counterpart of decision 123's Go). Sessions and
 * gates run sandboxed with no network, and no Rust is on a session's PATH, so a task that builds a Rust or Tauri
 * app gets the gate's own fixture: Rust, the Tauri CLI and a vendored crate set, read in place and read-only.
 *
 * The fixture is a tree (jarvis-evals' scripts/rust-fixture.sh), not an archive: nothing is unpacked, so there is
 * no unpack to bound. Trust comes from the pin instead: config/pins.ts names the SHA-256 of the fixture's file
 * listing (every file's path and SHA-256, as `shasum -a 256` prints them, sorted by path), so any added, removed,
 * renamed or changed file refuses the run. Cargo reads its config from the fixture's cargo-home, which sends every
 * crate to the vendored folder and turns the network off; Cargo works with a CARGO_HOME it can't write.
 *
 * Linking goes straight to the Command Line Tools' clang, with the SDK named: /usr/bin/cc and rustc's own SDK
 * lookup go through xcrun, whose cache is in the per-user temp folder that sessions and gates can't write, and
 * then fall back to calls that cost seconds each. The Command Line Tools are root-owned system files, so sessions
 * get them as system folders: on PATH and named by variables, never writable.
 *
 * It fails closed: only an absent fixture means "not needed". Anything wrong with a fixture that is present stops
 * the run before any session, with "refused:" and the reason.
 */

export type RustToolchainReport =
  | { status: "ready"; rust: string; target: string; tauriCli: string; fixture: string }
  | { status: "not-needed" }
  /** The run stopped before any session (written by the eval arms with the refusal). */
  | { status: "refused"; reason: string };

export interface PreparedRustToolchain {
  report: RustToolchainReport;
  toolchain?: SessionToolchain;
}

/** The Command Line Tools folder the toolchain links through; the only system folder a toolchain may name. */
export const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";

/** Rust's name for this machine, for the platforms Jarvis runs on. */
export function rustTarget(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform !== "darwin") return undefined;
  return arch === "arm64" ? "aarch64-apple-darwin" : arch === "x64" ? "x86_64-apple-darwin" : undefined;
}

/** The host facts preparation reads; tests replace them. */
export const rustHost = {
  /** The SHA-256 a fixture's file listing must have, by `<rust>.<target>` (config/pins.ts). */
  pinnedFixtureSha256: (key: string): string | undefined => RUST_FIXTURES[key],
  commandLineTools: (): string => COMMAND_LINE_TOOLS,
  /** Owned by root and writable by nobody else, as the installed Command Line Tools are. */
  systemOwned: (path: string): boolean => { const st = lstatSync(path); return st.uid === 0 && (st.mode & 0o022) === 0; },
  target: (): string | undefined => rustTarget(),
};

const RUST = /^1\.\d{1,3}\.\d{1,3}$/;
const TARGET = /^[a-z0-9_]{1,32}-[a-z0-9_]{1,32}-[a-z0-9_]{1,32}$/;
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Every file below `root`, by path relative to it; a link or a special file refuses the fixture. */
function files(root: string, rel = "."): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const p = `${rel}/${name}`;
    const st = lstatSync(join(root, p));
    if (st.isSymbolicLink()) throw new Error(`refused: the Rust fixture holds a symlink: ${join(root, p)}`);
    if (st.isDirectory()) out.push(...files(root, p));
    else if (st.isFile()) out.push(p);
    else throw new Error(`refused: the Rust fixture holds something that is neither a file nor a folder: ${join(root, p)}`);
  }
  return out;
}

/**
 * The SHA-256 of the fixture's file listing, byte for byte what
 * `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256` prints in it (jarvis-evals keeps that
 * listing as hidden/rust-fixture.sha256). Refuses links and special files.
 */
export function rustFixtureDigest(root: string): string {
  const paths = files(root).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const listing = createHash("sha256");
  for (const p of paths) listing.update(`${createHash("sha256").update(readFileSync(join(root, p))).digest("hex")}  ${p}\n`);
  return listing.digest("hex");
}

interface FixtureInfo { rust: string; target: string; tauriCli: string }

function fixtureInfo(fixture: string): FixtureInfo {
  const path = join(fixture, "fixture.json");
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`refused: the Rust fixture has no fixture.json: ${path}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`refused: the Rust fixture's fixture.json is not JSON: ${path}`); }
  const i = raw as Partial<FixtureInfo> | null;
  if (typeof i?.rust !== "string" || !RUST.test(i.rust) || typeof i.target !== "string" || !TARGET.test(i.target) || typeof i.tauriCli !== "string" || !SEMVER.test(i.tauriCli)) {
    throw new Error(`refused: the Rust fixture's fixture.json must name rust, target and tauriCli versions: ${path}`);
  }
  return { rust: i.rust, target: i.target, tauriCli: i.tauriCli };
}

/** The Command Line Tools and their SDK's real path, or a refusal: they must be the system's own. */
function commandLineTools(fixture: string): { clt: string; sdk: string } {
  const want = rustHost.commandLineTools();
  const clang = join(want, "usr", "bin", "clang");
  if (!existsSync(want) || !lstatSync(clang, { throwIfNoEntry: false })?.isFile()) throw new Error(`refused: Rust needs the Xcode Command Line Tools to link, and ${clang} is missing (xcode-select --install)`);
  const clt = realpathSync(want);
  if (clt !== resolve(want)) throw new Error(`refused: the Command Line Tools folder is reached through a link: ${want} is ${clt}`);
  if (!rustHost.systemOwned(clt)) throw new Error(`refused: the Command Line Tools folder must be owned by root and writable by nobody else: ${clt}`);
  if (under(fixture, clt) || under(clt, fixture)) throw new Error(`refused: the Rust fixture and the Command Line Tools folder overlap: ${fixture}`);
  let sdk: string;
  try { sdk = realpathSync(join(clt, "SDKs", "MacOSX.sdk")); } catch { throw new Error(`refused: the Command Line Tools have no macOS SDK (${join(clt, "SDKs", "MacOSX.sdk")})`); }
  if (!under(sdk, clt) || !lstatSync(sdk).isDirectory()) throw new Error(`refused: the Command Line Tools' macOS SDK leads outside them: ${sdk}`);
  return { clt, sdk };
}

/**
 * Prepares the Rust a run's sessions get. `fixture` is the folder the gate reads (never its checks). Returns
 * "not-needed" only when it is absent; everything else that is wrong throws "refused: …", which stops the run.
 */
export function prepareRustToolchain(i: { fixture: string | undefined }): PreparedRustToolchain {
  if (i.fixture === undefined) return { report: { status: "not-needed" } };
  const st = lstatSync(i.fixture, { throwIfNoEntry: false });
  if (st === undefined) return { report: { status: "not-needed" } };
  if (st.isSymbolicLink()) throw new Error(`refused: the Rust fixture is a symlink: ${i.fixture}`);
  if (!st.isDirectory()) throw new Error(`refused: the Rust fixture is not a folder: ${i.fixture}`);
  const fixture = realpathSync(i.fixture);
  if (fixture !== resolve(i.fixture)) throw new Error(`refused: the Rust fixture is reached through a linked folder: ${i.fixture} is ${fixture}`);
  const info = fixtureInfo(fixture);
  const target = rustHost.target();
  if (info.target !== target) throw new Error(`refused: the Rust fixture is for ${info.target}, and this machine is ${target ?? "not a platform Jarvis builds Rust on"}`);
  // Trust first: the whole tree must be the pinned one, before anything in it is used.
  const pinned = rustHost.pinnedFixtureSha256(`${info.rust}.${info.target}`);
  if (pinned === undefined) throw new Error(`refused: no pinned Rust fixture for ${info.rust} ${info.target} (config/pins.ts RUST_FIXTURES)`);
  const digest = rustFixtureDigest(fixture);
  if (digest !== pinned) throw new Error(`refused: the Rust fixture is not the pinned one: its file listing hashes to ${digest}, the pin is ${pinned}`);
  const bin = join(fixture, "toolchain", "bin");
  for (const tool of ["cargo", "rustc", "cargo-tauri"]) {
    const t = lstatSync(join(bin, tool), { throwIfNoEntry: false });
    if (!t?.isFile()) throw new Error(`refused: the Rust fixture lacks toolchain/bin/${tool}`);
    if ((t.mode & 0o111) === 0) throw new Error(`refused: the Rust fixture's toolchain/bin/${tool} is not executable`);
  }
  if (!lstatSync(join(fixture, "cargo-home", "config.toml"), { throwIfNoEntry: false })?.isFile()) throw new Error("refused: the Rust fixture lacks cargo-home/config.toml");
  if (!lstatSync(join(fixture, "vendor"), { throwIfNoEntry: false })?.isDirectory()) throw new Error("refused: the Rust fixture lacks its vendored crates (vendor/)");
  const { clt, sdk } = commandLineTools(fixture);
  return {
    report: { status: "ready", rust: info.rust, target: info.target, tauriCli: info.tauriCli, fixture },
    toolchain: {
      version: `rust ${info.rust}`,
      readOnlyDirs: [fixture],
      systemDirs: [clt],
      pathPrefix: [bin, join(clt, "usr", "bin")],
      // As the gate's rust-env.sh: Cargo's config and crates from the fixture, no network, and the SDK named.
      env: { CARGO_HOME: join(fixture, "cargo-home"), CARGO_NET_OFFLINE: "true", SDKROOT: sdk, DEVELOPER_DIR: clt },
    },
  };
}

/** One session toolchain from two (Go and Rust): folders, PATH entries and variables together, in that order. */
export function mergeSessionToolchains(a: SessionToolchain | undefined, b: SessionToolchain | undefined): SessionToolchain | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  for (const k of Object.keys(b.env)) if (Object.hasOwn(a.env, k)) throw new Error(`refused: two toolchains both set ${k}`);
  const systemDirs = [...(a.systemDirs ?? []), ...(b.systemDirs ?? [])];
  return {
    version: `${a.version}, ${b.version}`,
    readOnlyDirs: [...a.readOnlyDirs, ...b.readOnlyDirs],
    ...(systemDirs.length ? { systemDirs } : {}),
    pathPrefix: [...a.pathPrefix, ...b.pathPrefix],
    env: { ...a.env, ...b.env },
  };
}
