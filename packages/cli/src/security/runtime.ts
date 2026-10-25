import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ScannerDeps, ScannerPin } from "./scanners.ts";

export interface ScannerRuntime { homeDir: string; tmpDir: string; fixturesDir?: string }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Low-level callers get disposable directories; protected workers preserve the gate's directories. */
export async function withScannerRuntime<T>(cwd: string, deps: ScannerDeps, run: (runtime: ScannerDeps & ScannerRuntime) => Promise<T>): Promise<T> {
  const owned = deps.homeDir && deps.tmpDir ? undefined : mkdtempSync(join(tmpdir(), "jarvis-scanner-"));
  try {
    const homeDir = deps.homeDir ?? join(owned!, "home"); const tmpDir = deps.tmpDir ?? join(owned!, "tmp");
    for (const path of [homeDir, tmpDir]) {
      if (!isAbsolute(path) || inside(realpathSync(cwd), path)) throw Error("Scanner runtime must be outside checkout");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (inside(realpathSync(cwd), realpathSync(path))) throw Error("Scanner runtime must be outside checkout");
    }
    return await run({ ...deps, homeDir, tmpDir });
  } finally { if (owned) rmSync(owned, { recursive: true, force: true }); }
}

export function scannerEnvironment(pin: ScannerPin, runtime: ScannerRuntime): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: runtime.homeDir, TMPDIR: runtime.tmpDir, LANG: "C", CI: "1", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" };
  for (const [key, value] of Object.entries(pin.env ?? {})) {
    if (key !== "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY" || !runtime.fixturesDir) throw Error("Invalid scanner environment");
    try {
      const fixtures = realpathSync(runtime.fixturesDir);
      const path = realpathSync(value.replaceAll("$JARVIS_FIXTURES", fixtures));
      if (!inside(fixtures, path)) throw Error("Not protected");
      env[key] = path;
    } catch { throw Error("Invalid scanner environment"); }
  }
  return env;
}
