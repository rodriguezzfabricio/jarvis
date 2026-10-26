import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { runSession, type SessionSpec, type SessionOutcome } from "../proc/session.ts";
import { semgrepCoverage, semgrepScannedPaths } from "./coverage.ts";
import { offlineArgs, osvCacheReady, osvCacheAgeError, reportedScannerVersion } from "./offline.ts";
import { withMappedSemgrep } from "./mapped.ts";
import { scannerEnvironment, withScannerRuntime, type ScannerRuntime } from "./runtime.ts";

export const SCANNERS = ["gitleaks", "semgrep", "osv-scanner"] as const;
export type Scanner = (typeof SCANNERS)[number];
export interface ScannerPin {
  bin: string;
  version: string;
  /** Reviewed, offline CLI arguments. @rules is replaced with the protected rules file. */
  args: readonly string[];
  rulesFile?: string;
  /** Downloaded cache source, copied into protected fixtures at installation. */
  databaseDir?: string;
  /** Approved cache configuration; database paths must resolve inside the read-only fixtures. */
  env?: Record<string, string>;
}
export type ScannerPins = Partial<Record<Scanner, ScannerPin>>;
export interface Finding {
  tool: Scanner;
  rule: string;
  file: string;
  line: number;
  severity: "high" | "medium" | "low" | "unknown";
  message: string;
  fingerprint: string;
}
export interface ScanResult {
  tool: Scanner;
  status: "pass" | "fail" | "not_run" | "error";
  findings: Finding[];
  detail?: string;
}
export interface ScannerDeps {
  now?: () => Date;
  spawn?: (spec: SessionSpec) => Promise<SessionOutcome>;
  timeoutMs?: number;
  /** Version checks have their own deadline, independent of the scan's timeout (default 10 s). */
  versionTimeoutMs?: number;
  homeDir?: string;
  tmpDir?: string;
  fixturesDir?: string;
}

type ObjectValue = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid scanner output"); };
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function object(v: unknown): ObjectValue {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : invalid();
}
function array(v: unknown): unknown[] { return Array.isArray(v) ? v : invalid(); }
function string(v: unknown): string { return typeof v === "string" && v.length > 0 ? v : invalid(); }
function line(v: unknown): number { return Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : invalid(); }
function severity(v: unknown): Finding["severity"] {
  const s = String(v).toLowerCase();
  if (["critical", "high", "error"].includes(s)) return "high";
  if (["moderate", "medium", "warning"].includes(s)) return "medium";
  return ["low", "info"].includes(s) ? "low" : "unknown";
}

function finding(tool: Scanner, rule: string, file: string, at: number, level: Finding["severity"], message: string, identity: string): Finding {
  return { tool, rule, file, line: at, severity: level, message, fingerprint: hash(identity) };
}

function gitleaks(raw: unknown): Finding[] {
  const rows = array(raw).map(object);
  // A scanner can repeat a secret in its path, rule or description. Strip every known secret from
  // every emitted string, and never emit snippets, matches, descriptions or scanner diagnostics.
  const secrets = rows.flatMap((r) => [r.Secret, r.Match]).filter((v): v is string => typeof v === "string" && v.length > 0).sort((a, b) => b.length - a.length);
  const clean = (v: string) => secrets.reduce((out, secret) => out.split(secret).join("[REDACTED]"), v);
  return rows.map((r) => {
    const rule = clean(string(r.RuleID)); const file = clean(string(r.File)); const at = line(r.StartLine);
    const identity = `${rule}:${file}:${at}`;
    return finding("gitleaks", rule, file, at, "high", "Potential secret", identity);
  });
}

function report(raw: unknown): ObjectValue {
  const r = object(raw);
  if (r.errors !== undefined && array(r.errors).length !== 0) invalid();
  return r;
}

function semgrep(raw: unknown): Finding[] {
  const output = report(raw);
  semgrepScannedPaths(output);
  return array(output.results).map((value) => {
    const r = object(value); const rule = string(r.check_id); const file = string(r.path);
    const at = line(object(r.start).line); const extra = object(r.extra);
    return finding("semgrep", rule, file, at, severity(extra.severity), "Static analysis finding", `${rule}:${file}:${at}`);
  });
}

function osv(raw: unknown): Finding[] {
  return array(report(raw).results).flatMap((value) => {
    const result = object(value); const file = string(object(result.source).path);
    return array(result.packages).flatMap((value) => {
      const pkg = object(value); const name = string(object(pkg.package).name);
      return array(pkg.vulnerabilities).map((value) => {
        const v = object(value); const rule = string(v.id);
        const level = v.database_specific === undefined ? "unknown" : severity(object(v.database_specific).severity);
        return finding("osv-scanner", rule, file, 0, level, "Vulnerable dependency", `${rule}:${file}:${name}`);
      });
    });
  });
}

/** Deliberately rejects partial schemas and scanner errors instead of treating them as no findings. */
export function parseFindings(tool: Scanner, text: string): Finding[] {
  try {
    const raw: unknown = JSON.parse(text);
    return tool === "gitleaks" ? gitleaks(raw) : tool === "semgrep" ? semgrep(raw) : osv(raw);
  } catch { return invalid(); }
}

function session(pin: ScannerPin, cwd: string, args: readonly string[], timeoutMs: number, runtime: ScannerRuntime): SessionSpec {
  if (!isAbsolute(pin.bin)) throw new Error("Scanner binary must be absolute");
  return {
    bin: pin.bin, args, cwd, timeoutMs, killGraceMs: 100, maxOutputBytes: 4 * 1024 * 1024,
    env: scannerEnvironment(pin, runtime),
  };
}

export function scannerNotRun(tool: Scanner): ScanResult {
  return { tool, status: "not_run", detail: `not run: ${tool} missing`, findings: [] };
}

async function scannerVersion(tool: Scanner, pin: ScannerPin, cwd: string, deps: ScannerDeps & ScannerRuntime): Promise<{ ok: boolean; version?: string }> {
  const versionPin = { ...pin, env: Object.fromEntries(Object.entries(pin.env ?? {}).filter(([key]) => key !== "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY")) };
  const spec = session(versionPin, cwd, [tool === "gitleaks" ? "version" : "--version"], deps.versionTimeoutMs ?? 10_000, deps);
  try {
    const r = await (deps.spawn ?? runSession)(spec);
    const versions = reportedScannerVersion(tool, r.stdout);
    return { ok: r.code === 0 && !r.timedOut && !r.overflowed && versions.length === 1 && versions[0] === pin.version, ...(versions.length === 1 ? { version: versions[0]! } : {}) };
  } catch { return { ok: false }; }
}

/** Scanner pipes stay in memory; fully redacted report files are private and removed after parsing. */
export async function runScanner(tool: Scanner, pin: ScannerPin | undefined, cwd: string, deps: ScannerDeps = {}): Promise<ScanResult> {
  const error = (detail: string): ScanResult => ({ tool, status: "error", detail, findings: [] });
  if (!pin) return scannerNotRun(tool);
  if (suppressionPresent(tool, cwd)) return error("suppression file present");
  if (tool === "gitleaks" && !fullyRedacted(pin.args)) return error("gitleaks requires full redaction");
  return withScannerRuntime(cwd, deps, async (runtime) => {
    if (Object.keys(pin.env ?? {}).some((key) => key !== "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY")) scannerEnvironment(pin, runtime);
    let approvedArgs: readonly string[];
    try { approvedArgs = offlineArgs(tool, pin, cwd, runtime); }
    catch { return error(`invalid offline ${tool === "osv-scanner" ? "osv" : tool} configuration`); }
    if (tool === "osv-scanner" && !osvCacheReady(pin, cwd, runtime)) return { tool, status: "not_run", detail: "not run: osv database missing", findings: [] };
    if (tool === "osv-scanner") {
      const ageError = osvCacheAgeError(pin, runtime, (runtime.now ?? (() => new Date()))());
      if (ageError) return error(ageError);
    }
    if (!(await scannerVersion(tool, pin, cwd, runtime)).ok) return scannerNotRun(tool);
    const reportDir = tool === "gitleaks" ? mkdtempSync(join(runtime.tmpDir, "gitleaks-report-")) : undefined;
    const reportPath = reportDir ? join(reportDir, "report.json") : undefined;
    const args = approvedArgs.map((a) => reportPath ? a.replaceAll("/dev/stdout", reportPath).replaceAll("@report", reportPath) : a);
    try {
      const r = await (runtime.spawn ?? runSession)(session(pin, cwd, args, runtime.timeoutMs ?? 120_000, runtime));
      if (r.timedOut) return error("timeout");
      if (r.overflowed) return error("output limit");
      if (r.code !== 0 && r.code !== 1) return error("exit code");
      let findings: Finding[];
      if (reportPath && existsSync(reportPath) && lstatSync(reportPath).size > 4 * 1024 * 1024) return error("output limit");
      const output = reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : r.stdout;
      try { findings = parseFindings(tool, output); } catch { return error("invalid output"); }
      if (r.code !== 0 && findings.length === 0) return error("exit code");
      if (tool === "semgrep") {
        const scanned = semgrepScannedPaths(JSON.parse(output));
        const initialCoverage = semgrepCoverage(cwd, scanned);
        if (initialCoverage === "semgrep coverage unavailable") return error(initialCoverage);
        const mapped = await mappedSemgrep(pin, cwd, scanned, args, runtime);
        findings.push(...mapped.findings);
        const coverage = semgrepCoverage(cwd, [...scanned, ...mapped.scanned]);
        if (coverage) return error(coverage);
        if (!mapped.complete) return error("semgrep mapped coverage missing");
      }
      return { tool, status: findings.length > 0 ? "fail" : "pass", findings };
    } catch { return error("scanner failed"); }
    finally { if (reportDir) rmSync(reportDir, { recursive: true, force: true }); }
  });
}

async function mappedSemgrep(pin: ScannerPin, cwd: string, scanned: readonly string[], args: readonly string[], runtime: ScannerDeps & ScannerRuntime): Promise<{ findings: Finding[]; scanned: string[]; complete: boolean }> {
  return await withMappedSemgrep(cwd, scanned, runtime.tmpDir, async (tree) => {
    const r = await (runtime.spawn ?? runSession)(session(pin, tree.cwd, args, runtime.timeoutMs ?? 120_000, runtime));
    if (r.timedOut || r.overflowed || (r.code !== 0 && r.code !== 1)) throw Error("Mapped scanner failed");
    const findings = parseFindings("semgrep", r.stdout);
    if (r.code !== 0 && findings.length === 0) throw Error("Mapped scanner failed");
    const paths = semgrepScannedPaths(JSON.parse(r.stdout));
    const mappedScanned = paths.flatMap((path) => {
      const original = tree.originals.get(resolve(tree.cwd, path));
      return original === undefined ? [] : [original];
    });
    return {
      scanned: mappedScanned,
      complete: tree.originals.size === new Set(mappedScanned).size,
      findings: findings.map((value) => {
        const file = tree.originals.get(resolve(tree.cwd, value.file));
        if (file === undefined) throw Error("Unknown mapped finding path");
        return { ...value, file, fingerprint: hash(`${value.rule}:${file}:${value.line}`) };
      }),
    };
  }) ?? { findings: [], scanned: [], complete: true };
}

function suppressionPresent(tool: Scanner, cwd: string): boolean {
  // gitleaks loads <source>/.gitleaks.toml as its whole ruleset when no --config is given.
  const files = tool === "gitleaks" ? [".gitleaksignore", ".gitleaks.toml"] : tool === "semgrep" ? [".semgrepignore"] : ["osv-scanner.toml", ".osv-scanner.toml"];
  return files.some((file) => {
    try { lstatSync(join(cwd, file)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
}

function fullyRedacted(args: readonly string[]): boolean {
  const flags = args.filter((a) => a === "--redact" || a.startsWith("--redact="));
  return flags.length === 1 && (flags[0] === "--redact=100" || (flags[0] === "--redact" && args[args.indexOf("--redact") + 1] === "100"));
}

/** Doctor reports tool availability and exact versions; it does not run scans. */
export async function scannerDoctorChecks(pins: ScannerPins, cwd: string, deps: ScannerDeps = {}): Promise<{ name: string; level: "pass" | "fail"; detail: string }[]> {
  return withScannerRuntime(cwd, deps, async (runtime) => {
    const checks = [];
    for (const tool of SCANNERS) {
      const pin = pins[tool]; const found = pin ? await scannerVersion(tool, pin, cwd, runtime) : { ok: false };
      const detail = found.ok ? `${tool} ${pin!.version} (${pin!.bin})` : `not run: ${tool} missing${pin ? ` (expected ${pin.version}; found ${found.version ?? "unavailable"})` : ""}`;
      checks.push({ name: `security.${tool}`, level: found.ok ? "pass" as const : "fail" as const, detail });
    }
    return checks;
  });
}
