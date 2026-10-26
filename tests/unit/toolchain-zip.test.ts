import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISK_FLOOR_BYTES } from "../../packages/cli/src/config/pins.ts";
import { GO_TOOLCHAIN_ZIP_LIMITS, goPlatform, prepareGoToolchain, toolchainHost } from "../../packages/cli/src/toolchain/go.ts";
import { shortTmp } from "../helpers.ts";
import { FIXTURE_GO, toolchainModule } from "./helpers/go-fixture.ts";
import { makeZip, type ZipItem } from "./helpers/zip-writer.ts";

/**
 * The toolchain zip is unpacked by the runner, outside any sandbox (decision 123), so it is treated as hostile:
 * every entry is listed and checked before anything is written, expansion is bounded, and a slow unpack stops.
 * Codex security review of dd0923f..a299593, highs 1 and 2.
 */
const roots: string[] = [];
function removeAll(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) { chmodSync(path, 0o700); for (const n of readdirSync(path)) removeAll(join(path, n)); }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { roots.splice(0).forEach(removeAll); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
// The disk floor has its own test (toolchain-zip.test.ts); here the host's free disk must not decide the outcome.
beforeEach(() => { vi.spyOn(toolchainHost, "freeBytes").mockReturnValue(1e15); });

const M = toolchainModule();
const GO = { name: `${M}/bin/go`, data: `#!/bin/sh\necho "go version ${FIXTURE_GO} fake"\n`, mode: 0o100755, dataDescriptor: true };

/** A workspace asking for go1.26.10 and a fixture whose toolchain zip holds `items`. */
function setup(items: readonly ZipItem[] | Buffer) {
  const root = realpathSync(shortTmp("jtz-"));
  roots.push(root);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "go.mod"), "module example.com/app\n\ngo 1.26.10\n");
  const fixture = join(root, "evals", "gate", "fixtures", "gomodcache");
  const zip = join(fixture, "cache", "download", "golang.org", "toolchain", "@v", `v0.0.1-${FIXTURE_GO}.${goPlatform()}.zip`);
  mkdirSync(dirname(zip), { recursive: true });
  writeFileSync(zip, Buffer.isBuffer(items) ? items : makeZip(items));
  const dest = join(root, "work", "toolchains", "05", "run-1");
  return { root, workspace, fixture, zip, dest };
}
const prepare = (s: ReturnType<typeof setup>, limits?: Partial<typeof GO_TOOLCHAIN_ZIP_LIMITS>) =>
  prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: s.dest, ...(limits ? { limits: { ...GO_TOOLCHAIN_ZIP_LIMITS, ...limits } } : {}) });

describe("unpacking the toolchain zip safely (decision 123)", () => {
  it("unpacks Go's own layout: data descriptors, Unix modes, no folder entries", () => {
    const s = setup([GO, { name: `${M}/VERSION`, data: `${FIXTURE_GO}\n`, dataDescriptor: true }, { name: `${M}/src/empty.go`, data: "", method: 0 }]);
    const p = prepare(s);
    expect(p.report).toMatchObject({ status: "ready", version: FIXTURE_GO });
    expect(readFileSync(join(p.dir!, M, "VERSION"), "utf8")).toBe(`${FIXTURE_GO}\n`);
    expect(statSync(join(p.dir!, M, "bin", "go")).mode & 0o111).not.toBe(0);
    expect(statSync(join(p.dir!, M, "VERSION")).mode & 0o111).toBe(0);
  });

  it("ignores UNZIP and UNZIPOPT in the runner's environment, and never writes outside its folder", () => {
    vi.stubEnv("UNZIP", "-: -o");
    vi.stubEnv("UNZIPOPT", "-: -o");
    const good = setup([GO]);
    expect(prepare(good).report).toMatchObject({ status: "ready" });
    const s = setup([GO, { name: `${M}/../../../../escape.txt`, data: "planted" }]);
    expect(() => prepare(s)).toThrow(/refused/);
    expect(existsSync(resolve(s.dest, M, "../../../../escape.txt"))).toBe(false);
    vi.unstubAllEnvs();
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

  it("bounds the real toolchain's archive with room to spare", () => {
    // go1.26.10 darwin-arm64: 69.6 MB, 11,523 entries, 211.7 MB expanded, about 23 s to unpack at load 17.
    expect(GO_TOOLCHAIN_ZIP_LIMITS).toEqual({ maxZipBytes: 256 * 1024 * 1024, maxEntries: 20_000, maxTotalBytes: 512 * 1024 * 1024, timeoutMs: 300_000 });
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
      [[GO, { name: `${M}/VERSION`, data: "x" }, { name: `${M}/version`, data: "y" }], /same path twice/],
      [[GO, { name: `${M}/pkg`, data: "x" }, { name: `${M}/pkg/x.a`, data: "y" }], /file where a folder goes/],
      [[GO, { name: `${M}/pkg/`, data: "", mode: 0o100644 }], /link or special file/],
    ];
    for (const [items, why] of cases) {
      const s = setup(items);
      expect(() => prepare(s)).toThrow(why);
      expect(existsSync(s.dest)).toBe(false);
    }
  });

  it("stops an unpack that runs past its time limit, and removes the partial folder", () => {
    const s = setup([GO, { name: `${M}/a`, data: "a" }, { name: `${M}/b`, data: "b" }, { name: `${M}/c`, data: "c" }]);
    let calls = 0;
    vi.spyOn(toolchainHost, "now").mockImplementation(() => (calls++ < 3 ? 0 : 10 * 60_000));
    expect(() => prepare(s)).toThrow(/refused: unpacking the toolchain zip took longer than/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("reports go unavailable when unpacking would go below the disk floor, and writes nothing", () => {
    const s = setup([GO, { name: `${M}/pkg/x.a`, data: Buffer.alloc(64 * 1024) }]);
    vi.spyOn(toolchainHost, "freeBytes").mockReturnValue(DISK_FLOOR_BYTES + 1024);
    const p = prepare(s);
    expect(p.report).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/free disk/) });
    expect(existsSync(s.dest)).toBe(false);
  });
});
