import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as pins from "../../packages/cli/src/config/pins.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { fetchOsvDatabase } from "../../packages/cli/src/security/osv-db-fetch.ts";
import { runScanner, type ScannerPin } from "../../packages/cli/src/security/scanners.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "security-backlog-")); roots.push(root);
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  return { root, checkout };
}
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false, overflowed: false, durationMs: 0 });
function semgrepPin(): ScannerPin {
  const pin = pins.pinnedSecurityScanners().semgrep!;
  return { ...pin, args: [...pin.args.filter((arg) => arg !== "--max-target-bytes=0"), "--max-target-bytes=0"] };
}

it.each([undefined, "--max-target-bytes=1000000", "--max-target-bytes", "--max-target-bytes=0.0"])("rejects a Semgrep size limit of %s before spawning", async (flag) => {
  const { checkout } = setup(); const pin = semgrepPin(); let starts = 0;
  const args = pin.args.filter((arg) => arg !== "--max-target-bytes=0"); if (flag) args.push(flag);
  expect(await runScanner("semgrep", { ...pin, args }, checkout, { spawn: async (spec) => {
    starts++; return ok(spec.args.includes("--version") ? pin.version : '{"results":[],"errors":[]}');
  } })).toMatchObject({ status: "error", detail: "invalid offline semgrep configuration" });
  expect(starts).toBe(0);
});

it("passes the unlimited size flag to the Semgrep scan", async () => {
  const { checkout } = setup(); const pin = semgrepPin(); const calls: SessionSpec[] = [];
  expect(await runScanner("semgrep", pin, checkout, { spawn: async (spec) => {
    calls.push(spec); return ok(spec.args.includes("--version") ? pin.version : '{"results":[],"errors":[],"paths":{"scanned":["app.js"],"skipped":[]}}');
  } })).toMatchObject({ status: "pass" });
  expect(calls[1]!.args).toContain("--max-target-bytes=0");
});

it.each([
  { paths: { scanned: [], skipped: [{ path: "large.js", reason: "exceeded_size_limit" }] } },
  { paths: { scanned: [], skipped: ["large.js"] } },
  { skipped_targets: [{ path: "large.js", reason: "too large" }] },
  { paths: { skipped: null } },
  { skipped_targets: "large.js" },
  { errors: [{ type: "ParseError", message: "dummy-private-diagnostic" }] },
])("fails closed on Semgrep skipped targets or errors: %j", async (report) => {
  const { checkout } = setup(); const pin = semgrepPin();
  const result = await runScanner("semgrep", pin, checkout, { spawn: async (spec) => ok(spec.args.includes("--version") ? pin.version : JSON.stringify({ results: [], errors: [], ...report })) });
  expect(result).toEqual({ tool: "semgrep", status: "error", detail: "invalid output", findings: [] });
});

const gitleaksFlags = ["dir", ".", "--ignore-gitleaks-allow", "--gitleaks-ignore-path=/dev/null", "--redact=100", "--report-format=json", "--report-path=@report"];
it.each(gitleaksFlags)("refuses gitleaks without required option %s before spawning", async (flag) => {
  const { checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!; let starts = 0;
  expect((await runScanner("gitleaks", { ...pin, args: pin.args.filter((arg) => arg !== flag) }, checkout, { spawn: async (spec) => {
    starts++; return ok(spec.args.includes("version") ? pin.version : "[]");
  } })).status).toBe("error");
  expect(starts).toBe(0);
});

it.each([
  ["--config", "candidate.toml"], ["--config=./candidate.toml"],
  ["--report-path=./candidate.json"], ["--report-path", "./candidate.json"],
  ["--gitleaks-ignore-path=./ignore"], ["--enable-rule=missing"], ["--max-target-megabytes=1"],
  ["--report-format=sarif"], ["--ignore-gitleaks-allow=false"], ["--exit-code=0"],
  ["--platform=github"], ["--source=https://example.invalid"], ["--unknown-option"], ["../sibling"],
  ["--report-path=/dev/stdout"], ["--config", "/dev/null", "--config", "/dev/null"],
].map((extra) => ({ extra })))("refuses unreviewed gitleaks arguments $extra", async ({ extra }) => {
  const { checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!; let starts = 0;
  expect(await runScanner("gitleaks", { ...pin, args: [...pin.args, ...extra] }, checkout, { spawn: async (spec) => {
    starts++; return ok(spec.args.includes("version") ? pin.version : "[]");
  } })).toMatchObject({ status: "error", detail: "invalid offline gitleaks configuration" });
  expect(starts).toBe(0);
});

it.each(["file", "symlink"])("refuses candidate gitleaks config through %s", async (kind) => {
  const { symlinkSync } = await import("node:fs");
  const { root, checkout } = setup(); const rule = join(checkout, "rules.toml"); writeFileSync(rule, "rules = []");
  const path = kind === "file" ? rule : join(root, "linked.toml"); if (kind === "symlink") symlinkSync(rule, path);
  const pin = pins.pinnedSecurityScanners().gitleaks!;
  expect(await runScanner("gitleaks", { ...pin, args: [...pin.args, "--config", path] }, checkout, { spawn: async (spec) => ok(spec.args.includes("version") ? pin.version : "[]") })).toMatchObject({ status: "error", detail: "invalid offline gitleaks configuration" });
});

it.each(["--report-path=@report", "--report-path=/dev/stdout"])("accepts reviewed gitleaks arguments and redirects %s to a private report", async (reportFlag) => {
  const { checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!; let report = "";
  const args = pin.args.map((arg) => arg.startsWith("--report-path=") ? reportFlag : arg);
  expect(await runScanner("gitleaks", { ...pin, args }, checkout, { spawn: async (spec) => {
    if (spec.args.includes("version")) return ok(pin.version);
    report = spec.args.find((arg) => arg.startsWith("--report-path="))!.slice("--report-path=".length);
    expect(report).not.toBe("/dev/stdout"); writeFileSync(report, "[]"); return ok("");
  } })).toMatchObject({ status: "pass" });
  expect(report).toMatch(/gitleaks-report-.*\/report\.json$/);
});

it("uses a separate version timeout before applying the short fault timeout", async () => {
  const { root, checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!;
  const bin = join(root, "fake-scanner");
  writeFileSync(bin, `#!${process.execPath}\nif(process.argv.includes('version')) setTimeout(() => console.log('${pin.version}'), 400); else setTimeout(() => {}, 60000);`, { mode: 0o700 });
  const calls: SessionSpec[] = [];
  expect(await runScanner("gitleaks", { ...pin, bin }, checkout, { timeoutMs: 250, versionTimeoutMs: 10_000, spawn: async (spec) => {
    calls.push(spec); return runSession(spec);
  } })).toMatchObject({ status: "error", detail: "timeout" });
  expect(calls.map((spec) => spec.timeoutMs)).toEqual([10_000, 250]);
});

it("fetches with the configured OSV binary and records its configured version", async () => {
  const { root, checkout } = setup(); writeFileSync(join(checkout, "package.json"), "{}");
  const configured = pins.pinnedSecurityScanners(); const bin = join(root, "fake-osv");
  vi.spyOn(pins, "pinnedSecurityScanners").mockReturnValue({ ...configured, "osv-scanner": { ...configured["osv-scanner"]!, bin, version: "2.8.1" } });
  const calls: SessionSpec[] = [];
  const manifest = await fetchOsvDatabase({ projectDir: checkout, outputDir: join(root, "db") }, { spawn: async (spec) => {
    calls.push(spec);
    if (spec.args.includes("--version")) return ok("osv-scanner version: 2.8.1\nosv-scalibr version: 0.5.3\n");
    writeFileSync(join(spec.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY!, "cache.zip"), "fake database"); return ok("");
  } });
  expect(calls.map((spec) => spec.bin)).toEqual([bin, bin]);
  expect(manifest.scannerVersion).toBe("2.8.1");
});

it("rejects an OSV fetch version that disagrees with the shared pin", async () => {
  const { root, checkout } = setup(); writeFileSync(join(checkout, "package.json"), "{}");
  const configured = pins.pinnedSecurityScanners();
  vi.spyOn(pins, "pinnedSecurityScanners").mockReturnValue({ ...configured, "osv-scanner": { ...configured["osv-scanner"]!, version: "2.8.1" } });
  let starts = 0;
  await expect(fetchOsvDatabase({ projectDir: checkout, outputDir: join(root, "db") }, { spawn: async () => { starts++; return ok("osv-scanner version: 2.7.0"); } })).rejects.toThrow("version mismatch");
  expect(starts).toBe(1);
});

it("accepts full split redaction and a protected gitleaks rules file", async () => {
  const { root, checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!;
  const rules = join(root, "rules.toml"); writeFileSync(rules, "rules = []");
  const args = pin.args.flatMap((arg) => arg === "--redact=100" ? ["--redact", "100"] : [arg]);
  expect(await runScanner("gitleaks", { ...pin, args: [...args, "--config", "@rules"], rulesFile: rules }, checkout, { spawn: async (spec) => {
    if (!spec.args.includes("version")) expect(spec.args[spec.args.indexOf("--config") + 1]).toBe(rules);
    return ok(spec.args.includes("version") ? pin.version : "[]");
  } })).toMatchObject({ status: "pass" });
});

it("refuses a worker gitleaks rules path outside protected fixtures", async () => {
  const { root, checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!;
  const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
  const rules = join(root, "rules.toml"); writeFileSync(rules, "rules = []"); let starts = 0;
  expect(await runScanner("gitleaks", { ...pin, args: [...pin.args, "--config", rules], rulesFile: "gitleaks" }, checkout, { fixturesDir: fixtures, spawn: async (spec) => {
    starts++; return ok(spec.args.includes("version") ? pin.version : "[]");
  } })).toMatchObject({ status: "error", detail: "invalid offline gitleaks configuration" });
  expect(starts).toBe(0);
});

it("accepts a worker gitleaks config only from its protected fixture copy", async () => {
  const { root, checkout } = setup(); const pin = pins.pinnedSecurityScanners().gitleaks!;
  const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
  const rules = join(fixtures, "rules.toml"); writeFileSync(rules, "rules = []");
  expect(await runScanner("gitleaks", { ...pin, args: [...pin.args, "--config", rules], rulesFile: "gitleaks" }, checkout, { fixturesDir: fixtures, spawn: async (spec) => ok(spec.args.includes("version") ? pin.version : "[]") })).toMatchObject({ status: "pass" });
});

it("refuses to fetch when no OSV pin is configured", async () => {
  const { root, checkout } = setup(); writeFileSync(join(checkout, "package.json"), "{}");
  vi.spyOn(pins, "pinnedSecurityScanners").mockReturnValue({}); let starts = 0;
  await expect(fetchOsvDatabase({ projectDir: checkout, outputDir: join(root, "db") }, { spawn: async (spec) => {
    starts++; if (spec.args.includes("--version")) return ok("osv-scanner version: 2.7.0");
    writeFileSync(join(spec.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY!, "cache.zip"), "fake database"); return ok("");
  } })).rejects.toThrow("OSV scanner pin missing");
  expect(starts).toBe(0);
});
