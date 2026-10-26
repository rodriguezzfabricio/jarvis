import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISK_FLOOR_BYTES, GO_TOOLCHAIN_ZIPS } from "../../packages/cli/src/config/pins.ts";
import { GO_TOOLCHAIN_ZIP_LIMITS, goPlatform, prepareGoToolchain, toolchainHost } from "../../packages/cli/src/toolchain/go.ts";
import { shortTmp } from "../helpers.ts";
import { FIXTURE_GO, pinToolchainZip, sha256, toolchainModule } from "./helpers/go-fixture.ts";
import { makeZip, type ZipItem } from "./helpers/zip-writer.ts";

/**
 * The runner unpacks the toolchain zip outside any sandbox (decision 123), so the zip is treated as hostile.
 * It must be the pinned one (by SHA-256) before a byte is parsed. Every entry is checked before anything is
 * written. The unpack runs in a child process with a capped heap and no inherited environment, killed at its
 * deadline. Anything but an absent fixture or zip stops the run. Codex security reviews of dd0923f..a299593
 * (highs 1 and 2) and of e13ca2a (finding 2, high 3, and the fail-closed note).
 */
const roots: string[] = [];
function removeAll(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) { chmodSync(path, 0o700); for (const n of readdirSync(path)) removeAll(join(path, n)); }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { roots.splice(0).forEach(removeAll); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
// The disk floor has its own test below; elsewhere the host's free disk must not decide the outcome.
beforeEach(() => { vi.spyOn(toolchainHost, "freeBytes").mockReturnValue(1e15); });

const M = toolchainModule();
const GO = { name: `${M}/bin/go`, data: `#!/bin/sh\necho "go version ${FIXTURE_GO} fake"\n`, mode: 0o100755, dataDescriptor: true };

/** A workspace asking for go1.26.10 and a fixture whose toolchain zip holds `items`, pinned unless `pin` is false. */
function setup(items: readonly ZipItem[] | Buffer, o: { pin?: boolean } = {}) {
  const root = realpathSync(shortTmp("jtz-"));
  roots.push(root);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "go.mod"), "module example.com/app\n\ngo 1.26.10\n");
  const fixture = join(root, "evals", "gate", "fixtures", "gomodcache");
  const zip = join(fixture, "cache", "download", "golang.org", "toolchain", "@v", `v0.0.1-${FIXTURE_GO}.${goPlatform()}.zip`);
  mkdirSync(dirname(zip), { recursive: true });
  const bytes = Buffer.isBuffer(items) ? items : makeZip(items);
  writeFileSync(zip, bytes);
  if (o.pin !== false) pinToolchainZip(bytes);
  const dest = join(root, "work", "toolchains", "05", "run-1");
  return { root, workspace, fixture, zip, dest };
}
const prepare = (s: ReturnType<typeof setup>, limits?: Partial<typeof GO_TOOLCHAIN_ZIP_LIMITS>) =>
  prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: s.dest, ...(limits ? { limits: { ...GO_TOOLCHAIN_ZIP_LIMITS, ...limits } } : {}) });

describe("trusting and unpacking the toolchain zip (decision 123)", () => {
  it("pins the real toolchain by SHA-256, and bounds its unpack with room to spare", () => {
    // jarvis-evals hidden/go-fixture.sha256 lists the same hash for this zip.
    expect(GO_TOOLCHAIN_ZIPS).toEqual({ "go1.26.10.darwin-arm64": "afb16ae24c172f008db87119f34cf903a295bbad3fa526f7443914b0240b33c7" });
    // go1.26.10 darwin-arm64: 69.6 MB, 11,523 entries, 211.7 MB expanded, longest name well under 1 KiB, about 23 s to unpack at load 17.
    expect(GO_TOOLCHAIN_ZIP_LIMITS).toEqual({ maxZipBytes: 256 * 1024 * 1024, maxEntries: 20_000, maxTotalBytes: 512 * 1024 * 1024, maxNameBytes: 1024, maxDepth: 64, maxTotalNameBytes: 8 * 1024 * 1024, timeoutMs: 300_000, maxHeapMb: 512 });
  });

  it("unpacks Go's own layout: data descriptors, Unix modes, no folder entries", () => {
    const s = setup([GO, { name: `${M}/VERSION`, data: `${FIXTURE_GO}\n`, dataDescriptor: true }, { name: `${M}/src/empty.go`, data: "", method: 0 }]);
    const p = prepare(s);
    expect(p.report).toMatchObject({ status: "ready", version: FIXTURE_GO });
    expect(readFileSync(join(p.dir!, M, "VERSION"), "utf8")).toBe(`${FIXTURE_GO}\n`);
    expect(statSync(join(p.dir!, M, "bin", "go")).mode & 0o111).not.toBe(0);
    expect(statSync(join(p.dir!, M, "VERSION")).mode & 0o111).toBe(0);
  });

  it("refuses a zip that isn't the pinned one before parsing it, and stops the run", () => {
    const s = setup([GO, { name: `${M}/VERSION`, data: "go1.26.10\n" }], { pin: false });
    pinToolchainZip(Buffer.from("some other zip"));
    expect(() => prepare(s)).toThrow(/refused: the toolchain zip is not the pinned one/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("stops the run when the fixture holds a toolchain this runner has no pin for", () => {
    const s = setup([GO], { pin: false });
    vi.spyOn(toolchainHost, "pinnedZipSha256").mockReturnValue(undefined);
    expect(() => prepare(s)).toThrow(/refused: Go unavailable: no pinned toolchain for go1\.26\.10/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("gives the unpack no inherited environment (UNZIP, UNZIPOPT, NODE_OPTIONS), and never writes outside its folder", () => {
    const marker = join(realpathSync(shortTmp("jtn-")), "node-options-ran");
    roots.push(dirname(marker));
    const hook = join(dirname(marker), "hook.cjs");
    writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    vi.stubEnv("UNZIP", "-: -o");
    vi.stubEnv("UNZIPOPT", "-: -o");
    vi.stubEnv("NODE_OPTIONS", `--require ${hook}`);
    expect(prepare(setup([GO])).report).toMatchObject({ status: "ready" });
    expect(existsSync(marker)).toBe(false);
    const s = setup([GO, { name: `${M}/../../../../escape.txt`, data: "planted" }]);
    expect(() => prepare(s)).toThrow(/refused/);
    expect(existsSync(resolve(s.dest, M, "../../../../escape.txt"))).toBe(false);
  });

  it("refuses an entry that climbs out of the folder, before writing anything", () => {
    const s = setup([GO, { name: `${M}/../../../../escape.txt`, data: "planted" }]);
    expect(() => prepare(s)).toThrow(/refused: the toolchain zip has an unsafe path/);
    expect(existsSync(resolve(s.dest, M, "../../../../escape.txt"))).toBe(false);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses absolute paths and entries outside the toolchain module", () => {
    expect(() => prepare(setup([GO, { name: "/tmp/jarvis-planted.txt", data: "planted" }]))).toThrow(/refused/);
    expect(existsSync("/tmp/jarvis-planted.txt")).toBe(false);
    const s = setup([GO, { name: "golang.org/other@v1.0.0/x.go", data: "package x\n" }]);
    expect(() => prepare(s)).toThrow(/refused: the toolchain zip has an entry outside/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("bounds each name's length and depth, and all names together, before building any prefix", () => {
    const long = setup([GO, { name: `${M}/${"a".repeat(1100)}`, data: "x" }]);
    expect(() => prepare(long)).toThrow(/refused: the toolchain zip has a name longer than 1024 bytes/);
    const deep = setup([GO, { name: `${M}/${"d/".repeat(70)}x`, data: "x" }]);
    expect(() => prepare(deep)).toThrow(/refused: the toolchain zip has a path deeper than 64 folders/);
    const many = setup([GO, { name: `${M}/a`, data: "a" }, { name: `${M}/b`, data: "b" }]);
    expect(() => prepare(many, { maxTotalNameBytes: 120 })).toThrow(/refused: the toolchain zip has names that add up to more than 120 bytes/);
    for (const s of [long, deep, many]) expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses names that are the same on this Mac's disk: by case or by Unicode normalization", () => {
    const nfd = setup([GO, { name: `${M}/café`, data: "x" }, { name: `${M}/café`, data: "y" }]);
    expect(() => prepare(nfd)).toThrow(/refused: the toolchain zip has the same path twice/);
    const kase = setup([GO, { name: `${M}/VERSION`, data: "x" }, { name: `${M}/version`, data: "y" }]);
    expect(() => prepare(kase)).toThrow(/refused: the toolchain zip has the same path twice/);
    const nested = setup([GO, { name: `${M}/pkg`, data: "x" }, { name: `${M}/pkg-a`, data: "x" }, { name: `${M}/pkg/x.a`, data: "y" }]);
    expect(() => prepare(nested)).toThrow(/refused: the toolchain zip has a file where a folder goes/);
  });

  it("refuses a symlink entry", () => {
    const s = setup([GO, { name: `${M}/bin/gofmt`, data: "/etc/hosts", mode: 0o120777 }]);
    expect(() => prepare(s)).toThrow(/refused: the toolchain zip has a link or special file/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses a zip that declares more than the expansion limit, before extracting", () => {
    const s = setup([GO, { name: `${M}/pkg/huge.a`, data: "small", declaredSize: 600 * 1024 * 1024 }]);
    expect(() => prepare(s)).toThrow(/refused: the toolchain zip declares .* more than its .* limit/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses an entry that expands past its declared size, and removes what it wrote", () => {
    const s = setup([GO, { name: `${M}/pkg/bomb.a`, data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 1024 }]);
    expect(() => prepare(s)).toThrow(/refused: .*pkg\/bomb\.a expands past its declared size/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses an entry whose data doesn't match its checksum", () => {
    const s = setup([GO, { name: `${M}/VERSION`, data: `${FIXTURE_GO}\n`, crc: 1 }]);
    expect(() => prepare(s)).toThrow(/refused: .*VERSION fails its checksum/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses a zip with too many entries, before extracting", () => {
    const s = setup([GO, { name: `${M}/a`, method: 0 }, { name: `${M}/b`, method: 0 }, { name: `${M}/c`, method: 0 }]);
    expect(() => prepare(s, { maxEntries: 3 })).toThrow(/refused: the toolchain zip has 4 entries, more than its 3 limit/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses an archive larger than its limit without reading it", () => {
    const s = setup([GO]);
    expect(() => prepare(s, { maxZipBytes: 64 })).toThrow(/refused: the toolchain zip is larger than 64 bytes/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses archives whose structure it can't trust", () => {
    const cases: [ZipItem[] | Buffer, RegExp][] = [
      [Buffer.from("not a zip at all, just bytes"), /no end-of-archive record/],
      [[GO, { name: `${M}/VERSION`, data: "x", flags: 0x1 }], /encrypted entry/],
      [[GO, { name: `${M}/VERSION`, data: "x", method: 12 }], /compression method 12/],
      [[GO, { name: `${M}/pkg/`, data: "", mode: 0o100644 }], /link or special file/],
      [[{ name: `${M}/VERSION`, data: "no go here" }], /has no bin\/go/],
    ];
    for (const [items, why] of cases) {
      const s = setup(items);
      expect(() => prepare(s)).toThrow(why);
      expect(existsSync(s.dest)).toBe(false);
    }
  });

  it("kills an unpack that runs past its deadline, and removes the partial folder", () => {
    const s = setup([GO, { name: `${M}/a`, data: "a" }]);
    expect(() => prepare(s, { timeoutMs: 1 })).toThrow(/refused: unpacking the toolchain zip took longer than 1 ms, so it was stopped/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("stops the run when unpacking would go below the disk floor, and writes nothing", () => {
    const s = setup([GO, { name: `${M}/pkg/x.a`, data: Buffer.alloc(64 * 1024) }]);
    vi.spyOn(toolchainHost, "freeBytes").mockReturnValue(DISK_FLOOR_BYTES + GO_TOOLCHAIN_ZIP_LIMITS.maxTotalBytes - 1);
    expect(() => prepare(s)).toThrow(/refused: not enough free disk/);
    expect(existsSync(s.dest)).toBe(false);
    expect(sha256(readFileSync(s.zip)).length).toBe(64);
  });
});
