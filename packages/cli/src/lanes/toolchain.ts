import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChecksStore } from "../checks/store.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { BrowserRuntime } from "./browser.ts";

export interface QaToolchainInput { root: string; store: ChecksStore; ledger: Ledger }
export interface QaToolchainManifest {
  playwright: { module: string; cli: string; executable: string; package: string; version: string };
  axe: { source: string; package: string; version: string };
  files: Record<string, string>;
  chromium?: { bundle: string; executable: string; files: Record<string, string>; smokeLaunched: true };
}
export interface VerifiedQaToolchain {
  root: string; manifestPath: string; manifestHash: string;
  playwrightModule: string; playwrightCli: string; chromiumExecutable: string; axeSource: string; axeVersion: string;
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const inside = (root: string, path: string) => path === root || (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)));

function child(root: string, value: unknown): string {
  if (typeof value !== "string" || !value || /[\\:\x00-\x1f]/.test(value) || isAbsolute(value) || value.split("/").some(p => !p || p === "." || p === "..")) throw new Error("invalid toolchain relative file");
  return join(root, value);
}

export function protectedQaFile(path: string, fixtures: string, repo: string): string {
  if (!isAbsolute(path)) throw new Error("QA tool paths must be absolute");
  const real = realpathSync(path); const candidate = realpathSync(repo);
  if (inside(candidate, real) || !inside(realpathSync(fixtures), real)) throw new Error("QA tools must be runner-owned, outside the candidate and inside protected fixtures");
  return real;
}

/** The existing checks store and ledger bind the whole toolchain to the approved check definition. */
export function readQaToolchain(input: QaToolchainInput, repo: string): VerifiedQaToolchain {
  const verified = input.store.verify(input.ledger);
  if (!verified.ok) throw new Error(`QA toolchain checks lock is not approved: ${verified.problems.join("; ")}`);
  const root = protectedQaFile(input.root, join(input.store.checksDir, "fixtures"), repo);
  const manifestPath = join(root, "manifest.json");
  return verifyQaToolchain(manifestPath, sha(manifestPath), repo);
}

/** The driver receives this digest from the locked case command, never from candidate input. */
export function verifyQaToolchain(manifestPath: string, manifestHash: string, repo: string): VerifiedQaToolchain {
  if (!isAbsolute(manifestPath) || !/^[a-f\d]{64}$/.test(manifestHash) || sha(manifestPath) !== manifestHash) throw new Error("QA manifest differs from its approved hash");
  const root = realpathSync(dirname(manifestPath));
  if (inside(realpathSync(repo), root)) throw new Error("QA toolchain may not live in the candidate");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as QaToolchainManifest;
  if (!manifest || !manifest.playwright || !manifest.axe || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("invalid QA toolchain manifest");
  const required = [manifest.playwright.module, manifest.playwright.cli, manifest.playwright.executable, manifest.playwright.package, manifest.axe.source, manifest.axe.package];
  for (const value of required) if (!Object.hasOwn(manifest.files, relative(root, child(root, value)))) throw new Error("tool entry is missing from approved hashes");
  verifyFiles(root, manifest.files);
  if (manifest.chromium) {
    const bundle = relative(root, child(root, manifest.chromium.bundle));
    const actual = Object.keys(manifest.files).filter(key => key.startsWith(`${bundle}/`)).sort();
    const recorded = Object.keys(manifest.chromium.files).map(key => relative(root, child(root, `${bundle}/${key}`))).sort();
    if (manifest.chromium.smokeLaunched !== true || JSON.stringify(actual) !== JSON.stringify(recorded) || actual.some(key => manifest.files[key] !== manifest.chromium!.files[key.slice(bundle.length + 1)])) throw new Error("incomplete materialized Chromium manifest");
  }
  for (const pin of [manifest.playwright, manifest.axe]) {
    if (typeof pin.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pin.version) || (JSON.parse(readFileSync(child(root, pin.package), "utf8")) as {version?: unknown}).version !== pin.version) throw new Error("QA package version differs from the approved pin");
  }
  return { root, manifestPath, manifestHash, playwrightModule: child(root, manifest.playwright.module), playwrightCli: child(root, manifest.playwright.cli), chromiumExecutable: child(root, manifest.playwright.executable), axeSource: child(root, manifest.axe.source), axeVersion: manifest.axe.version };
}

function verifyFiles(root: string, files: Record<string, string>): void {
  const seen = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("QA toolchain files may not be symlinks");
      if (stat.isDirectory()) walk(path);
      else {
        const key = relative(root, path);
        if (key === "manifest.json") continue;
        if (!stat.isFile() || !Object.hasOwn(files, key) || sha(path) !== files[key]) throw new Error(`QA tool file differs from approved hash: ${key}`);
        seen.add(key);
      }
    }
  };
  walk(root);
  for (const key of Object.keys(files)) { child(root, key); if (!seen.has(key)) throw new Error(`missing approved QA tool file: ${key}`); }
}

/** Only an absolute entry in the approved toolchain is required; no checkout resolution or fallback. */
export function loadBrowserRuntime(manifestPath: string, manifestHash: string, repo: string): BrowserRuntime {
  const verified = verifyQaToolchain(manifestPath, manifestHash, repo);
  const runtime = createRequire(resolve(manifestPath))(verified.playwrightModule) as { chromium: { launch(options: { headless: boolean; executablePath: string; args: string[] }): ReturnType<BrowserRuntime["launch"]> } };
  // srt cannot allow Chromium's Mach registration; single-process avoids its rendezvous server.
  // installChromiumBundle's smoke launch is outside the gate sandbox and cannot catch this failure.
  return { launch: () => runtime.chromium.launch({ headless: true, executablePath: verified.chromiumExecutable, args: ["--single-process"] }), axeSource: readFileSync(verified.axeSource, "utf8") };
}

export { installChromiumBundle, type ChromiumInstallInput } from "./chromium-install.ts";
