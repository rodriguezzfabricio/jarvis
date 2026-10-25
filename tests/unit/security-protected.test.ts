import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { hashOsvDatabase } from "../../packages/cli/src/security/osv-database.ts";
import type { Scanner, ScannerPins } from "../../packages/cli/src/security/scanners.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import type { GateInput, GateResult } from "../../packages/cli/src/checks/gate.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "security-protected-")); dirs.push(root);
  const ledger = Ledger.open(root); const store = new ChecksStore(root);
  return { root, ledger, store, input: { ledger, store, projectDir: root, jarvisHome: root, workRoot: join(root, "work"), repoPath: join(root, "candidate"), revision: "a".repeat(40), taskId: "T1", attemptId: "A1" } };
}

it("installs hash-protected driver, verifier and offline rules before approval", async () => {
  const { installSecurityChecks } = await import("../../packages/cli/src/security/protected.ts");
  const { root, ledger, store } = setup();
  const rules = join(root, "rules"); writeFileSync(rules, "rules = []");
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: { gitleaks: { bin: "/fake/gitleaks", version: "8.28.0", args: ["dir", "--redact=100", "--config", "@rules", "."], rulesFile: rules } } });
  expect(store.verify(ledger).ok).toBe(false);
  store.approve(ledger, "security plan from spec");
  expect(store.verify(ledger).ok).toBe(true);
  const files = store.hashAll();
  expect(Object.keys(files)).toContain("security/plan.json");
  expect(Object.keys(files)).toContain("fixtures/security/security/worker.ts");
  expect(Object.keys(files)).toContain("fixtures/security/proc/session.ts");
  expect(Object.keys(files)).toContain("security/verify.ts");
  expect(Object.keys(files)).toContain("fixtures/security/rules/gitleaks");
  expect(() => installSecurityChecks(store, { nodeBin: process.execPath, scanners: {} })).toThrow("already installed");
});

it("uses runGate for every scanner and detector; an unconfigured scanner stays not run", async () => {
  const { installSecurityChecks, runSecurityPass } = await import("../../packages/cli/src/security/protected.ts");
  const { ledger, store, input } = setup();
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: {} }); store.approve(ledger, "approved");
  const calls: GateInput[] = [];
  const gate = async (g: GateInput): Promise<GateResult> => {
    calls.push(g);
    return { status: g.check.name === "security-trifecta" ? "pass" : "fail", entry: ledger.append({ kind: "gate_result", actor: "runner", data: { check: g.check.name } }), evidenceDir: "unused" };
  };
  const result = await runSecurityPass(input, { gate });
  expect(result.status).toBe("not_passed");
  expect(result.scanners.map((s) => s.detail)).toEqual(["not run: gitleaks missing", "not run: semgrep missing", "not run: osv-scanner missing"]);
  expect(calls.map((g) => g.check.name)).toEqual(["security-gitleaks", "security-semgrep", "security-osv-scanner", "security-trifecta"]);
  for (const g of calls) { expect(g.revision).toBe(input.revision); expect(g.check.verify).toContain("$JARVIS_CHECKS"); expect(g.check.cases[0]!.command).toContain("$JARVIS_FIXTURES"); }
});

it("refuses tampered definitions before dispatch and cannot pass without a required trial", async () => {
  const { installSecurityChecks, runSecurityPass } = await import("../../packages/cli/src/security/protected.ts");
  const { ledger, store, input } = setup();
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: {} }); store.approve(ledger, "approved");
  const gate = vi.fn(async (g: GateInput) => ({ status: "pass" as const, entry: ledger.append({ kind: "gate_result", actor: "runner", data: { check: g.check.name } }), evidenceDir: "unused" }));
  const result = await runSecurityPass(input, { gate });
  expect(result.status).toBe("not_passed");
  expect(result.trial.status).toBe("not_run");
  const planFile = join(store.checksDir, "security", "plan.json");
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Record<string, unknown>;
  writeFileSync(planFile, JSON.stringify({ ...plan, nodeBin: "/fake/tampered-node" }));
  gate.mockClear();
  expect((await runSecurityPass(input, { gate })).status).toBe("tampered");
  expect(gate).not.toHaveBeenCalled();
});

it("only accepts explicit routing exemptions for missing scans; fails and unknown observations remain closed", async () => {
  const { evaluateSecurity } = await import("../../packages/cli/src/security/protected.ts");
  const missing = ["gitleaks", "semgrep", "osv-scanner"].map((tool) => ({ tool, status: "not_run", findings: [] }));
  expect(evaluateSecurity(missing as never, { complete: true, required: false }, { status: "not_run" }, {})).toBe("not_passed");
  const exemptions = { gitleaks: "routing: non-code task", semgrep: "routing: non-code task", "osv-scanner": "routing: non-code task" };
  expect(evaluateSecurity(missing as never, { complete: true, required: false }, { status: "not_run" }, exemptions)).toBe("pass");
  expect(evaluateSecurity([{ tool: "gitleaks", status: "fail", findings: [] }] as never, { complete: true, required: false }, { status: "not_run" }, exemptions)).toBe("not_passed");
  expect(evaluateSecurity(missing as never, { complete: false, required: false }, { status: "not_run" }, exemptions)).toBe("not_passed");
  expect(evaluateSecurity(missing as never, { complete: true, required: true }, { status: "not_run" }, exemptions)).toBe("not_passed");
  const contradictory = ["gitleaks", "semgrep", "osv-scanner"].map((tool) => ({ tool, status: "pass", findings: [{ tool }] }));
  expect(evaluateSecurity(contradictory as never, { complete: true, required: false }, { status: "not_run" })).toBe("not_passed");
});

it("provides a read-only reviewer skill and realistic security evals", async () => {
  const path = new URL("../../skills/security/", import.meta.url);
  const skill = readFileSync(new URL("SKILL.md", path), "utf8");
  expect(skill).toContain("read-only");
  expect(skill).toContain("Do not change source, checks, scanner rules, ignore lists or evidence.");
  expect(skill).toContain("OWASP Top 10:2025");
  expect(skill).toContain("hostile-content trial");
  expect(JSON.parse(readFileSync(new URL("evals/evals.json", path), "utf8")).evals.length).toBeGreaterThanOrEqual(3);
});

it("captures only sanitized scanner output through the installed worker", async () => {
  const { installSecurityChecks } = await import("../../packages/cli/src/security/protected.ts");
  const { root, ledger, store } = setup();
  const dummy = "jarvis-canary-never-a-real-secret";
  const bin = join(root, "fake-scanner");
  const raw = JSON.stringify([{ RuleID: "dummy", File: "app.ts", StartLine: 1, Secret: dummy, Match: dummy }]);
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(process.argv.includes('version') ? '8.28.0' : ${JSON.stringify(raw)});`, { mode: 0o700 });
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: { gitleaks: { bin, version: "8.28.0", args: pinnedSecurityScanners().gitleaks!.args } } });
  store.approve(ledger, "approved scanner");
  const observed = await runSession({ bin: process.execPath, args: [join(store.checksDir, "fixtures/security/security/worker.ts"), "gitleaks"], cwd: root, env: { JARVIS_FIXTURES: join(store.checksDir, "fixtures") }, timeoutMs: 5000 });
  expect(observed.code).toBe(0);
  expect(observed.stderr).toBe("");
  expect(observed.stdout).not.toContain(dummy);
  expect(JSON.parse(observed.stdout)).toMatchObject({ tool: "gitleaks", status: "fail", findings: [expect.objectContaining({ fingerprint: expect.stringMatching(/^sha256:/) })] });
});

it("executes installed fake scanner drivers and the separate verifier; detected risk blocks without a trial", async () => {
  const { installSecurityChecks, runSecurityPass } = await import("../../packages/cli/src/security/protected.ts");
  const { root, ledger, store, input } = setup();
  mkdirSync(input.repoPath);
  const outputs = { gitleaks: [], semgrep: { results: [], errors: [] }, "osv-scanner": { results: [] } };
  const pins: ScannerPins = {};
  const defaults = pinnedSecurityScanners();
  defaults.semgrep = { ...defaults.semgrep!, args: [...defaults.semgrep!.args.filter((arg) => arg !== "--max-target-bytes=0"), "--max-target-bytes=0"] };
  for (const [tool, output] of Object.entries(outputs)) {
    const bin = join(root, tool);
    writeFileSync(bin, `#!${process.execPath}\nconsole.log(process.argv.includes('version') || process.argv.includes('--version') ? '1.2.3' : ${JSON.stringify(JSON.stringify(output))});`, { mode: 0o700 });
    pins[tool as Scanner] = { ...defaults[tool as Scanner]!, bin, version: "1.2.3" };
  }
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: pins });
  const db = join(store.checksDir, "fixtures/security/osv-db"); mkdirSync(db); writeFileSync(join(db, "cache.zip"), "fake database");
  writeFileSync(join(db, "manifest.json"), JSON.stringify({ schema: 1, scannerVersion: "2.7.0", ecosystems: [], files: hashOsvDatabase(db) }));
  store.approve(ledger, "approved");
  let runs = 0;
  const gate = async (g: GateInput): Promise<GateResult> => {
    const evidenceDir = join(root, `evidence-${runs++}`); const scan = join(evidenceDir, "cases", "scan"); mkdirSync(scan, { recursive: true });
    const obs = await runSession({ bin: "/bin/sh", args: ["-c", g.check.cases[0]!.command], cwd: input.repoPath, env: { JARVIS_FIXTURES: join(store.checksDir, "fixtures") }, stdoutPath: join(scan, "stdout"), stderrPath: join(scan, "stderr"), timeoutMs: 5000 });
    writeFileSync(join(scan, "code"), String(obs.code));
    const completion = join(evidenceDir, "completion"); writeFileSync(completion, "nonce");
    const ver = await runSession({ bin: "/bin/sh", args: ["-c", g.check.verify], cwd: root, env: { JARVIS_CHECKS: store.checksDir, JARVIS_OUT: join(evidenceDir, "cases"), JARVIS_COMPLETION_FILE: completion }, timeoutMs: 5000 });
    const status = ver.code === 0 && ver.stdout.trim() === "JARVIS-CHECK-COMPLETE nonce" ? "pass" : "fail";
    return { status, evidenceDir, entry: ledger.append({ kind: "gate_result", actor: "runner", data: { status, revision: g.revision } }) };
  };
  expect((await runSecurityPass(input, { gate })).status).toBe("pass");
  writeFileSync(join(input.repoPath, "app.ts"), "openai.responses.create(req.body); sendMail(answer);");
  const risky = await runSecurityPass(input, { gate });
  expect(risky).toMatchObject({ status: "not_passed", trifecta: { required: true }, trial: { status: "not_run" } });
});

it.each([
  ["gitleaks", { tool: "gitleaks", status: "fail", findings: [{}] }, "0"],
  ["gitleaks", { tool: "gitleaks", status: "not_run", findings: [] }, "0"],
  ["semgrep", { tool: "semgrep", status: "pass", findings: [{}] }, "0"],
  ["gitleaks", { tool: "gitleaks", status: "pass", findings: [] }, "2"],
  ["trifecta", { complete: false, required: false, signals: [] }, "0"],
])("the independent verifier refuses %s incomplete or failing evidence %j (exit %s)", async (tool, result, code) => {
  const { installSecurityChecks } = await import("../../packages/cli/src/security/protected.ts");
  const { root, store } = setup(); installSecurityChecks(store, { nodeBin: process.execPath, scanners: {} });
  const scan = join(root, "observations", "scan"); mkdirSync(scan, { recursive: true });
  writeFileSync(join(scan, "stdout"), JSON.stringify(result)); writeFileSync(join(scan, "code"), code);
  const completion = join(root, "completion"); writeFileSync(completion, "nonce");
  const ver = await runSession({ bin: process.execPath, args: [join(store.checksDir, "security/verify.ts"), tool], cwd: root, env: { JARVIS_OUT: join(root, "observations"), JARVIS_COMPLETION_FILE: completion }, timeoutMs: 5000 });
  expect(ver.code).toBe(1);
  expect(ver.stdout).toBe("");
});
