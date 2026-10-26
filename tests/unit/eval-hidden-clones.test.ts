import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Both seams pass through to the real functions. Node's fs can't clone on macOS (see the real-clone test),
// so these tests watch which copy installHiddenChecks asks for and also run the real one.
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, cpSync: vi.fn(fs.cpSync) };
});
vi.mock("node:child_process", async importOriginal => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, execFileSync: vi.fn(cp.execFileSync) };
});
import { cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { installHiddenChecks, loadHiddenChecks } from "../../packages/cli/src/eval/hidden.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const onPlatform = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
const realExecFileSync = process.getBuiltinModule("node:child_process").execFileSync; // the mock above wraps the imported one
const macOnly = process.platform === "darwin" ? it : it.skip;

let root: string;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (root) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function hiddenFolder(): string {
  root = mkdtempSync(join(tmpdir(), "hidden-clones-"));
  const hidden = join(root, "hidden");
  mkdirSync(join(hidden, "fixtures"), { recursive: true });
  writeFileSync(join(hidden, "unit.check.json"), JSON.stringify({ name: "unit", cases: [{ id: "unit", command: "echo fake" }], verify: "echo fake verify", timeoutMs: 1000 }));
  writeFileSync(join(hidden, "fixtures", "fixture"), "original fixture bytes");
  return hidden;
}

const cloneCalls = () => vi.mocked(execFileSync).mock.calls.filter(([file]) => file === "/bin/cp");

macOnly("asks cp for APFS clones of the real hidden folder, never a Node copy, and keeps hashes independent", () => {
  const hidden = hiddenFolder();
  const project = join(root, "project"), ledger = Ledger.open(project);
  const store = installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "test fixtures");
  expect(cloneCalls().map(([, args]) => args)).toEqual([["-cR", realpathSync(hidden), store.checksDir]]);
  expect(cpSync).not.toHaveBeenCalled();
  expect(store.verify(ledger).ok).toBe(true);
  expect(() => installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "again")).toThrow(/fresh/);
  // The clone and its source are independent: a write on either side leaves the other alone.
  writeFileSync(join(hidden, "fixtures", "fixture"), "source changed after install");
  expect(readFileSync(join(store.checksDir, "fixtures", "fixture"), "utf8")).toBe("original fixture bytes");
  expect(store.verify(ledger).ok).toBe(true);
  writeFileSync(join(store.checksDir, "fixtures", "fixture"), "installed copy tampered");
  expect(readFileSync(join(hidden, "fixtures", "fixture"), "utf8")).toBe("source changed after install");
  expect(store.verify(ledger).ok).toBe(false);
});

it("copies with Node off macOS, without asking cp", () => {
  const hidden = hiddenFolder();
  onPlatform("linux");
  const project = join(root, "project"), ledger = Ledger.open(project);
  const store = installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "linux");
  expect(cloneCalls()).toEqual([]);
  expect(cpSync).toHaveBeenCalledWith(realpathSync(hidden), store.checksDir, { recursive: true, errorOnExist: true, force: false });
  expect(readFileSync(join(store.checksDir, "fixtures", "fixture"), "utf8")).toBe("original fixture bytes");
  expect(store.verify(ledger).ok).toBe(true);
});

macOnly("falls back to an ordinary copy when cp fails, and clears what the failed cp left behind", () => {
  const hidden = hiddenFolder();
  vi.mocked(execFileSync).mockImplementationOnce(((file: string, args: string[]) => {
    // A cp that dies halfway: some of the tree is already in place when it fails.
    realExecFileSync(file, ["-R", ...args.slice(1)]);
    throw new Error("cp: clonefile failed");
  }) as typeof execFileSync);
  const project = join(root, "project"), ledger = Ledger.open(project);
  const store = installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "cp failed");
  expect(cloneCalls()).toHaveLength(1);
  expect(cpSync).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(store.checksDir, "fixtures", "fixture"), "utf8")).toBe("original fixture bytes");
  expect(store.verify(ledger).ok).toBe(true);
});

it("refuses a copy whose bytes changed before approval", () => {
  const hidden = hiddenFolder();
  const racing = (source: unknown) => writeFileSync(join(String(source), "raced"), "added after source hashing");
  vi.mocked(cpSync).mockImplementationOnce((source, destination, options) => {
    racing(source);
    process.getBuiltinModule("node:fs").cpSync(source, destination, options);
  });
  vi.mocked(execFileSync).mockImplementationOnce(((file: string, args: string[]) => {
    racing(args[1]);
    return realExecFileSync(file, args);
  }) as typeof execFileSync);
  const project = join(root, "project"), ledger = Ledger.open(project);
  expect(() => installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "raced")).toThrow(/changed while/);
  expect(ledger.entries().filter(e => e.kind === "checks_approved")).toEqual([]);
});

// Node 24 ignores cpSync's COPYFILE_FICLONE mode for a tree and copyFileSync's on macOS, so only this
// measures what the disk really pays. Free space is shared with the rest of the machine, so a noisy first
// reading gets one more try before it counts.
macOnly("the installed copy costs a fraction of the hidden folder's size on disk", () => {
  const hidden = hiddenFolder();
  const megabytes = 128;
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  for (let i = 0; i < megabytes; i++) { chunk.writeUInt32LE(i * 2654435761 >>> 0, 0); writeFileSync(join(hidden, "fixtures", `blob-${i}`), chunk); }
  const free = () => { const s = statfsSync(root); return Number(s.bavail) * Number(s.bsize) / (1024 * 1024); };
  const used: number[] = [];
  for (const attempt of ["a", "b"]) {
    const project = join(root, `project-${attempt}`);
    const before = free();
    const store = installHiddenChecks(project, Ledger.open(project), loadHiddenChecks(hidden), "size");
    used.push(before - free());
    expect(existsSync(join(store.checksDir, "fixtures", "blob-0"))).toBe(true);
    if (used.at(-1)! < megabytes / 4) break;
  }
  expect(Math.min(...used)).toBeLessThan(megabytes / 4);
}, 60_000);
