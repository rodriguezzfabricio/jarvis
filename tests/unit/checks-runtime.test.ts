import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { runGate } from "../../packages/cli/src/checks/gate.ts";
import { foundationChecks } from "../../packages/cli/src/doctor/foundation.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { installDesignChecks } from "../../packages/cli/src/lanes/impeccable-install.ts";
import { installDesignLintChecks } from "../../packages/cli/src/lanes/design-protected.ts";
import { installDesktopChecks } from "../../packages/cli/src/lanes/desktop.ts";
import { installSecurityChecks } from "../../packages/cli/src/security/protected.ts";
import { installChecks, readApprovedChecks, readInstalledChecks } from "../../packages/cli/src/runner/checks-author.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const unit = { name: "unit", criteria: [], cases: [{ id: "unit", command: "node --test" }], verify: 'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"', timeoutMs: 1000 };
const authored = () => ({ checks: [unit], files: { "unit.check.json": JSON.stringify(unit) } });
const options = { spec: { criteria: [] }, reviewVerdict: async () => ({ status: "pass" }) };
function setup() {
  const root = mkdtempSync("/private/tmp/j-runtime-"); roots.push(root);
  const ledger = Ledger.open(join(root, "projects", "p")), store = new ChecksStore(ledger.dir);
  const put = (file: string, data: string | Buffer) => { const path = join(store.checksDir, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); return path; };
  put("unit.check.json", JSON.stringify(unit));
  return { root, ledger, store, put };
}
it("loads definitions beside the real protected installers, binary engine and more than 256 runtime files", async () => {
  const f = setup(), engine = join(f.root, "engine"), bytes = Buffer.alloc(300_000, 0xff);
  writeFileSync(engine, bytes);
  const defs = installDesignChecks(f.store, { nodeBin: process.execPath, axeVersion: "4.14.0", scanner: {
    pin: { bin: engine, version: "0.1.16", sha256: createHash("sha256").update(bytes).digest("hex") }, files: ["app.html"],
    browser: { manifest: "/tools/manifest.json", manifestHash: "a".repeat(64), url: "http://127.0.0.1:3000/", port: 9222 },
  }, plan: { designId: "one", flows: [{ id: "main", screen: "main", url: "http://127.0.0.1:3000/", steps: [], expectText: "Ready" }] } });
  installDesignLintChecks(f.store, { nodeBin: process.execPath, axeVersion: "4.14.0", designSource: "existing", files: ["app.html"], design: readFileSync(new URL("../fixtures/qa/DESIGN.md", import.meta.url), "utf8") });
  installSecurityChecks(f.store, { nodeBin: process.execPath, scanners: {} });
  for (let i = 0; i < 257; i++) f.put(`fixtures/design-runtime/data/${i}`, Buffer.from([0xff, i % 256]));
  f.put("fixtures/design-runtime/fake.check.json", "not a definition");
  f.store.approve(f.ledger, "protected installers reviewed");
  expect(readApprovedChecks(f.store, f.ledger).map(c => c.name).sort()).toEqual(["unit", "ai-tells", "token-lint", "design-md-lint", ...Object.keys(defs)].sort());
  const before = f.store.hashAll(), review = vi.fn(options.reviewVerdict);
  await installChecks(f.store, authored(), f.ledger, { ...options, reviewVerdict: review });
  expect(review).toHaveBeenCalledOnce();
  expect(readInstalledChecks(f.store).map(c => c.name)).toEqual(["unit"]);
  expect(f.store.hashAll()).toEqual(before);
  expect(f.store.verify(f.ledger).ok).toBe(true);
});
it.each(["flip", "extra", "symlink", "hardlink", "oversize", "count", "fifo"])("doctor and gate refuse runtime %s before spawning", async fault => {
  const f = setup(), path = f.put("fixtures/design-runtime/engine", Buffer.from([0, 0xff, 4]));
  f.store.approve(f.ledger, "original");
  if (fault === "flip") writeFileSync(path, Buffer.from([0, 0xfe, 4]));
  // A special file was skipped by the old walk, so it never showed up as an added check.
  if (fault === "fifo") execFileSync("/usr/bin/mkfifo", [join(dirname(path), "pipe")]);
  if (fault === "extra") f.put("design-runtime/extra", "unapproved");
  if (fault === "symlink") { rmSync(path); symlinkSync(join(f.store.checksDir, "unit.check.json"), path); }
  if (fault === "hardlink") linkSync(path, join(dirname(path), "alias"));
  if (fault === "oversize") { const fd = openSync(path, "r+"); ftruncateSync(fd, 256 * 1024 * 1024 + 1); closeSync(fd); }
  if (fault === "count") for (let i = 0; i < 4096; i++) f.put(`design-runtime/${i}`, "");
  expect(f.store.verify(f.ledger).ok).toBe(false);
  const sandbox = vi.fn(async () => { throw new Error("must not spawn"); });
  expect((await runGate({ ledger: f.ledger, store: f.store, projectDir: f.ledger.dir, jarvisHome: f.root, workRoot: f.root, repoPath: f.root, revision: "a".repeat(40), check: unit, taskId: "T1", attemptId: "a1", sandbox })).status).toBe("tampered");
  expect(sandbox).not.toHaveBeenCalled();
  const checks = await foundationChecks({ jarvisHome: f.root, pluginDir: "/missing-plugin", socketPath: join(f.root, "none.sock") });
  expect(checks.find(c => c.name === "checks.p")?.level).toBe("fail");
});
it.each(["oversize", "count", "total", "symlink-root", "directories", "depth"])("refuses approval of invalid runtime %s", fault => {
  const f = setup();
  if (fault === "symlink-root") { mkdirSync(join(f.root, "other")); symlinkSync(join(f.root, "other"), join(f.store.checksDir, "design-runtime")); }
  // 4,097 runtime folders counting design-runtime itself; then a file 40 folders below the store.
  else if (fault === "directories") for (let i = 0; i < 4096; i++) mkdirSync(join(f.store.checksDir, "design-runtime", String(i)), { recursive: true });
  else if (fault === "depth") f.put(`design-runtime/${Array(40).fill("d").join("/")}/engine`, "deep");
  else {
    const count = fault === "count" ? 4097 : fault === "total" ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const path = f.put(`design-runtime/${i}`, "");
      if (fault !== "count") { const fd = openSync(path, "r+"); ftruncateSync(fd, 256 * 1024 * 1024 + (fault === "oversize" ? 1 : 0)); closeSync(fd); }
    }
  }
  expect(() => f.store.approve(f.ledger, "must refuse")).toThrow();
  expect(f.ledger.entries()).toHaveLength(0);
});
it.each(["bytes", "count", "total", "utf8"])("retains strict definition %s limits", fault => {
  const f = setup();
  if (fault === "bytes") f.put("unit.check.json", " ".repeat(262145));
  if (fault === "utf8") f.put("unit.check.json", Buffer.from([0xff]));
  if (fault === "count") for (let i = 0; i < 256; i++) f.put(`${i}.check.json`, JSON.stringify({ ...unit, name: `n${i}` }));
  if (fault === "total") for (let i = 0; i < 17; i++) f.put(`${i}.check.json`, JSON.stringify({ ...unit, name: `n${i}` }).padEnd(262144));
  f.store.approve(f.ledger, "definitions");
  expect(() => readApprovedChecks(f.store, f.ledger)).toThrow();
});
it.each(["overwrite", "remove", "race"])("architect install cannot %s protected artifacts", async fault => {
  const f = setup(); f.put("design-review.json", '{"designSource":"existing"}');
  f.put("design-runtime/engine", Buffer.from([0xff])); f.store.approve(f.ledger, "protected");
  const bundle = authored();
  if (fault === "overwrite") Object.assign(bundle.files, { "fixtures/design-runtime/injected.mjs": "console.log('injected')" });
  const reviewVerdict = vi.fn(async () => { if (fault === "race") f.put("design-runtime/engine", Buffer.from([0xfe])); return { status: "pass" }; });
  await expect(installChecks(f.store, bundle, f.ledger, { ...options, reviewVerdict, ...(fault === "remove" ? { removeFiles: ["design-review.json"] } : {}) })).rejects.toThrow();
  if (fault !== "race") expect(reviewVerdict).not.toHaveBeenCalled();
  else expect(reviewVerdict).toHaveBeenCalledOnce();
  expect(f.ledger.entries().filter(e => e.kind === "checks_approved")).toHaveLength(1);
});
// The default APFS volume folds case (and some Unicode), so a reserved name must be refused in every spelling
// that lands in the same folder, and below a reserved file too. All are refused before any review session.
it.each([
  ["fixtures/Design-Runtime/lanes/evil.mjs", "console.log('planted')"],
  ["Impeccable-Source.check.json", JSON.stringify({ ...unit, name: "scan" })],
  ["fixtures/design-plan.json/inner.json", "{}"],
  ["fixtures/SECURITY/rules/semgrep/extra.json", "{}"],
  ["expected/axe-base.json", "{}"],
  ["fixtures/deſign-runtime/lanes/evil.mjs", "console.log('planted')"],
])("architect install refuses the reserved spelling %s before review", async (path, content) => {
  const f = setup(); f.put("fixtures/design-runtime/engine", Buffer.from([0xff])); f.store.approve(f.ledger, "protected");
  const bundle = authored(); Object.assign(bundle.files, { [path]: content });
  const reviewVerdict = vi.fn(options.reviewVerdict);
  await expect(installChecks(f.store, bundle, f.ledger, { ...options, reviewVerdict })).rejects.toThrow(/invalid authored check file|ASCII/);
  expect(reviewVerdict).not.toHaveBeenCalled();
  expect(f.ledger.entries().filter(e => e.kind === "checks_approved")).toHaveLength(1);
});
it.each(["token-lint", "design-browser", "impeccable-url"])("architect install refuses a check that takes the protected name %s", async name => {
  const f = setup(); f.store.approve(f.ledger, "architect");
  const bundle = authored(); Object.assign(bundle.files, { "shadow.check.json": JSON.stringify({ ...unit, name }) });
  const reviewVerdict = vi.fn(options.reviewVerdict);
  await expect(installChecks(f.store, bundle, f.ledger, { ...options, reviewVerdict })).rejects.toThrow(/reserved/);
  expect(reviewVerdict).not.toHaveBeenCalled();
});
it("does not bless an unapproved protected-only store through an architect install", async () => {
  const f = setup(); rmSync(join(f.store.checksDir, "unit.check.json"));
  f.put("design-runtime/engine", Buffer.from([0xff]));
  const reviewVerdict = vi.fn(options.reviewVerdict);
  await expect(installChecks(f.store, authored(), f.ledger, { ...options, reviewVerdict })).rejects.toThrow(/approved/);
  expect(reviewVerdict).not.toHaveBeenCalled(); expect(f.ledger.entries()).toHaveLength(0);
});
it("does not bless a protected installer appearing during the first architect review", async () => {
  const f = setup(); rmSync(f.store.checksDir, {recursive:true});
  await expect(installChecks(f.store, authored(), f.ledger, { ...options, reviewVerdict: async () => {
    f.put("design-runtime/engine", Buffer.from([0xff])); return {status:"pass"};
  } })).rejects.toThrow(/changed during review/);
  expect(f.ledger.entries()).toHaveLength(0);
});

it("preserves the desktop protected installer alongside architect checks", async () => {
  const f = setup();
  installDesktopChecks(f.store, {nodeBin:process.execPath,tauriBin:"/tools/tauri",build:{bin:"/tools/npm",args:["run","build"]},bundle:"target/Jobs.app",stayUpMs:100,shutdownMs:100,buildTimeoutMs:1000});
  f.store.approve(f.ledger, "desktop reviewed"); const before = f.store.hashAll();
  await installChecks(f.store, authored(), f.ledger, options);
  expect(f.store.hashAll()).toEqual(before); expect(f.store.verify(f.ledger).ok).toBe(true);
});
it.each(["fixtures/security", "fixtures/desktop"])("bounds the other protected installer runtime in %s", root => {
  const f = setup(), path = f.put(`${root}/oversize`, "");
  const fd = openSync(path,"r+"); ftruncateSync(fd,256*1024*1024+1); closeSync(fd);
  expect(() => f.store.approve(f.ledger,"oversize runtime")).toThrow();
});
