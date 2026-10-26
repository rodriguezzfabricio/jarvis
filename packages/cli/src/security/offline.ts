import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { withGitleaksConfig } from "./gitleaks-config.ts";
import { detectOsvEcosystems, osvDatabaseReady, pathInside } from "./osv-database.ts";
import type { Scanner, ScannerPin } from "./scanners.ts";
import type { ScannerRuntime } from "./runtime.ts";

const semgrepFlags = ["--metrics=off", "--disable-version-check", "--disable-nosem", "--json", "--max-target-bytes=0"];
const semgrepAllowed = new Set(["scan", ".", "--config", ...semgrepFlags, "--oss-only", "--no-secrets-validation", "--no-git-ignore", "--x-ignore-semgrepignore-files", "--jobs=1"]);
const gitleaksFlags = ["dir", ".", "--ignore-gitleaks-allow", "--gitleaks-ignore-path=/dev/null", "--redact=100", "--report-format=json"];
const gitleaksAllowed = new Set([...gitleaksFlags, "--config", "--report-path=@report", "--report-path=/dev/stdout", "--no-banner", "--no-color", "--log-level=fatal"]);
// --config=/dev/null replaces every per-folder osv-scanner.toml, which can ignore vulnerabilities or packages.
const osvFlags = ["--offline", "--offline-vulnerabilities", "--x-plugins=vulnmatch/osvlocal", "--config=/dev/null", "--format=json", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust"];
const osvAllowed = new Set(["scan", "source", ".", "--recursive", "--no-ignore", "--config=/dev/null", ...osvFlags]);

/** Only local, protected configuration and the reviewed option vocabulary can enter the gate. */
export function offlineArgs(tool: Scanner, pin: ScannerPin, cwd: string, runtime: ScannerRuntime): readonly string[] {
  if (tool === "gitleaks") return gitleaksArgs(withGitleaksConfig(pin), cwd, runtime);
  if (tool === "osv-scanner") {
    if (!osvFlags.every((flag) => pin.args.includes(flag)) || !pin.args.every((arg) => osvAllowed.has(arg))) throw Error("invalid offline osv configuration");
    return pin.args;
  }
  const args = pin.args.map((arg) => arg === "@rules" ? pin.rulesFile ?? "" : arg);
  const config = args.indexOf("--config"); const rules = args[config + 1];
  if (config < 0 || !protectedRules(rules, pin, cwd, runtime) || !semgrepFlags.every((flag) => args.includes(flag))) throw Error("invalid offline semgrep configuration");
  if (args.filter((arg) => arg === "--config").length !== 1 || !args.every((arg, index) => index === config + 1 || semgrepAllowed.has(arg))) throw Error("invalid offline semgrep configuration");
  return args;
}

function protectedRules(rules: string | undefined, pin: ScannerPin, cwd: string, runtime: ScannerRuntime): boolean {
  if (!rules || !isAbsolute(rules) || !existsSync(rules)) return false;
  const path = realpathSync(rules);
  if (pathInside(realpathSync(cwd), path)) return false;
  // Direct calls can use the runner's source; workers must use their protected fixture copy.
  return !runtime.fixturesDir || pin.rulesFile === rules || pathInside(realpathSync(runtime.fixturesDir), path);
}

function gitleaksArgs(pin: ScannerPin, cwd: string, runtime: ScannerRuntime): readonly string[] {
  const args = pin.args.map((arg) => arg === "@rules" ? pin.rulesFile ?? "" : arg);
  const redact = args.indexOf("--redact");
  if (redact >= 0 && args[redact + 1] === "100") args.splice(redact, 2, "--redact=100");
  const configIndex = args.indexOf("--config");
  if (!gitleaksFlags.every((flag) => args.includes(flag))) throw Error("invalid offline gitleaks configuration");
  if (!args.every((arg, index) => (configIndex >= 0 && index === configIndex + 1) || gitleaksAllowed.has(arg))) throw Error("invalid offline gitleaks configuration");
  if (args.filter((arg) => arg.startsWith("--report-path=")).length !== 1 || args.filter((arg) => arg === "--config").length > 1) throw Error("invalid offline gitleaks configuration");
  if (configIndex < 0 || !protectedRules(args[configIndex + 1], pin, cwd, runtime)) throw Error("invalid offline gitleaks configuration");
  return args;
}

export function osvCacheReady(pin: ScannerPin, cwd: string, runtime: ScannerRuntime): boolean {
  const value = pin.env?.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
  if (!value || !runtime.fixturesDir) return false;
  const path = value.replaceAll("$JARVIS_FIXTURES", runtime.fixturesDir);
  if (!existsSync(path)) return false;
  if (!pathInside(realpathSync(runtime.fixturesDir), realpathSync(path))) throw Error("Invalid scanner environment");
  return osvDatabaseReady(path, detectOsvEcosystems(cwd), pin.version);
}

export function reportedScannerVersion(tool: Scanner, stdout: string): string[] {
  const own = tool === "osv-scanner" && /^osv-scanner version:/m.test(stdout)
    ? stdout.split("\n").filter((line) => line.startsWith("osv-scanner version:")).join("\n") : stdout;
  return Array.from(own.matchAll(/(?<![\w.+-])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?![\w.+-])/g), (match) => match[1]!);
}
