import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runSession, type SessionSpec, type SessionOutcome } from "../proc/session.ts";
import { scannerEnvironment, withScannerRuntime, type ScannerRuntime } from "./runtime.ts";

export const SCANNERS = ["gitleaks", "semgrep", "osv-scanner"] as const;
export type Scanner = (typeof SCANNERS)[number];
export interface ScannerPin {
  bin: string;
  version: string;
  /** Reviewed, offline CLI arguments. @rules is replaced with the protected rules file. */
  args: readonly string[];
  rulesFile?: string;
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
  spawn?: (spec: SessionSpec) => Promise<SessionOutcome>;
  timeoutMs?: number;
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
  return array(report(raw).results).map((value) => {
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
  const spec = session(pin, cwd, [tool === "gitleaks" ? "version" : "--version"], deps.timeoutMs ?? 10_000, deps);
  try {
    const r = await (deps.spawn ?? runSession)(spec);
    const versions = Array.from(r.stdout.matchAll(/(?<![\w.+-])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?![\w.+-])/g), (m) => m[1]);
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
    if (!(await scannerVersion(tool, pin, cwd, runtime)).ok) return scannerNotRun(tool);
    const reportDir = tool === "gitleaks" ? mkdtempSync(join(runtime.tmpDir, "gitleaks-report-")) : undefined;
    const reportPath = reportDir ? join(reportDir, "report.json") : undefined;
    const args = tool === "semgrep" ? [...pin.args, "--disable-nosem"] : pin.args.map((a) => reportPath ? a.replaceAll("/dev/stdout", reportPath).replaceAll("@report", reportPath) : a);
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
      return { tool, status: findings.length > 0 ? "fail" : "pass", findings };
    } catch { return error("scanner failed"); }
    finally { if (reportDir) rmSync(reportDir, { recursive: true, force: true }); }
  });
}

function suppressionPresent(tool: Scanner, cwd: string): boolean {
  const files = tool === "gitleaks" ? [".gitleaksignore"] : tool === "semgrep" ? [".semgrepignore"] : ["osv-scanner.toml", ".osv-scanner.toml"];
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
