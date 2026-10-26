import { cpSync, copyFileSync, lstatSync, readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate, type GateCheck, type GateInput, type GateResult } from "../checks/gate.ts";
import type { ChecksStore } from "../checks/store.ts";
import { withGitleaksConfig } from "./gitleaks-config.ts";
import { hashOsvDatabase, osvDatabaseReady } from "./osv-database.ts";
import { SCANNERS, scannerNotRun, type Scanner, type ScannerPins, type ScanResult } from "./scanners.ts";
import type { TrifectaResult } from "./trifecta.ts";
import type { TrialResult } from "./trial.ts";

export interface SecurityPlan {
  nodeBin: string;
  scanners: ScannerPins;
  /** Explicit routing decisions, not availability-based fallbacks. Only unavailable scans may be exempt. */
  exemptions?: Partial<Record<Scanner, string>>;
  /** Approved black-box driver plus a separate verifier, using trial.ts in the fixtures. */
  trial?: GateCheck;
}
export type SecurityInput = Omit<GateInput, "check" | "extraEnv">;
export interface SecurityResult {
  status: "pass" | "not_passed" | "tampered";
  scanners: ScanResult[];
  trifecta: TrifectaResult;
  trial: TrialResult;
  gates: GateResult[];
}
const incomplete = (): TrifectaResult => ({ required: true, complete: false, signals: [] });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Install once, then have the runner approve the store. Never auto-approve or overwrite a plan. */
export function installSecurityChecks(store: ChecksStore, plan: SecurityPlan): void {
  const planPath = join(store.checksDir, "security", "plan.json");
  if (existsSync(planPath)) throw new Error("Security checks already installed; changes need review");
  if (!isAbsolute(plan.nodeBin)) throw new Error("Node binary must be absolute");
  for (const tool of SCANNERS) if (plan.scanners[tool] && plan.exemptions?.[tool] !== undefined) throw Error("Cannot exempt a pinned scanner");
  const fixture = join(store.checksDir, "fixtures", "security");
  for (const dir of [join(fixture, "security"), join(fixture, "proc"), join(fixture, "rules"), join(store.checksDir, "security")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sources = ["scanners.ts", "runtime.ts", "offline.ts", "coverage.ts", "mapped.ts", "gitleaks-config.ts", "osv-database.ts", "trifecta.ts", "trial.ts", "worker.ts"];
  for (const file of sources) copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(fixture, "security", file));
  copyFileSync(fileURLToPath(new URL("../proc/session.ts", import.meta.url)), join(fixture, "proc", "session.ts"));
  copyFileSync(fileURLToPath(new URL("verify.ts", import.meta.url)), join(store.checksDir, "security", "verify.ts"));
  const pins: ScannerPins = {};
  for (const tool of SCANNERS) {
    const configured = plan.scanners[tool];
    if (!configured) continue;
    const pin = tool === "gitleaks" ? withGitleaksConfig(configured) : configured;
    if (!isAbsolute(pin.bin)) throw new Error("Scanner binary must be absolute");
    if (pin.rulesFile) copyRules(pin.rulesFile, join(fixture, "rules", tool));
    if (pin.databaseDir) {
      hashOsvDatabase(pin.databaseDir);
      if (tool !== "osv-scanner" || !osvDatabaseReady(pin.databaseDir, [], pin.version)) throw Error("Invalid OSV database");
      cpSync(pin.databaseDir, join(fixture, "osv-db"), { recursive: true, errorOnExist: true, force: false });
    }
    pins[tool] = { bin: pin.bin, version: pin.version, args: [...pin.args], ...(pin.rulesFile ? { rulesFile: tool } : {}), ...(pin.env ? { env: { ...pin.env } } : {}) };
  }
  writeFileSync(join(fixture, "config.json"), JSON.stringify(pins), { mode: 0o600 });
  writeFileSync(planPath, JSON.stringify({ ...plan, scanners: pins }), { mode: 0o600 });
}

function scannerCheck(node: string, tool: Scanner | "trifecta"): GateCheck {
  return {
    name: `security-${tool}`, timeoutMs: 150_000,
    cases: [{ id: "scan", command: `${quote(node)} "$JARVIS_FIXTURES/security/security/worker.ts" ${quote(tool)}` }],
    verify: `${quote(node)} "$JARVIS_CHECKS/security/verify.ts" ${quote(tool)}`,
  };
}

function observation(gate: GateResult): unknown {
  if (gate.status !== "pass" && gate.status !== "fail") return undefined;
  try { return JSON.parse(readFileSync(join(gate.evidenceDir, "cases", "scan", "stdout"), "utf8")) as unknown; }
  catch { return undefined; }
}

function scanObservation(tool: Scanner, gate: GateResult, configured: boolean): ScanResult {
  const raw = observation(gate) as ScanResult | undefined;
  if (configured && raw?.status === "not_run") return { tool, status: "error", findings: [], detail: "pinned scanner unavailable" };
  if (raw?.tool === tool && Array.isArray(raw.findings) && ["pass", "fail", "not_run", "error"].includes(raw.status)) {
    if (raw.status !== "pass" || gate.status === "pass") return raw;
  }
  // An absent definition is also unavailable. Infrastructure failures are never exempted.
  if (!configured && gate.status === "fail") return scannerNotRun(tool);
  return { tool, status: "error", findings: [], detail: "protected check failed" };
}

export function evaluateSecurity(scans: readonly ScanResult[], trifecta: Pick<TrifectaResult, "complete" | "required">, trial: TrialResult, exemptions: Partial<Record<Scanner, string>> = {}): "pass" | "not_passed" {
  const scannersPass = scans.length === SCANNERS.length && SCANNERS.every((tool) => {
    const result = scans.find((s) => s.tool === tool);
    return result?.findings.length === 0 && (result.status === "pass" || (result.status === "not_run" && result.detail !== "not run: osv database missing" && Boolean(exemptions[tool]?.trim())));
  });
  return scannersPass && trifecta.complete && (!trifecta.required || trial.status === "pass") ? "pass" : "not_passed";
}

/** All execution delegates to runGate: it owns checkout verification, isolation, capture and ledger. */
export async function runSecurityPass(input: SecurityInput, deps: { gate?: (g: GateInput) => Promise<GateResult> } = {}): Promise<SecurityResult> {
  if (!input.store.verify(input.ledger).ok) return { status: "tampered", scanners: [], trifecta: incomplete(), trial: { status: "not_run" }, gates: [] };
  const plan = JSON.parse(readFileSync(join(input.store.checksDir, "security", "plan.json"), "utf8")) as SecurityPlan;
  const gate = deps.gate ?? runGate;
  const gates: GateResult[] = []; const scanners: ScanResult[] = [];
  for (const tool of SCANNERS) {
    const result = await gate({ ...input, extraEnv: {}, check: scannerCheck(plan.nodeBin, tool) });
    gates.push(result); scanners.push(scanObservation(tool, result, plan.scanners[tool] !== undefined));
  }
  const detected = await gate({ ...input, extraEnv: {}, check: scannerCheck(plan.nodeBin, "trifecta") }); gates.push(detected);
  const raw = observation(detected) as TrifectaResult | undefined;
  const trifecta = detected.status === "pass" && raw?.complete === true && typeof raw.required === "boolean" && Array.isArray(raw.signals) ? raw : incomplete();
  let trial: TrialResult = { status: "not_run" };
  if (trifecta.required && plan.trial) {
    const result = await gate({ ...input, extraEnv: {}, check: plan.trial }); gates.push(result);
    trial = { status: result.status === "pass" ? "pass" : "fail" };
  }
  const status = gates.some((g) => g.status === "tampered") ? "tampered" : evaluateSecurity(scanners, trifecta, trial, plan.exemptions);
  return { status, scanners, trifecta, trial, gates };
}

function copyRules(source: string, target: string): void {
  const check = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error("Scanner rules may not be symlinks");
    if (stat.isDirectory()) for (const name of readdirSync(path)) check(join(path, name));
    else if (!stat.isFile()) throw Error("Invalid scanner rules");
  };
  check(source);
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
}
