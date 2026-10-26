import { constants, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, cpSync: vi.fn(fs.cpSync) };
});
import { cpSync } from "node:fs";
import { installHiddenChecks, loadHiddenChecks } from "../../packages/cli/src/eval/hidden.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
it("requests copy-on-write clones with copy fallback and keeps installed hashes independent", () => {
  root = mkdtempSync(join(tmpdir(), "hidden-clones-"));
  const hidden = join(root, "hidden"); mkdirSync(hidden);
  writeFileSync(join(hidden, "unit.check.json"), JSON.stringify({ name: "unit", cases: [{ id: "unit", command: "echo fake" }], verify: "echo fake verify", timeoutMs: 1000 }));
  writeFileSync(join(hidden, "fixture"), "original fixture bytes");
  const project = join(root, "project"), ledger = Ledger.open(project);
  const store = installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "test fixtures");
  expect(cpSync).toHaveBeenCalledWith(realpathSync(hidden), store.checksDir, { recursive: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
  expect(store.verify(ledger).ok).toBe(true);
  expect(() => installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "again")).toThrow(/fresh/);
  writeFileSync(join(hidden, "fixture"), "source changed after install");
  expect(readFileSync(join(store.checksDir, "fixture"), "utf8")).toBe("original fixture bytes");
  expect(store.verify(ledger).ok).toBe(true);
  writeFileSync(join(store.checksDir, "fixture"), "installed copy tampered");
  expect(store.verify(ledger).ok).toBe(false);
});

it("refuses a copy whose bytes changed before approval", () => {
  root = mkdtempSync(join(tmpdir(), "hidden-clones-"));
  const hidden = join(root, "hidden"); mkdirSync(hidden);
  writeFileSync(join(hidden, "unit.check.json"), JSON.stringify({ name: "unit", cases: [{ id: "unit", command: "echo fake" }], verify: "echo fake verify", timeoutMs: 1000 }));
  vi.mocked(cpSync).mockImplementationOnce((source, destination, options) => {
    writeFileSync(join(String(source), "raced"), "added after source hashing");
    process.getBuiltinModule("node:fs").cpSync(source, destination, options);
  });
  const project = join(root, "project"), ledger = Ledger.open(project);
  expect(() => installHiddenChecks(project, ledger, loadHiddenChecks(hidden), "raced")).toThrow(/changed while/);
  expect(ledger.entries().filter(e => e.kind === "checks_approved")).toEqual([]);
});
