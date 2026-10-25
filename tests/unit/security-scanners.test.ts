import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";

const dirs: string[] = [];
function fake(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "security-scanner-"));
  dirs.push(dir);
  const bin = join(dir, "scanner");
  writeFileSync(bin, `#!${process.execPath}\nif (process.argv.includes('--version') || process.argv.includes('version')) console.log('8.28.0'); else { ${body} }`, { mode: 0o700 });
  return { dir, pin: { bin, version: "8.28.0", args: ["scan", "--redact=100", "."] } };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("scanner adapters", () => {
  it("runs absolute pinned fake scanners with a clean environment", async () => {
    const { runScanner } = await import("../../packages/cli/src/security/scanners.ts");
    const { dir, pin } = fake("console.log(JSON.stringify([]));");
    const result = await runScanner("gitleaks", pin, dir);
    expect(result).toEqual({ tool: "gitleaks", status: "pass", findings: [] });
    await expect(runScanner("gitleaks", { ...pin, bin: "gitleaks" }, dir)).rejects.toThrow("absolute");
    let spec: unknown;
    const home = mkdtempSync(join(tmpdir(), "security-runtime-")); dirs.push(home);
    await runScanner("gitleaks", pin, dir, { homeDir: home, tmpDir: home, spawn: async (s) => {
      spec = s;
      return { code: 0, stdout: s.args.includes("version") ? "8.28.0" : "[]", stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
    } });
    expect(spec).toMatchObject({ bin: pin.bin, cwd: dir, maxOutputBytes: 4 * 1024 * 1024 });
    expect((spec as { env: unknown }).env).toEqual({ PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "C", CI: "1", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" });
  });

  it("fingerprints secrets before ledger, report or notification serialization", async () => {
    const { runScanner } = await import("../../packages/cli/src/security/scanners.ts");
    const planted = "jarvis-dummy-canary-no-credential";
    const raw = [{ RuleID: `rule-${planted}`, File: `${planted}.env`, StartLine: 2, Secret: planted, Match: `token=${planted}`, Description: planted }];
    const { dir, pin } = fake(`console.log(${JSON.stringify(JSON.stringify(raw))}); process.exit(1);`);
    const result = await runScanner("gitleaks", pin, dir);
    expect(result.status).toBe("fail");
    expect(result.findings[0]).toMatchObject({ tool: "gitleaks", line: 2, severity: "high", message: "Potential secret", fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(JSON.stringify(result)).not.toContain(planted);
    const ledger = Ledger.open(join(dir, "ledger"));
    ledger.append({ actor: "runner", kind: "gate_result", data: result });
    expect(readFileSync(join(ledger.dir, "ledger.jsonl"), "utf8")).not.toContain(planted);
  });

  it("parses semgrep and osv JSON without source snippets", async () => {
    const { parseFindings } = await import("../../packages/cli/src/security/scanners.ts");
    expect(parseFindings("semgrep", JSON.stringify({ results: [{ check_id: "injection", path: "app.ts", start: { line: 4 }, extra: { severity: "ERROR", message: "unsafe", lines: "private" } }], errors: [] }))[0]).toMatchObject({ rule: "injection", file: "app.ts", line: 4, severity: "high" });
    const osv = { results: [{ source: { path: "package-lock.json", type: "lockfile" }, packages: [{ package: { name: "dummy", version: "1" }, vulnerabilities: [{ id: "OSV-DUMMY", summary: "private", database_specific: { severity: "HIGH" } }] }] }] };
    expect(parseFindings("osv-scanner", JSON.stringify(osv))[0]).toMatchObject({ rule: "OSV-DUMMY", file: "package-lock.json", severity: "high" });
    expect(JSON.stringify(parseFindings("osv-scanner", JSON.stringify(osv)))).not.toContain("private");
  });

  it.each(["not-json", "{}", "null", '[{}]', '{"results":[],"errors":[{"message":"failed"}]}'])("rejects malformed or incomplete output %s", async (raw) => {
    const { parseFindings } = await import("../../packages/cli/src/security/scanners.ts");
    expect(() => parseFindings("semgrep", raw)).toThrow("Invalid scanner output");
  });

  it.each([
    ["gitleaks", '[{}]'],
    ["osv-scanner", '{"results":[{}]}'],
    ["semgrep", '{"results":[{}],"errors":[]}'],
    ["osv-scanner", '{"results":[],"errors":["unreadable lockfile"]}'],
  ])("does not turn incomplete %s findings into a clean scan", async (tool, raw) => {
    const { parseFindings } = await import("../../packages/cli/src/security/scanners.ts");
    expect(() => parseFindings(tool as "gitleaks", raw!)).toThrow("Invalid scanner output");
  });

  it("treats missing tools and exact version mismatches as not run, never pass", async () => {
    const { runScanner, scannerDoctorChecks } = await import("../../packages/cli/src/security/scanners.ts");
    const { dir, pin } = fake("console.log('[]');");
    for (const p of [{ ...pin, bin: join(dir, "absent") }, { ...pin, version: "8.28" }]) {
      expect(await runScanner("gitleaks", p, dir)).toMatchObject({ status: "not_run", detail: "not run: gitleaks missing" });
    }
    const checks = await scannerDoctorChecks({ gitleaks: pin, semgrep: { ...pin, bin: join(dir, "absent") }, "osv-scanner": { ...pin, version: "wrong" } }, dir);
    expect(checks.map((c) => c.level)).toEqual(["pass", "fail", "fail"]);
    expect(checks[0]!.detail).toContain("8.28.0");
    expect(checks[2]!.detail).toContain("found 8.28.0");
  });

  it("fails on capped output or a process exception without exposing diagnostic text", async () => {
    const { runScanner } = await import("../../packages/cli/src/security/scanners.ts");
    const { dir, pin } = fake("console.log('[]');");
    for (const failure of ["overflow", "exception"]) {
      const result = await runScanner("gitleaks", pin, dir, { spawn: async (s) => {
        if (s.args.includes("version")) return { code: 0, stdout: "8.28.0", stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
        if (failure === "exception") throw Error("dummy-sensitive-diagnostic");
        return { code: 0, stdout: "[]", stderr: "dummy-sensitive-diagnostic", timedOut: false, overflowed: true, durationMs: 0 };
      } });
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("dummy-sensitive-diagnostic");
    }
  });

  it.each(["8.28.0.1", "8.28.0+patched"])("does not accept a version prefix in %s as the exact pin", async (reported) => {
    const { runScanner } = await import("../../packages/cli/src/security/scanners.ts");
    const { dir, pin } = fake("console.log('[]');");
    const result = await runScanner("gitleaks", pin, dir, { spawn: async (s) => ({ code: 0, stdout: s.args.includes("version") ? reported : "[]", stderr: "", timedOut: false, overflowed: false, durationMs: 0 }) });
    expect(result.status).toBe("not_run");
  });

  // The timeout covers the version probe too, so it must leave room for a node start under a loaded
  // machine: at 250 ms the probe itself timed out ("not run: gitleaks missing") during a full suite.
  it.each([
    ["console.log('bad-json');", "invalid output", 10_000],
    ["process.exit(2);", "exit code", 10_000],
    ["setTimeout(() => {}, 60000);", "timeout", 5_000],
    ["console.log('[]'); process.exit(2);", "exit code", 10_000],
  ])("fails closed on scanner fault %s", async (body, detail, timeoutMs) => {
    const { runScanner } = await import("../../packages/cli/src/security/scanners.ts");
    const { dir, pin } = fake(body);
    expect(await runScanner("gitleaks", pin, dir, { timeoutMs })).toMatchObject({ status: "error", detail });
  });
});
