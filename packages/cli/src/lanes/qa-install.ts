import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashCheckArtifacts, type ChecksStore } from "../checks/store.ts";
import { canonical } from "../ledger/ledger.ts";
import { insideTree } from "./materialize.ts";
import { verifyQaToolchain, type QaToolchainManifest, type VerifiedQaToolchain } from "./toolchain.ts";

export interface QaInstallInput { source: string; manifest: QaToolchainManifest }
export interface QaInstallDeps { clone?: (source: string, destination: string) => void }
export interface InstalledQaToolchain extends VerifiedQaToolchain { manifest: QaToolchainManifest }

export interface QaManifestInput {
  source: string; files: Record<string,string>;
  playwright: Omit<QaToolchainManifest["playwright"],"version">;
  axe: Omit<QaToolchainManifest["axe"],"version">;
  chromium?: QaToolchainManifest["chromium"];
}

/** Assemble versions and entry points from installed packages, against an independently approved file inventory. */
export function buildQaToolchainManifest(input: QaManifestInput): QaToolchainManifest {
  const files=hashCheckArtifacts(input.source,true);
  delete files["manifest.json"];
  if(canonical(files)!==canonical(input.files))throw new Error("QA manifest source differs from approved hashes");
  for(const file of [...Object.values(input.playwright),...Object.values(input.axe)]) {
    if(!Object.hasOwn(files,file))throw new Error("QA entry point is not in the approved files");
  }
  const version=(file:string):string=>{
    const path=join(input.source,file);
    if(lstatSync(path).size>256*1024)throw new Error("QA package metadata exceeds bounds");
    const value=(JSON.parse(readFileSync(path,"utf8")) as {version?:unknown}).version;
    if(typeof value!=="string"||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value))throw new Error("QA package needs an exact version");
    return value;
  };
  return {playwright:{...input.playwright,version:version(input.playwright.package)},axe:{...input.axe,version:version(input.axe.package)},files,
    ...(input.chromium?{chromium:input.chromium}:{})};
}

/** Same APFS operation as the hidden-check installer. A failed partial clone is discarded by the caller. */
function cloneTree(source: string, destination: string): void {
  if (process.platform !== "darwin") throw new Error("APFS clone unavailable");
  execFileSync("/bin/cp", ["-cR", source, destination], { stdio: "ignore" });
}

/** The caller supplies reviewed hashes, never a manifest inferred from untrusted downloaded bytes. */
export function installQaToolchain(store: ChecksStore, input: QaInstallInput, deps: QaInstallDeps = {}): InstalledQaToolchain {
  const source = resolve(input.source);
  const hashes = hashCheckArtifacts(source, true);
  const manifest = JSON.parse(JSON.stringify(input.manifest)) as QaToolchainManifest;
  if (Object.hasOwn(hashes, "manifest.json")) {
    if (canonical(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"))) !== canonical(manifest)) throw new Error("source QA manifest differs from the approved manifest");
    delete hashes["manifest.json"];
  }
  if (canonical(hashes) !== canonical(manifest.files)) throw new Error("QA source differs from approved hashes");
  const fixtures = join(store.checksDir, "fixtures");
  mkdirSync(fixtures, { recursive: true, mode: 0o700 });
  if (lstatSync(store.checksDir).isSymbolicLink() || lstatSync(fixtures).isSymbolicLink()) throw new Error("QA destination may not be a symlink");
  const root = join(realpathSync(fixtures), "qa-toolchain");
  if (insideTree(realpathSync(source), root) || insideTree(root, realpathSync(source))) throw new Error("QA source and destination overlap");
  if (lstatSync(root, { throwIfNoEntry: false })) throw new Error("QA toolchain already installed; changes require review");
  try {
    try { (deps.clone ?? cloneTree)(source, root); }
    catch { rmSync(root, {recursive:true,force:true}); cpSync(source, root, {recursive:true,force:false,errorOnExist:true}); }
    const copied = hashCheckArtifacts(root, true);
    if (existsSync(join(root, "manifest.json"))) delete copied["manifest.json"];
    if (canonical(copied) !== canonical(hashes)) throw new Error("QA copy differs from approved hashes");
    const manifestPath = join(root, "manifest.json"), text = canonical(manifest);
    writeFileSync(manifestPath, text, { mode: 0o600 });
    const manifestHash = createHash("sha256").update(text).digest("hex");
    const verified = verifyQaToolchain(manifestPath, manifestHash, source);
    // Include the generated manifest in the store's shared runtime budget before approval.
    store.hashAll();
    return { ...verified, manifest };
  } catch (error) { rmSync(root, {recursive:true,force:true}); throw error; }
}
