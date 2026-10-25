import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { detectOsvEcosystems, osvDatabaseReady, pathInside } from "./osv-database.ts";
import type { Scanner, ScannerPin } from "./scanners.ts";
import type { ScannerRuntime } from "./runtime.ts";

const semgrepFlags = ["--metrics=off", "--disable-version-check", "--disable-nosem", "--json"];
const semgrepAllowed = new Set(["scan", ".", "--config", ...semgrepFlags, "--oss-only", "--no-secrets-validation", "--no-git-ignore", "--x-ignore-semgrepignore-files", "--jobs=1"]);
const osvFlags = ["--offline", "--offline-vulnerabilities", "--x-plugins=vulnmatch/osvlocal", "--format=json", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust"];
const osvAllowed = new Set(["scan", "source", ".", "--recursive", "--no-ignore", ...osvFlags]);

/** Only local, protected configuration and the reviewed option vocabulary can enter the gate. */
export function offlineArgs(tool: Scanner, pin: ScannerPin, cwd: string, runtime: ScannerRuntime): readonly string[] {
  if (tool === "gitleaks") return pin.args;
  if (tool === "osv-scanner") {
    if (!osvFlags.every((flag) => pin.args.includes(flag)) || !pin.args.every((arg) => osvAllowed.has(arg))) throw Error("invalid offline osv configuration");
    return pin.args;
  }
  const args = pin.args.map((arg) => arg === "@rules" ? pin.rulesFile ?? "" : arg);
  const config = args.indexOf("--config"); const rules = args[config + 1];
  if (config < 0 || !rules || !isAbsolute(rules) || !existsSync(rules) || !semgrepFlags.every((flag) => args.includes(flag))) throw Error("invalid offline semgrep configuration");
  if (args.filter((arg) => arg === "--config").length !== 1 || !args.every((arg, index) => index === config + 1 || semgrepAllowed.has(arg))) throw Error("invalid offline semgrep configuration");
  const path = realpathSync(rules);
  if (pathInside(realpathSync(cwd), path)) throw Error("invalid offline semgrep configuration");
  // Direct calls can use the runner's vendored source; workers must use their protected fixture copy.
  if (runtime.fixturesDir && pin.rulesFile !== rules && !pathInside(realpathSync(runtime.fixturesDir), path)) throw Error("invalid offline semgrep configuration");
  return args;
}

export function osvCacheReady(pin: ScannerPin, cwd: string, runtime: ScannerRuntime): boolean {
  const value = pin.env?.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
  if (!value || !runtime.fixturesDir) return false;
  const path = value.replaceAll("$JARVIS_FIXTURES", runtime.fixturesDir);
  if (!existsSync(path)) return false;
  if (!pathInside(realpathSync(runtime.fixturesDir), realpathSync(path))) throw Error("Invalid scanner environment");
  return osvDatabaseReady(path, detectOsvEcosystems(cwd));
}

export function reportedScannerVersion(tool: Scanner, stdout: string): string[] {
  const own = tool === "osv-scanner" && /^osv-scanner version:/m.test(stdout)
    ? stdout.split("\n").filter((line) => line.startsWith("osv-scanner version:")).join("\n") : stdout;
  return Array.from(own.matchAll(/(?<![\w.+-])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?![\w.+-])/g), (match) => match[1]!);
}
