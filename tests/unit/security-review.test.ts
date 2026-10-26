import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { hashOsvDatabase } from "../../packages/cli/src/security/osv-database.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import type { GateInput, GateResult } from "../../packages/cli/src/checks/gate.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { installSecurityChecks, runSecurityPass } from "../../packages/cli/src/security/protected.ts";
import { runScanner, type Scanner } from "../../packages/cli/src/security/scanners.ts";
import { detectTrifecta, scanTrifecta } from "../../packages/cli/src/security/trifecta.ts";
import { runHostileTrial } from "../../packages/cli/src/security/trial.ts";

const roots: string[] = [];
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "security-review-"))); roots.push(root);
  const checkout = join(root, "checkout"); const home = join(root, "home"); const fixtures = join(root, "fixtures");
  for (const p of [checkout, home, fixtures]) mkdirSync(p);
  const pin = { bin: join(root, "fake-scanner"), version: "1.2.3", args: pinnedSecurityScanners().gitleaks!.args };
  const spawn = async (s: { args: readonly string[] }) => ({ code: 0, stdout: s.args.some((a) => a === "version" || a === "--version") ? "1.2.3" : "[]", stderr: "", timedOut: false, overflowed: false, durationMs: 0 });
  return { root, checkout, home, fixtures, pin, spawn };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// gitleaks replaces its whole ruleset with <source>/.gitleaks.toml when no --config is given (live-checked on 8.28.0).
const suppression: [Scanner, string][] = [["gitleaks", ".gitleaksignore"], ["gitleaks", ".gitleaks.toml"], ["semgrep", ".semgrepignore"], ["osv-scanner", "osv-scanner.toml"], ["osv-scanner", ".osv-scanner.toml"]];
it.each(suppression.flatMap(([tool, file]) => ["file", "directory", "symlink"].map((kind) => ({ tool, file, kind }))))("refuses $tool suppression $file as $kind without deleting it", async ({ tool, file, kind }) => {
  const { checkout, home, pin, spawn } = setup(); const path = join(checkout, file);
  if (kind === "directory") mkdirSync(path);
  else if (kind === "symlink") symlinkSync("/missing-jarvis-canary", path);
  else writeFileSync(path, "candidate suppression");
  let starts = 0;
  expect(await runScanner(tool, pin, checkout, { homeDir: home, tmpDir: home, spawn: async (s) => {
    starts++; const r = await spawn(s);
    return tool !== "gitleaks" && !s.args.includes("--version") ? { ...r, stdout: '{"results":[],"errors":[],"paths":{"scanned":[]}}' } : r;
  } })).toMatchObject({ status: "error", detail: "suppression file present" });
  expect(starts).toBe(0);
  expect(lstatSync(path)).toBeDefined();
});

it("preserves gate HOME/TMPDIR and expands the protected OSV database environment in the worker", async () => {
  const { root, checkout, home, pin } = setup(); const store = new ChecksStore(root);
  const db = join(store.checksDir, "fixtures", "osv-db");
  writeFileSync(pin.bin, `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('1.2.3'); else { if(process.env.HOME!==${JSON.stringify(home)} || process.env.TMPDIR!==${JSON.stringify(home)} || process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY!==${JSON.stringify(db)}) process.exit(2); console.log('{"results":[]}'); }`, { mode: 0o700 });
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: { "osv-scanner": { ...pin, args: pinnedSecurityScanners()["osv-scanner"]!.args, env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: "$JARVIS_FIXTURES/osv-db" } } } });
  mkdirSync(db); writeFileSync(join(db, "dummy.json"), "{}");
  // The snapshot names the pinned (fake) scanner version that fetched it (backlog 96).
  writeFileSync(join(db, "manifest.json"), JSON.stringify({ schema: 1, scannerVersion: "1.2.3", fetchedAt: new Date().toISOString(), ecosystems: [], files: hashOsvDatabase(db) }));
  const r = await runSession({ bin: process.execPath, args: [join(store.checksDir, "fixtures/security/security/worker.ts"), "osv-scanner"], cwd: checkout, env: { HOME: home, TMPDIR: home, JARVIS_FIXTURES: join(store.checksDir, "fixtures") }, timeoutMs: 5000 });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "pass" });
});

it("uses a fresh home outside the checkout by default and forces semgrep nosem disabling", async () => {
  const { checkout, pin } = setup(); let env: Record<string, string> = {}; let args: readonly string[] = [];
  const r = await runScanner("semgrep", { ...pinnedSecurityScanners().semgrep!, bin: pin.bin, version: pin.version }, checkout, { spawn: async (s) => {
    env = s.env; args = s.args;
    return { code: 0, stdout: s.args.includes("--version") ? "1.2.3" : '{"results":[],"errors":[],"paths":{"scanned":[]}}', stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
  } });
  expect(r.status).toBe("pass");
  expect(env.HOME).not.toBe(checkout); expect(env.TMPDIR).not.toBe(checkout);
  expect(args).toContain("--disable-nosem");
});

it("rejects a candidate-owned OSV database and environment overrides of HOME", async () => {
  const { checkout, home, fixtures, pin, spawn } = setup();
  for (const env of [{ HOME: checkout }, { HOME: fixtures }, { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: checkout }]) {
    await expect(runScanner("osv-scanner", { ...pin, args: pinnedSecurityScanners()["osv-scanner"]!.args, env }, checkout, { homeDir: home, tmpDir: home, fixturesDir: fixtures, spawn })).rejects.toThrow("environment");
  }
});

it("rejects an exemption for a pinned tool at installation", () => {
  const { root, pin } = setup();
  expect(() => installSecurityChecks(new ChecksStore(root), { nodeBin: process.execPath, scanners: { gitleaks: pin }, exemptions: { gitleaks: "candidate has no code" } })).toThrow("pinned");
});

it.each([["not_run", "fail"], ["not_run", "pass"], ["pass", "fail"]] as const)("does not trust configured %s output when protected gate status is %s", async (status, gateStatus) => {
  const { root, checkout, pin } = setup(); const store = new ChecksStore(root); const ledger = Ledger.open(root);
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: { gitleaks: pin } }); store.approve(ledger, "approved");
  const evidenceDir = join(root, "evidence"); mkdirSync(join(evidenceDir, "cases/scan"), { recursive: true });
  writeFileSync(join(evidenceDir, "cases/scan/stdout"), JSON.stringify({ tool: "gitleaks", status, findings: [], detail: "not run: gitleaks missing" }));
  const gate = async (g: GateInput): Promise<GateResult> => ({ status: gateStatus, evidenceDir, entry: ledger.append({ kind: "gate_result", actor: "runner", data: { check: g.check.name } }) });
  const r = await runSecurityPass({ ledger, store, projectDir: root, jarvisHome: root, workRoot: root, repoPath: checkout, revision: "a".repeat(40), taskId: "T1", attemptId: "A1" }, { gate });
  expect(r.scanners[0]!.status).toBe("error");
});

it("uses and removes a private gitleaks report file instead of opening /dev/stdout", async () => {
  const { checkout, home, pin } = setup(); let report = "";
  const result = await runScanner("gitleaks", { ...pin, args: pin.args.map((arg) => arg === "--report-path=@report" ? "--report-path=/dev/stdout" : arg) }, checkout, { homeDir: home, tmpDir: home, spawn: async (s) => {
    if (s.args.includes("version")) return { code: 0, stdout: "1.2.3", stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
    report = s.args.find((a) => a.startsWith("--report-path="))!.slice("--report-path=".length);
    if (report === "/dev/stdout") throw Error("sandbox denies opening stdout");
    writeFileSync(report, "[]");
    return { code: 0, stdout: "", stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
  } });
  expect(result.status).toBe("pass"); expect(report.startsWith(home)).toBe(true);
  expect(() => lstatSync(report)).toThrow();
});
it("caps private report files and removes them on failure", async () => {
  const { checkout, home, pin } = setup(); let report = "";
  const result = await runScanner("gitleaks", { ...pin, args: pin.args }, checkout, { homeDir: home, tmpDir: home, spawn: async (s) => {
    if (s.args.includes("version")) return { code: 0, stdout: "1.2.3", stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
    report = s.args.find((a) => a.startsWith("--report-path="))!.slice("--report-path=".length);
    if (!report.startsWith(`${home}/`)) throw Error("report path is not private");
    writeFileSync(report, "[]" + " ".repeat(4 * 1024 * 1024));
    return { code: 0, stdout: "", stderr: "", timedOut: false, overflowed: false, durationMs: 0 };
  } });
  expect(result).toMatchObject({ status: "error", detail: "output limit" }); expect(() => lstatSync(report)).toThrow();
});

it("marks NUL-bearing files incomplete rather than silently clean", () => {
  const { checkout } = setup(); writeFileSync(join(checkout, "app.py"), "prefix\0openai request.form smtplib");
  expect(scanTrifecta(checkout)).toMatchObject({ required: true, complete: false });
});

it.each(["request.form", "request.args", "request.get_json()", "request.POST", "r.Body", "r.FormValue('q')"])("recognizes untrusted input %s", (input) => {
  expect(detectTrifecta([{ path: "app", text: `openai.call(${input}); sendMail(answer);` }]).required).toBe(true);
});
it("recognizes smtplib as an outbound capability", () => {
  expect(detectTrifecta([{ path: "app.py", text: "openai.call(user_input); smtplib.SMTP(host);" }]).required).toBe(true);
});

it.each([[], ["--redact=0"], ["--redact=20"]])("refuses gitleaks arguments without full redaction %j", async (...args) => {
  const { checkout, pin, spawn } = setup();
  expect(await runScanner("gitleaks", { ...pin, args: ["scan", ...args.flat() as string[], "."] }, checkout, { spawn })).toMatchObject({ status: "error", detail: "gitleaks requires full redaction" });
});
it("does not hash a secret into fingerprints or redacted metadata", async () => {
  const { checkout, pin } = setup(); const secret = "jarvis-dummy-private-canary";
  const r = await runScanner("gitleaks", pin, checkout, { spawn: async (s) => ({ code: 0, stdout: s.args.includes("version") ? "1.2.3" : JSON.stringify([{ RuleID: secret, File: secret, StartLine: 1, Secret: secret }]), stderr: "", timedOut: false, overflowed: false, durationMs: 0 }) });
  expect(r.status).toBe("fail");
  expect(JSON.stringify(r)).not.toContain(createHash("sha256").update(secret).digest("hex"));
});

it("rejects an exit-one empty gitleaks report", async () => {
  const { checkout, pin } = setup();
  writeFileSync(pin.bin, `#!${process.execPath}\nif(process.argv.includes('version')) console.log('1.2.3'); else { console.log('[]'); process.exit(1); }`, { mode: 0o700 });
  expect(await runScanner("gitleaks", pin, checkout)).toMatchObject({ status: "error", detail: "exit code" });
});

function trialCase() {
  let count = 0; let time = 0; let stopped = false; const delivered: string[] = []; const waits: number[] = [];
  return {
    input: { inputUrl: "http://127.0.0.1:3000/input", sinkUrl: "http://127.0.0.1:3001", benignInput: "safe", settleMs: 0 },
    deps: {
      spawn: async () => ({ stop: async () => { stopped = true; } }),
      resetSink: async () => { count = 0; }, observe: async () => ({ healthy: true, count }), drainSink: async () => {},
      now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; },
      http: async (_url: string, body?: string) => { delivered.push(body!); if (body === "safe") { time += 400; count++; } return { ok: true }; },
    }, delivered, waits, isStopped: () => stopped, addAction: () => { count++; },
  };
}
it("generates varied hostile content with a fresh per-run nonce", async () => {
  const bodies: string[] = [];
  for (const [nonce, variant] of [["nonce-one", 0], ["nonce-two", 1]] as const) {
    const c = trialCase(); expect((await runHostileTrial(c.input, { ...c.deps, nonce: () => nonce, variant: () => variant })).status).toBe("pass");
    expect(c.delivered[1]).toContain(nonce); bodies.push(c.delivered[1]!.replace(nonce, "nonce"));
  }
  expect(bodies[0]).not.toBe(bodies[1]);
});
it("settles for at least three control latencies with a floor and drains after stop", async () => {
  const c = trialCase(); let drained = false;
  const result = await runHostileTrial(c.input, { ...c.deps, drainSink: async () => { expect(c.isStopped()).toBe(true); drained = true; c.addAction(); } });
  expect(c.waits.filter((ms) => ms >= 1200).length).toBeGreaterThanOrEqual(2);
  expect(drained).toBe(true); expect(result).toMatchObject({ status: "fail", hostileActions: 1 });
});
it("never allows a caller to lower the settle floor", async () => {
  const c = trialCase();
  await runHostileTrial(c.input, { ...c.deps, http: async (_url, body) => { if (body === "safe") c.addAction(); return { ok: true }; } });
  expect(c.waits.every((ms) => ms >= 1000)).toBe(true);
});
it("still drains the sink if the post-stop settling wait fails", async () => {
  const c = trialCase(); let drained = false;
  const result = await runHostileTrial(c.input, { ...c.deps, wait: async (ms) => { if (c.isStopped()) throw Error("wait failed"); await c.deps.wait(ms); }, drainSink: async () => { drained = true; } });
  expect(result.status).toBe("error"); expect(drained).toBe(true);
});
it("uses a fresh unpredictable nonce when the runner supplies no nonce override", async () => {
  const bodies: string[] = [];
  for (let i = 0; i < 2; i++) {
    const c = trialCase(); expect((await runHostileTrial(c.input, { ...c.deps, variant: () => 0 })).status).toBe("pass"); bodies.push(c.delivered[1]!);
  }
  expect(bodies[0]).not.toBe(bodies[1]);
});
it("records history and dependency-directory scan coverage limits", () => {
  const skill = readFileSync(new URL("../../skills/security/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("does not scan Git history"); expect(skill).toContain("allowlists node_modules/");
  expect(skill).toContain("protected default rules without path allowlists"); // backlog 105
});
