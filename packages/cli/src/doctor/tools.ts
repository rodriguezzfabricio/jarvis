import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ChecksStore } from "../checks/store.ts";
import { pinnedMaestroBin } from "../config/pins.ts";
import { fileHash } from "../lanes/materialize.ts";
import { verifyChecksReadOnly } from "./read-only.ts";
import { SCANNERS, scannerDoctorChecks, type ScannerDeps, type ScannerPins } from "../security/scanners.ts";
import { protectedQaFile, verifyQaToolchain, type QaToolchainInput } from "../lanes/toolchain.ts";
import type { DoctorCheck } from "./doctor.ts";

export interface ToolDoctorDeps {
  home?: string;
  repoPath: string;
  platform?: NodeJS.Platform;
  exec: (bin: string, args: string[]) => string;
  exists?: (path: string) => boolean;
  scannerPins?: ScannerPins;
  scannerDeps?: ScannerDeps;
  tauriBin?: string;
  toolchain?: QaToolchainInput | undefined;
  /** Discover existing manifests only inside runner-owned project check fixtures. */
  projectsRoot?: string;
  required?: readonly string[];
}
const version = (text: string): string | undefined => {
  const versions = [...text.matchAll(/(?<![\w.+-])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?![\w.+-])/g)];
  return versions.length === 1 ? versions[0]![1] : undefined;
};

/** Discover installed tools by absolute path. No shell, package manager, scan, install or update. */
export async function toolDoctorChecks(deps: ToolDoctorDeps): Promise<DoctorCheck[]> {
  const home = deps.home ?? homedir(); const exists = deps.exists ?? existsSync;
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, level: ok ? "pass" : deps.required?.includes(name) ? "fail" : "warn", detail });
  const locate = (tool: string) => [join(home, ".local", "bin", tool), join("/opt/homebrew/bin", tool), join("/usr/local/bin", tool)].find(exists);
  const pins: ScannerPins = { ...deps.scannerPins };
  if (deps.scannerPins === undefined) for (const tool of SCANNERS) {
    const bin = locate(tool);
    if (!bin) continue;
    try {
      const found = version(deps.exec(bin, [tool === "gitleaks" ? "version" : "--version"]));
      if (found) pins[tool] = { bin, version: found, args: [] };
    } catch { /* Unavailable tools stay warnings unless required. */ }
  }
  // Reuse the security lane's exact-version probe; no scan is run by doctor.
  const scannerDeps = deps.scannerDeps ?? { spawn: async spec => {
    try { return { code: 0, timedOut: false, overflowed: false, durationMs: 0, stdout: deps.exec(spec.bin, [...spec.args]), stderr: "" }; }
    catch { return { code: 1, timedOut: false, overflowed: false, durationMs: 0, stdout: "", stderr: "" }; }
  } } satisfies ScannerDeps;
  try {
    for (const check of await scannerDoctorChecks(pins, deps.repoPath, scannerDeps)) add(check.name, check.level === "pass", check.detail);
  } catch (error) { for (const tool of SCANNERS) add(`security.${tool}`, false, `scanner version check unavailable: ${String(error)}`); }
  const probe = (name: string, bin: string | undefined) => {
    try {
      if (!bin || !isAbsolute(bin) || !exists(bin)) throw new Error("binary unavailable");
      const exact = version(deps.exec(bin, ["--version"]));
      if (!exact) throw new Error("exact version unavailable");
      add(name, true, `${bin}: ${exact}`);
    } catch (error) { add(name, false, `not run: ${name} (${String(error)})`); }
  };
  probe("maestro", pinnedMaestroBin(home));
  try {
    if ((deps.platform ?? process.platform) !== "darwin") throw new Error("requires macOS");
    const path = deps.exec("/usr/bin/xcode-select", ["-p"]).trim();
    const info = deps.exec("/usr/sbin/pkgutil", ["--pkg-info", "com.apple.pkg.CLTools_Executables"]);
    const exact = /^version:\s*(\d+(?:\.\d+)+)\s*$/m.exec(info)?.[1];
    if (!isAbsolute(path) || !exists(path) || !exact) throw new Error("CLT path or exact version unavailable");
    add("xcode_clt", true, `${path}: ${exact}`);
  } catch (error) { add("xcode_clt", false, `not run: Xcode command-line tools (${String(error)})`); }
  probe("tauri", deps.tauriBin ?? [join(home, ".cargo", "bin", "cargo-tauri"), locate("tauri")].find((p): p is string => p !== undefined && exists(p)));
  let inputs: { root: string; store: ChecksStore }[];
  try { inputs = deps.toolchain ? [deps.toolchain] : discoverToolchains(deps.projectsRoot); }
  catch (error) { add("qa_toolchain", false, `QA manifest discovery unavailable: ${String(error)}`); return checks; }
  if (!inputs.length) add("qa_toolchain", false, "not run: no QA toolchain manifest in protected check fixtures");
  for (const input of inputs) {
    try {
      const approved = verifyChecksReadOnly(input.store);
      if (!approved.ok) throw new Error(approved.problems.join("; "));
      const root = protectedQaFile(input.root, join(input.store.checksDir, "fixtures"), deps.repoPath);
      const path = join(root, "manifest.json");
      const tools = verifyQaToolchain(path, fileHash(path), deps.repoPath);
      const manifest = JSON.parse(readFileSync(tools.manifestPath, "utf8")) as { playwright: { version: string } };
      add("qa_toolchain", true, `${tools.manifestPath}: Playwright ${manifest.playwright.version}; axe ${tools.axeVersion}; sha256 ${tools.manifestHash}`);
    } catch (error) { add("qa_toolchain", false, `QA toolchain unavailable: ${String(error)}`); }
  }
  return checks;
}

function discoverToolchains(projects: string | undefined): { root: string; store: ChecksStore }[] {
  const inputs: { root: string; store: ChecksStore }[] = [];
  if (!projects || !existsSync(projects)) return inputs;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const project = join(projects, entry.name); const store = new ChecksStore(project);
    const fixtures = join(store.checksDir, "fixtures");
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || !existsSync(dir)) return;
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory() && !item.isSymbolicLink()) walk(path, depth + 1);
        else if (item.isFile() && item.name === "manifest.json") inputs.push({ root: dir, store });
      }
    };
    walk(fixtures, 0);
  }
  return inputs;
}
