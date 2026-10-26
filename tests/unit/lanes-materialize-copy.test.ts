import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeTree } from "../../packages/cli/src/lanes/materialize.ts";
import { installChromiumBundle } from "../../packages/cli/src/lanes/chromium-install.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
const roots: string[] = [];
const temp = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "qa-copy-safe-"))); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup(contents = "safe") {
  const root = temp(); const source = join(root, "candidate"); const destination = join(root, "copy"); fs.mkdirSync(source);
  const file = join(source, "file"); fs.writeFileSync(file, contents); fs.chmodSync(file, 0o751);
  const outside = join(root, "outside"); fs.writeFileSync(outside, "outside-private-data");
  return { root, source, destination, file, outside };
}

describe("descriptor-based bounded materialization (backlog 89)", () => {
  it("copies regular files and internal aliases with independent bytes, modes and hashes", () => {
    const s = setup(); fs.symlinkSync("file", join(s.source, "alias"));
    const files = materializeTree(s.source, s.destination);
    const digest = createHash("sha256").update("safe").digest("hex");
    expect(files).toEqual({ file: digest, alias: digest });
    expect(fs.lstatSync(join(s.destination, "alias")).isSymbolicLink()).toBe(false);
    expect(fs.statSync(join(s.destination, "file")).mode & 0o777).toBe(0o751);
    fs.writeFileSync(s.file, "changed"); expect(fs.readFileSync(join(s.destination, "file"), "utf8")).toBe("safe");
  });
  it("refuses a file swapped for an outside symlink at open, before reading any bytes", () => {
    const s = setup(); const read = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => fs.readSync(fd, buffer, offset, length, position)); const open = vi.fn((path: fs.PathLike, flags: string | number) => {
      if (path === s.file) { fs.unlinkSync(s.file); fs.symlinkSync(s.outside, s.file); }
      return fs.openSync(path, flags);
    });
    expect(() => materializeTree(s.source, s.destination, { fs: { openSync: open, readSync: read } })).toThrow();
    expect(open).toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("opens each source with O_NOFOLLOW and copies from that same descriptor", () => {
    const s = setup(); const opened: number[] = []; const allOpened: number[] = []; const close = vi.fn(fs.closeSync);
    const open = vi.fn((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const data = (Number(flags) & 0x20000000) === 0;
      if (path === s.file && data) { expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW); expect(Number(flags) & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK); }
      const fd = fs.openSync(path, flags, mode); allOpened.push(fd); if (path === s.file && data) opened.push(fd); return fd;
    });
    const read = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => fs.readSync(fd, buffer, offset, length, position));
    materializeTree(s.source, s.destination, { fs: { openSync: open, closeSync: close, readSync: read } });
    expect(opened).toHaveLength(1); expect(read).toHaveBeenCalled();
    for (const call of read.mock.calls) expect(call[0]).toBe(opened[0]);
    for (const fd of allOpened) expect(close).toHaveBeenCalledWith(fd);
  });
  it("rejects a parent swapped for an outside symlink, even when the final component is regular", () => {
    const s = setup(); const dir = join(s.source, "dir"); fs.mkdirSync(dir); fs.renameSync(s.file, join(dir, "file"));
    const outsideDir = join(s.root, "outside-dir"); fs.mkdirSync(outsideDir); fs.writeFileSync(join(outsideDir, "file"), "outside");
    const open = vi.fn((path: fs.PathLike, flags: string | number) => {
      if (path === join(dir, "file")) { fs.renameSync(dir, join(s.source, "saved")); fs.symlinkSync(outsideDir, dir); }
      return fs.openSync(path, flags);
    });
    expect(() => materializeTree(s.source, s.destination, { fs: { openSync: open } })).toThrow();
    expect(open).toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it.skipIf(process.platform !== "darwin")("refuses a parent that oscillates between directory and outside alias during checks", () => {
    const s = setup(); const dir = join(s.source, "dir"); const saved = join(s.source, "saved"); fs.mkdirSync(dir);
    const file = join(dir, "file"); fs.renameSync(s.file, file);
    const outside = join(s.root, "outside-dir"); fs.mkdirSync(outside); fs.copyFileSync(s.outside, join(outside, "file"));
    const escape = () => { fs.renameSync(dir, saved); fs.symlinkSync(outside, dir); };
    let first = true;
    const realpath = (path: string) => { const real = fs.realpathSync(path); if (path === file) escape(); return real; };
    const fstat = (fd: number) => {
      const stat = fs.fstatSync(fd);
      if (first) { first = false; fs.unlinkSync(dir); fs.renameSync(saved, dir); }
      return stat;
    };
    const read = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => fs.readSync(fd, buffer, offset, length, position));
    expect(() => materializeTree(s.source, s.destination, { fs: { realpathSync: realpath, fstatSync: fstat, readSync: read } })).toThrow();
    expect(read).not.toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("passes Darwin's all-component no-follow flag to the source open", () => {
    const s = setup(); const open = vi.fn((path: string, flags: number) => {
      return fs.openSync(path, flags & ~0x20000000);
    });
    const options = { platform: "darwin" as const, fs: { openSync: open } };
    materializeTree(s.source, s.destination, options); expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0]?.[1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    expect(open.mock.calls[1]?.[1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | 0x20000000);
  });
  it("verifies the Linux descriptor target before reading it", () => {
    const s = setup(); const read = vi.fn(() => 0);
    const options = { platform: "linux" as const, fs: { realpathSync: (path: string) => path.startsWith("/proc/self/fd/") ? s.outside : fs.realpathSync(path), readSync: read } };
    expect(() => materializeTree(s.source, s.destination, options)).toThrow(/escapes/);
    expect(read).not.toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("copies a Linux descriptor whose resolved target stays in the tree", () => {
    const s = setup();
    const realpath = vi.fn((path: string) => path.startsWith("/proc/self/fd/") ? s.file : fs.realpathSync(path));
    const options = { platform: "linux" as const, fs: { realpathSync: realpath } };
    materializeTree(s.source, s.destination, options);
    expect(realpath).toHaveBeenCalledWith(expect.stringMatching(/^\/proc\/self\/fd\/\d+$/));
    expect(fs.readFileSync(join(s.destination, "file"), "utf8")).toBe("safe");
  });
  it("fails closed on hosts without a secure path or descriptor check", () => {
    const s = setup(); const open = vi.fn(fs.openSync);
    const options = { platform: "win32" as const, fs: { openSync: open } };
    expect(() => materializeTree(s.source, s.destination, options)).toThrow(/unsupported/);
    expect(open).not.toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("checks that the opened descriptor is regular and closes it on refusal", () => {
    const s = setup(); const close = vi.fn(fs.closeSync); const fstat = vi.fn(() => Object.assign(fs.statSync(s.file), { isFile: () => false }));
    expect(() => materializeTree(s.source, s.destination, { fs: { fstatSync: fstat, closeSync: close } })).toThrow(/regular|changed|special/);
    expect(fstat).toHaveBeenCalled(); expect(close).toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("refuses a different regular inode substituted before open", () => {
    const s = setup(); const open = vi.fn((path: fs.PathLike, flags: string | number) => {
      if (path === s.file) { fs.renameSync(s.file, join(s.source, "saved")); fs.writeFileSync(s.file, "fake"); }
      return fs.openSync(path, flags);
    });
    expect(() => materializeTree(s.source, s.destination, { fs: { openSync: open } })).toThrow(/changed/);
    expect(open).toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("fails closed on the cumulative byte limit and removes partial output", () => {
    const s = setup(); fs.writeFileSync(join(s.source, "second"), "more");
    expect(() => materializeTree(s.source, s.destination, { maxBytes: 7 })).toThrow(/byte.*limit/);
    expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("counts every materialized alias toward the file limit", () => {
    const s = setup(); fs.symlinkSync("file", join(s.source, "alias"));
    expect(() => materializeTree(s.source, s.destination, { maxFiles: 1 })).toThrow(/file.*limit/);
    expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("bounds empty directories as well as regular files", () => {
    const s = setup(); fs.unlinkSync(s.file); fs.mkdirSync(join(s.source, "one")); fs.mkdirSync(join(s.source, "two"));
    expect(() => materializeTree(s.source, s.destination, { maxFiles: 1 })).toThrow(/file.*limit/);
    expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("allows exactly the byte and file limits", () => {
    const s = setup(); fs.writeFileSync(join(s.source, "second"), "more");
    expect(Object.keys(materializeTree(s.source, s.destination, { maxBytes: 8, maxFiles: 2 }))).toHaveLength(2);
  });
  it("applies the default 2 GiB byte cap before attempting to read an oversized file", () => {
    const s = setup(); const read = vi.fn(() => 0);
    const fstat = vi.fn(() => Object.assign(fs.statSync(s.file), { size: 2 * 1024 ** 3 + 1 }));
    expect(() => materializeTree(s.source, s.destination, { fs: { fstatSync: fstat, readSync: read } })).toThrow(/byte.*limit/);
    expect(read).not.toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("caps bytes actually read when a source grows after fstat", () => {
    const s = setup(); let grown = false;
    const read = vi.fn((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      if (!grown) { grown = true; fs.appendFileSync(s.file, "overflow"); }
      return fs.readSync(fd, buffer, offset, length, position);
    });
    expect(() => materializeTree(s.source, s.destination, { maxBytes: 4, fs: { readSync: read } })).toThrow(/byte.*limit|changed/);
    expect(read).toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("refuses a source modified in place during copying, even without exceeding the budget", () => {
    const s = setup(); let changed = false;
    const read = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const bytes = fs.readSync(fd, buffer, offset, length, position);
      if (!changed) { changed = true; fs.writeFileSync(s.file, "evil"); fs.utimesSync(s.file, 10, 10); }
      return bytes;
    });
    expect(() => materializeTree(s.source, s.destination, { fs: { readSync: read } })).toThrow(/changed during copy/);
    expect(read).toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid resource caps: %s", cap => {
    const s = setup();
    expect(() => materializeTree(s.source, s.destination, { maxBytes: cap })).toThrow(/limit/);
    expect(() => materializeTree(s.source, s.destination, { maxFiles: cap })).toThrow(/limit/);
    expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("rejects escaping and cyclic aliases", () => {
    const s = setup(); fs.symlinkSync(s.outside, join(s.source, "escape"));
    expect(() => materializeTree(s.source, s.destination)).toThrow(/escapes/);
    fs.unlinkSync(join(s.source, "escape")); fs.symlinkSync(".", join(s.source, "cycle"));
    expect(() => materializeTree(s.source, s.destination)).toThrow(/cyclic/);
    expect(fs.existsSync(s.destination)).toBe(false);
  });
  it("refuses a source root swapped outside the approved checkout before resolution", () => {
    const s = setup(); const outside = temp(); fs.writeFileSync(join(outside, "file"), "outside-private-data");
    const read = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => fs.readSync(fd, buffer, offset, length, position));
    const realpath = (path: string) => {
      if (path === s.source) { fs.renameSync(s.source, join(s.root, "saved")); fs.symlinkSync(outside, s.source); }
      return fs.realpathSync(path);
    };
    const options = { sourceRoot: s.root, fs: { realpathSync: realpath, readSync: read } };
    expect(() => materializeTree(s.source, s.destination, options)).toThrow(/approved|escapes/);
    expect(read).not.toHaveBeenCalled(); expect(fs.existsSync(s.destination)).toBe(false);
  });
});

describe("Chromium installer uses the bounded descriptor copier", () => {
  const ok = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
  function setupInstall() {
    const s = setup(); const approved = fakeToolchain(temp()); const manifestPath = join(approved.toolchain.root, "manifest.json");
    const input = { sourceBundle: s.source, destination: join(approved.toolchain.root, "Chromium.app"), executable: "file", manifestPath };
    return { ...s, input, original: fs.readFileSync(manifestPath, "utf8") };
  }
  it("does not launch or update the manifest when the candidate exceeds its copy budget", async () => {
    const s = setupInstall(); const spawn = vi.fn(async () => ok);
    await expect(installChromiumBundle(s.input, { spawn, materialize: { maxBytes: 3 } })).rejects.toThrow(/byte.*limit/);
    expect(spawn).not.toHaveBeenCalled(); expect(fs.existsSync(s.input.destination)).toBe(false);
    expect(fs.readFileSync(s.input.manifestPath, "utf8")).toBe(s.original);
  });
  it("refuses an injected source swap before smoke launching or updating the manifest", async () => {
    const s = setupInstall(); const spawn = vi.fn(async () => ok);
    const open = vi.fn((path: string, flags: number) => {
      if (path === s.file) { fs.unlinkSync(s.file); fs.symlinkSync(s.outside, s.file); }
      return fs.openSync(path, flags);
    });
    await expect(installChromiumBundle(s.input, { spawn, materialize: { fs: { openSync: open } } })).rejects.toThrow();
    expect(open).toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(fs.existsSync(s.input.destination)).toBe(false);
    expect(fs.readFileSync(s.input.manifestPath, "utf8")).toBe(s.original);
  });
});
