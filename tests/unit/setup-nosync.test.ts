import { spawnSync } from "node:child_process";
import fsDefault, { closeSync, fdatasyncSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import * as fsNamespace from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs helper without types
import { CASE_NAMES, runBattery } from "./helpers/nosync-battery.mjs";
import { NATIVE, installNoSync, withoutDeviceFlush } from "../setup/nosync-fsync.ts";

// Decision 154 (narrowing decision 137 for one call): in the gate's test workers fsyncSync and fdatasyncSync keep
// native's checks and results but skip the device flush (F_FULLFSYNC on macOS). The reference is real native
// behavior, taken from a child process that never loaded the setup file.

type Name = "fsyncSync" | "fdatasyncSync";
interface Outcome { returned?: string; threw?: { ctor: string; code?: string; errno?: number; syscall?: string; message: string } }
interface Battery { source: Record<Name, string>; kinds: Record<string, string>; outcomes: Record<Name, Record<string, Outcome>> }

const names: Name[] = ["fsyncSync", "fdatasyncSync"];
const setupFile = fileURLToPath(new URL("../setup/nosync.ts", import.meta.url));
const batteryFile = fileURLToPath(new URL("./helpers/nosync-battery.mjs", import.meta.url));
const requireFs = createRequire(import.meta.url)("node:fs") as Record<Name, ((fd: number) => void) & { [NATIVE]?: (fd: number) => void }>;

let scratch: string;
let native: Battery;
let withSetup: Battery;
let inWorker: Battery;

/** The battery in a plain Node process; `true |` and `| cat` make its stdin and stdout anonymous pipes (what the "pipe" case needs). */
function runChild(label: string, imports: string[]): Battery {
  const dir = join(scratch, label);
  mkdirSync(dir);
  const resultFile = join(scratch, `${label}.json`);
  const r = spawnSync("/bin/sh", ["-c", 'true | "$0" "$@" 2>&1 | cat', process.execPath, ...imports.flatMap((file) => ["--import", file]), batteryFile, dir, resultFile], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 60_000,
  });
  let text: string;
  try {
    text = readFileSync(resultFile, "utf8");
  } catch {
    throw new Error(`the ${label} battery wrote no result: ${r.stdout}${r.stderr}`);
  }
  return JSON.parse(text) as Battery;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "nosync-"));
  native = runChild("native", []);
  withSetup = runChild("with-setup", [setupFile]);
  const dir = join(scratch, "worker");
  mkdirSync(dir);
  // The ES module imports, as product code gets them: the live bindings of node:fs in this worker.
  inWorker = (await runBattery({ fsyncSync, fdatasyncSync }, dir, { inheritedPipe: false })) as Battery;
}, 120_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the native reference", () => {
  // Without these the comparisons below could pass with every call returning undefined on both sides.
  it("is the behavior decision 154 describes, on the real descriptors", () => {
    expect(native.kinds).toMatchObject({ file: "file", folder: "directory", "named pipe": "fifo", pipe: "fifo", socket: "socket", "/dev/null": "character device" });
    for (const name of names) {
      const syscall = name === "fsyncSync" ? "fsync" : "fdatasync";
      const o = native.outcomes[name];
      expect(o.file).toEqual({ returned: "undefined" });
      expect(o["file opened read-only"]).toEqual({ returned: "undefined" });
      expect(o.folder).toEqual({ returned: "undefined" });
      expect(o.pipe?.threw).toMatchObject({ code: "EINVAL", syscall });
      expect(o.socket?.threw).toMatchObject({ code: "EINVAL", syscall });
      expect(o["closed descriptor"]?.threw).toMatchObject({ code: "EBADF", syscall });
      expect(o.string?.threw).toMatchObject({ ctor: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
      expect(o["-1"]?.threw).toMatchObject({ ctor: "RangeError", code: "ERR_OUT_OF_RANGE" });
    }
    expect(Object.keys(native.outcomes.fsyncSync).sort()).toEqual([...CASE_NAMES].sort());
  });
});

describe.each(names)("%s in this worker", (name) => {
  // The worker has no anonymous pipe of its own to give the battery: its pipe case is the child's, below.
  const cases = (CASE_NAMES as string[]).filter((c) => c !== "pipe");

  it.each(cases)("does what native does for: %s", (kind) => {
    expect(inWorker.outcomes[name][kind]).toEqual(native.outcomes[name][kind]);
    expect(inWorker.kinds[kind]).toEqual(native.kinds[kind]);
  });
});

describe.each(names)("%s in a Node process that loads the setup file", (name) => {
  it.each(CASE_NAMES as string[])("does what native does for: %s", (kind) => {
    expect(withSetup.outcomes[name][kind]).toEqual(native.outcomes[name][kind]);
    expect(withSetup.kinds[kind]).toEqual(native.kinds[kind]);
  });

  it("is a replacement there, seen through the ES module imports", () => {
    expect(withSetup.source[name]).not.toBe(native.source[name]);
  });
});

describe("installation in every worker", () => {
  it.each(names)("replaces %s on the fs module of this worker, keeping the native function behind it", (name) => {
    const replacement = requireFs[name];
    const original = replacement[NATIVE];
    expect(original).toBeTypeOf("function");
    expect(replacement).not.toBe(original);
    // The kept function is the real one: the same source as in a process that never loaded the setup file.
    expect(String(original)).toBe(native.source[name]);
    expect(String(replacement)).not.toBe(native.source[name]);
    expect(replacement.name).toBe(name);
  });

  it("gives the same replacements to every way a module gets node:fs", async () => {
    const dynamic = await import("node:fs");
    const unprefixed = await import("fs");
    const required = createRequire(import.meta.url)("fs") as typeof import("node:fs");
    for (const [name, direct] of [["fsyncSync", fsyncSync], ["fdatasyncSync", fdatasyncSync]] as const) {
      const replacement = requireFs[name];
      expect(direct, `named import of ${name}`).toBe(replacement);
      expect(fsNamespace[name], `namespace import of ${name}`).toBe(replacement);
      expect(fsDefault[name], `default import of ${name}`).toBe(replacement);
      expect(dynamic[name], `import("node:fs") of ${name}`).toBe(replacement);
      expect(unprefixed[name], `import("fs") of ${name}`).toBe(replacement);
      expect(required[name], `require("fs") of ${name}`).toBe(replacement);
    }
  });

  it("is registered in vitest.config.ts, beside the existing setup file", async () => {
    const config = (await import("../../vitest.config.ts")).default as { test: { setupFiles: string[] } };
    expect(config.test.setupFiles).toEqual(["./tests/setup/real-git.ts", "./tests/setup/nosync.ts"]);
  });
});

describe("skipping only the device flush", () => {
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;

  // Relative, so no threshold depends on the disk: a device flush costs milliseconds, the replacement microseconds.
  it.each(["file", "folder"])("does not pay for a flush on a %s", (kind) => {
    const dir = mkdtempSync(join(scratch, "timing-"));
    const fd = openSync(kind === "file" ? join(dir, "f") : dir, kind === "file" ? "w" : "r");
    try {
      const time = (call: (fd: number) => void) => median(Array.from({ length: 15 }, () => {
        if (kind === "file") writeSync(fd, "x".repeat(4096));
        const started = performance.now();
        call(fd);
        return performance.now() - started;
      }));
      const flushing = time(requireFs.fsyncSync[NATIVE]!);
      const skipping = time(fsyncSync);
      expect(skipping).toBeLessThan(flushing / 3);
    } finally {
      closeSync(fd);
    }
  });
});

describe("withoutDeviceFlush", () => {
  let dir: string;
  let fileFd: number;
  let folderFd: number;
  let deviceFd: number;
  beforeAll(() => {
    dir = mkdtempSync(join(scratch, "unit-"));
    writeFileSync(join(dir, "f"), "x");
    fileFd = openSync(join(dir, "f"), "r+");
    folderFd = openSync(dir, "r");
    deviceFd = openSync("/dev/null", "r+");
  });
  afterAll(() => { for (const fd of [fileFd, folderFd, deviceFd]) closeSync(fd); });
  const closedFd = () => { const fd = openSync(join(dir, "f"), "r"); closeSync(fd); return fd; };
  const sentinel = new Error("native says no");

  it("does not call native for a regular file or a folder", () => {
    const nativeCall = vi.fn();
    const call = withoutDeviceFlush(nativeCall, fstatSync);
    expect(call(fileFd)).toBeUndefined();
    expect(call(folderFd)).toBeUndefined();
    expect(nativeCall).not.toHaveBeenCalled();
  });

  it("passes every other descriptor to native, with its result or its error", () => {
    const nativeCall = vi.fn();
    expect(withoutDeviceFlush(nativeCall, fstatSync)(deviceFd)).toBeUndefined();
    expect(nativeCall).toHaveBeenCalledExactlyOnceWith(deviceFd);
    const failing = vi.fn(() => { throw sentinel; });
    expect(() => withoutDeviceFlush(failing, fstatSync)(deviceFd)).toThrow(sentinel);
    expect(failing).toHaveBeenCalledExactlyOnceWith(deviceFd);
  });

  it("passes a closed descriptor to native, so native's error is the one thrown", () => {
    const failing = vi.fn(() => { throw sentinel; });
    const fd = closedFd();
    expect(() => withoutDeviceFlush(failing, fstatSync)(fd)).toThrow(sentinel);
    expect(failing).toHaveBeenCalledExactlyOnceWith(fd);
  });

  it("passes anything that is not a descriptor to native, even if fstat would accept it", () => {
    const aFile = { isFile: () => true, isDirectory: () => false };
    for (const arg of ["3", -1, 1.5, Number.NaN, 2 ** 31, undefined, null, 3n, {}]) {
      const failing = vi.fn(() => { throw sentinel; });
      expect(() => withoutDeviceFlush(failing, () => aFile)(arg as number), String(arg)).toThrow(sentinel);
      expect(failing, String(arg)).toHaveBeenCalledExactlyOnceWith(arg);
    }
  });

  it("keeps the native function's name", () => {
    function fsyncSomething() {}
    expect(withoutDeviceFlush(fsyncSomething, fstatSync).name).toBe("fsyncSomething");
  });
});

describe("installNoSync", () => {
  const device = () => openSync("/dev/null", "r+");
  const fakeFs = () => {
    const fsync = vi.fn();
    const fdatasync = vi.fn();
    return { fsync, fdatasync, fs: { fsyncSync: fsync as (fd: number) => void, fdatasyncSync: fdatasync as (fd: number) => void, fstatSync: fstatSync as (fd: number) => { isFile(): boolean; isDirectory(): boolean } } };
  };

  it("replaces each function over its own original, then syncs the ES module exports", () => {
    const { fsync, fdatasync, fs } = fakeFs();
    let replacedWhenSynced: boolean | undefined;
    const sync = vi.fn(() => { replacedWhenSynced = fs.fsyncSync !== fsync && fs.fdatasyncSync !== fdatasync; });
    installNoSync(fs, sync);
    expect(sync).toHaveBeenCalledOnce();
    expect(replacedWhenSynced).toBe(true);
    const fd = device();
    try {
      fs.fsyncSync(fd);
      expect(fsync).toHaveBeenCalledExactlyOnceWith(fd);
      expect(fdatasync).not.toHaveBeenCalled();
      fs.fdatasyncSync(fd);
      expect(fdatasync).toHaveBeenCalledExactlyOnceWith(fd);
      expect(fsync).toHaveBeenCalledOnce();
    } finally {
      closeSync(fd);
    }
  });

  it("starts from the original when it runs again in the same process", () => {
    const { fsync, fdatasync, fs } = fakeFs();
    installNoSync(fs, () => {});
    installNoSync(fs, () => {});
    expect((fs.fsyncSync as { [NATIVE]?: unknown })[NATIVE]).toBe(fsync);
    expect((fs.fdatasyncSync as { [NATIVE]?: unknown })[NATIVE]).toBe(fdatasync);
    const fd = device();
    try {
      fs.fsyncSync(fd);
      expect(fsync).toHaveBeenCalledOnce();
    } finally {
      closeSync(fd);
    }
  });
});
