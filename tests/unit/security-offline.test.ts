import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as pinsModule from "../../packages/cli/src/config/pins.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { installSecurityChecks } from "../../packages/cli/src/security/protected.ts";
import { runScanner, scannerDoctorChecks, type ScannerPin, type ScannerPins } from "../../packages/cli/src/security/scanners.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "security-offline-")); roots.push(root);
  const checkout = join(root, "checkout"); const fixtures = join(root, "fixtures");
  for (const dir of [checkout, fixtures]) mkdirSync(dir);
  return { root, checkout, fixtures };
}
function pins(db?: string): ScannerPins {
  const fn = (pinsModule as unknown as { pinnedSecurityScanners: (db?: string) => ScannerPins }).pinnedSecurityScanners;
  expect(fn).toBeTypeOf("function"); return fn(db);
}
function database(dir: string, ecosystems = ["npm", "Go", "PyPI"]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cache.zip"), "fake offline database; never sent to a real scanner");
  const sha256 = createHash("sha256").update(readFileSync(join(dir, "cache.zip"))).digest("hex");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, scannerVersion: "2.7.0", fetchedAt: "2026-10-24T00:00:00.000Z", ecosystems, files: [{ path: "cache.zip", sha256 }] }));
}
const ok = (stdout: string, code = 0) => ({ code, stdout, stderr: "", timedOut: false, overflowed: false, durationMs: 0 });

it("pins all three installed scanners by absolute path and exact version", () => {
  const all = pins();
  expect(Object.fromEntries(Object.entries(all).map(([tool, pin]) => [tool, [pin.bin, pin.version]]))).toEqual({ gitleaks: ["/opt/homebrew/bin/gitleaks", "8.28.0"], semgrep: ["/opt/homebrew/bin/semgrep", "1.182.0"], "osv-scanner": ["/opt/homebrew/bin/osv-scanner", "2.7.0"] });
  expect(all.gitleaks!.args).toEqual(expect.arrayContaining(["--redact=100", "--ignore-gitleaks-allow", "--gitleaks-ignore-path=/dev/null"]));
  // Semgrep skips files over 1 MB by default and reports nothing about them (backlog 92, verified live).
  expect(all.semgrep!.args).toContain("--max-target-bytes=0");
});

it("uses only vendored Semgrep rules, disabled metrics, version checks and nosem", async () => {
  const { checkout, fixtures } = setup(); const pin = pins().semgrep!; const calls: SessionSpec[] = [];
  const result = await runScanner("semgrep", pin, checkout, { fixturesDir: fixtures, spawn: async (spec) => { calls.push(spec); return ok(spec.args.includes("--version") ? "1.182.0\n" : '{"results":[],"errors":[],"paths":{"scanned":[]}}'); } });
  expect(result.status).toBe("pass");
  const scan = calls[1]!;
  expect(scan.args).toEqual(expect.arrayContaining(["--metrics=off", "--disable-version-check", "--disable-nosem", "--json", "--max-target-bytes=0", "--config", pin.rulesFile]));
  expect(scan.env).toMatchObject({ SSL_CERT_FILE: "/etc/ssl/cert.pem", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" });
  expect(scan.env.HOME).not.toBe(checkout); expect(scan.env.TMPDIR).not.toBe(checkout);
  expect(Object.keys(scan.env).sort()).toEqual(["CI", "HOME", "LANG", "PATH", "SEMGREP_ENABLE_VERSION_CHECK", "SEMGREP_SEND_METRICS", "SSL_CERT_FILE", "TMPDIR"]);
  expect(existsSync(scan.env.HOME!)).toBe(false);
});

it.each(["auto", "p/security-audit", "https://example.invalid/rules.yml"])("rejects online Semgrep config %s before starting a process", async (config) => {
  const { checkout } = setup(); const pin = pins().semgrep!; let calls = 0;
  const args = pin.args.map((arg) => arg === "@rules" ? config : arg);
  expect(await runScanner("semgrep", { ...pin, args }, checkout, { spawn: async (spec) => { calls++; return ok(spec.args.includes("--version") ? "2.7.0" : '{"results":[]}'); } })).toMatchObject({ status: "error", detail: "invalid offline semgrep configuration" });
  expect(calls).toBe(0);
});

it.each(["--metrics=off", "--disable-version-check", "--disable-nosem", "--json", "--max-target-bytes=0"])("refuses Semgrep pins missing %s", async (flag) => {
  const { checkout } = setup(); const pin = pins().semgrep!;
  expect((await runScanner("semgrep", { ...pin, args: pin.args.filter((arg) => arg !== flag) }, checkout, { spawn: async (spec) => ok(spec.args.includes("--version") ? "1.182.0" : '{"results":[],"errors":[],"paths":{"scanned":[]}}') }))).toMatchObject({ status: "error", detail: "invalid offline semgrep configuration" });
});

it("recognizes OSV's own version without accepting its library version or a patched version", async () => {
  const { checkout } = setup(); const pin: ScannerPin = { bin: "/fake/osv-scanner", version: "2.7.0", args: [] };
  for (const [output, level] of [["osv-scanner version: 2.7.0\nosv-scalibr version: 0.5.3\ncommit: n/a\nbuilt at: n/a\n", "pass"], ["osv-scanner version: 2.6.0\nosv-scalibr version: 2.7.0\n", "fail"], ["osv-scanner version: 2.7.0+patched\n", "fail"], ["osv-scanner version: 2.7.0\nosv-scanner version: 2.7.0\n", "fail"]]) {
    const checks = await scannerDoctorChecks({ "osv-scanner": pin }, checkout, { spawn: async () => ok(output!) });
    expect(checks[2]!.level).toBe(level);
  }
});

it.each(["absent", "empty", "unhashed", "tampered", "partial"])("reports %s OSV database as not run before spawning", async (state) => {
  const { checkout, fixtures } = setup(); const dir = join(fixtures, "security/osv-db");
  if (state !== "absent") mkdirSync(dir, { recursive: true });
  if (state === "unhashed") writeFileSync(join(dir, "all.zip"), "fake");
  if (["tampered", "partial"].includes(state)) database(dir, state === "partial" ? ["Go"] : undefined);
  if (state === "tampered") writeFileSync(join(dir, "cache.zip"), "tampered");
  writeFileSync(join(checkout, "package-lock.json"), "{}");
  let calls = 0;
  expect(await runScanner("osv-scanner", pins()["osv-scanner"], checkout, { fixturesDir: fixtures, spawn: async () => { calls++; return ok('{"results":[]}'); } })).toMatchObject({ status: "not_run", detail: "not run: osv database missing" });
  expect(calls).toBe(0);
});

it("uses a hashed protected OSV database and explicitly selects offline matching", async () => {
  const { checkout, fixtures } = setup(); const db = join(fixtures, "security/osv-db"); database(db);
  const calls: SessionSpec[] = [];
  const result = await runScanner("osv-scanner", pins()["osv-scanner"], checkout, { fixturesDir: fixtures, spawn: async (spec) => { calls.push(spec); return ok(spec.args.includes("--version") ? "osv-scanner version: 2.7.0\nosv-scalibr version: 0.5.3\n" : '{"results":[]}'); } });
  expect(result.status).toBe("pass");
  expect(calls[1]!.args).toEqual(expect.arrayContaining(["--offline", "--offline-vulnerabilities", "--x-plugins=vulnmatch/osvlocal", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust", "--no-ignore", "--format=json", "--config=/dev/null"]));
  expect(calls[1]!.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY).toBe(realpathSync(db));
});

it.each(["--offline", "--offline-vulnerabilities", "--x-plugins=vulnmatch/osvlocal", "--config=/dev/null"])("refuses OSV pins missing %s", async (flag) => {
  const { checkout, fixtures } = setup(); database(join(fixtures, "security/osv-db")); const pin = pins()["osv-scanner"]!;
  expect((await runScanner("osv-scanner", { ...pin, args: pin.args.filter((arg) => arg !== flag) }, checkout, { fixturesDir: fixtures, spawn: async (spec) => ok(spec.args.includes("--version") ? "2.7.0" : '{"results":[]}') }))).toMatchObject({ status: "error", detail: "invalid offline osv configuration" });
});

// OSV 2.7.0 loads osv-scanner.toml next to every scanned lockfile, so a nested one can ignore a vulnerability or a
// whole package (live-checked: exit 0, no findings). An explicit --config replaces every per-folder file.
it("pins OSV to an empty override configuration so nested candidate osv-scanner.toml files are ignored", async () => {
  expect(pins()["osv-scanner"]!.args).toContain("--config=/dev/null");
  const { checkout, fixtures } = setup(); database(join(fixtures, "security/osv-db")); const pin = pins()["osv-scanner"]!;
  const args = pin.args.map((arg) => arg === "--config=/dev/null" ? `--config=${join(checkout, "osv-scanner.toml")}` : arg);
  expect((await runScanner("osv-scanner", { ...pin, args }, checkout, { fixturesDir: fixtures, spawn: async (spec) => ok(spec.args.includes("--version") ? "2.7.0" : '{"results":[]}') }))).toMatchObject({ status: "error", detail: "invalid offline osv configuration" });
});

it("refuses an in-gate OSV download flag", async () => {
  const { checkout, fixtures } = setup(); database(join(fixtures, "security/osv-db")); const pin = pins()["osv-scanner"]!;
  expect((await runScanner("osv-scanner", { ...pin, args: [...pin.args, "--download-offline-databases"] }, checkout, { fixturesDir: fixtures, spawn: async (spec) => ok(spec.args.includes("--version") ? "2.7.0" : '{"results":[]}') }))).toMatchObject({ status: "error", detail: "invalid offline osv configuration" });
});

it("installs and hashes vendored rules and a database; installed workers use fixture paths", async () => {
  const { root, checkout } = setup(); const db = join(root, "downloaded-db"); database(db);
  const store = new ChecksStore(join(root, "project")); const ledger = Ledger.open(join(root, "project"));
  const configured = pins(db); const semgrep = configured.semgrep!;
  const bin = join(root, "fake-semgrep");
  writeFileSync(bin, `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('1.182.0'); else {const fs=require('node:fs');const p=process.argv[process.argv.indexOf('--config')+1];if(!fs.existsSync(p+'/javascript.yml')||!p.includes('/checks/fixtures/'))process.exit(2);console.log('{"results":[],"errors":[],"paths":{"scanned":[]}}');}`, { mode: 0o700 });
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: { ...configured, semgrep: { ...semgrep, bin } } });
  const files = store.approve(ledger, "reviewed offline scanner fixtures"); expect(files.lockHash).toBeTruthy();
  for (const language of ["javascript", "python", "go"]) expect(readFileSync(join(store.checksDir, "fixtures/security/rules/semgrep", `${language}.yml`), "utf8")).toContain("rules:");
  expect(store.hashAll()).toHaveProperty("fixtures/security/osv-db/manifest.json");
  const result = await runSession({ bin: process.execPath, args: [join(store.checksDir, "fixtures/security/security/worker.ts"), "semgrep"], cwd: checkout, env: { JARVIS_FIXTURES: join(store.checksDir, "fixtures") }, timeoutMs: 5000 });
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).status).toBe("pass");
  writeFileSync(join(store.checksDir, "fixtures/security/rules/semgrep/javascript.yml"), "rules: []");
  expect(store.verify(ledger).ok).toBe(false);
});

it("rejects candidate rules and database symlinks", async () => {
  const { root, checkout, fixtures } = setup(); const rule = join(checkout, "rule.yml"); writeFileSync(rule, "rules: []"); const pin = pins().semgrep!;
  expect((await runScanner("semgrep", { ...pin, rulesFile: rule }, checkout, { spawn: async () => ok("1.182.0") })).status).toBe("error");
  const db = join(fixtures, "security/osv-db"); database(db); symlinkSync(join(db, "cache.zip"), join(db, "link.zip"));
  const store = new ChecksStore(join(root, "project"));
  expect(() => installSecurityChecks(store, { nodeBin: process.execPath, scanners: pins(db) })).toThrow(/symlink/i);
});

it("pins Semgrep to ignore candidate git and nested Semgrep ignore files", () => {
  expect(pins().semgrep!.args).toEqual(expect.arrayContaining(["--no-git-ignore", "--x-ignore-semgrepignore-files"]));
});

it("rejects unsupported certificate environment overrides", async () => {
  const { checkout } = setup(); const pin = pins().gitleaks!;
  await expect(runScanner("gitleaks", { ...pin, env: { SSL_CERT_FILE: "/candidate/cert.pem" } }, checkout, { spawn: async () => ok("8.28.0") })).rejects.toThrow("environment");
});

it("does not exempt a pinned OSV scan whose database is missing", async () => {
  const { evaluateSecurity } = await import("../../packages/cli/src/security/protected.ts");
  expect(evaluateSecurity([
    { tool: "gitleaks", status: "pass", findings: [] }, { tool: "semgrep", status: "pass", findings: [] },
    { tool: "osv-scanner", status: "not_run", findings: [], detail: "not run: osv database missing" },
  ], { complete: true, required: false }, { status: "not_run" }, { "osv-scanner": "unavailable tool" })).toBe("not_passed");
});

it("can check all pinned binary versions without an installed vulnerability database", async () => {
  const { checkout } = setup(); const configured = pins();
  const checks = await scannerDoctorChecks(configured, checkout, { spawn: async (spec) => ok(spec.bin.endsWith("osv-scanner") ? "osv-scanner version: 2.7.0\nosv-scalibr version: 0.5.3\n" : spec.bin.endsWith("semgrep") ? "1.182.0" : "8.28.0") });
  expect(checks.map((check) => check.level)).toEqual(["pass", "pass", "pass"]);
});
