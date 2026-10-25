import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import { fileHash, insideTree, materializeTree } from "./materialize.ts";
import { verifyQaToolchain, type QaToolchainManifest, type VerifiedQaToolchain } from "./toolchain.ts";
export interface ChromiumInstallInput { sourceBundle: string; destination: string; executable: string; manifestPath: string }

/** Install locally, smoke launch, then update the manifest. Checks approval remains a separate reviewed action. */
export async function installChromiumBundle(input: ChromiumInstallInput, deps: { spawn?: (spec: SessionSpec) => Promise<SessionOutcome> } = {}): Promise<VerifiedQaToolchain> {
  if (![input.sourceBundle, input.destination, input.manifestPath].every(isAbsolute)) throw new Error("Chromium installation paths must be absolute");
  const root = realpathSync(dirname(input.manifestPath));
  const destination = join(realpathSync(dirname(input.destination)), basename(input.destination));
  if (!insideTree(root, destination) || root === destination || existsSync(destination) || !input.destination.endsWith(".app")) throw new Error("Chromium destination must be a new protected bundle");
  if (!input.executable || isAbsolute(input.executable) || input.executable.split("/").some(p => !p || p === "." || p === "..") || /[\\\x00-\x1f]/.test(input.executable)) throw new Error("invalid bundle executable");
  const original = readFileSync(input.manifestPath); const manifest = JSON.parse(original.toString()) as QaToolchainManifest;
  const home = mkdtempSync(join(tmpdir(), "jarvis-chromium-install-"));
  try {
    const files = materializeTree(input.sourceBundle, destination);
    const executable = join(destination, input.executable);
    const launch = await (deps.spawn ?? runSession)({ bin: executable, args: ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--dump-dom", "about:blank"], cwd: destination, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home }, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    if (launch.code !== 0 || launch.timedOut || launch.overflowed) throw new Error("materialized Chromium launch failed");
    const bundle = relative(root, destination);
    for (const [path, digest] of Object.entries(files)) manifest.files[`${bundle}/${path}`] = digest;
    manifest.chromium = { bundle, executable: input.executable, files, smokeLaunched: true };
    manifest.playwright.executable = relative(root, executable);
    writeFileSync(input.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    return verifyQaToolchain(input.manifestPath, fileHash(input.manifestPath), home);
  } catch (error) { writeFileSync(input.manifestPath, original); rmSync(destination, { recursive: true, force: true }); throw error; }
  finally { rmSync(home, { recursive: true, force: true }); }
}
