import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactDigest, manifestHash } from "./manifest.ts";
import { realChild, within } from "./paths.ts";
import type { ReleaseManifest, ReleaseProjectConfig } from "./types.ts";

function copyTree(source: string, target: string): void {
  const st = lstatSync(source);
  if (st.isSymbolicLink()) throw new Error("artifact symlink refused");
  if (st.isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
  } else if (st.isFile()) {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    chmodSync(target, st.mode & 0o777);
  } else throw new Error("artifact must contain regular files only");
}

/** Hash the private copy before adding runner-owned metadata, avoiding a marker/hash cycle. */
export function copyDeploymentArtifacts(manifest: ReleaseManifest, config: ReleaseProjectConfig, runnerRoot: string): { dir: string; dispose(): void } {
  const source = realChild(config.artifactRoot, manifest.artifactDir, true);
  const runner = realpathSync(runnerRoot);
  if (within(runner, source, true)) throw new Error("artifact/private root overlap refused");
  const privateRoot = realChild(runner, config.privateRoot);
  if (within(source, privateRoot, true)) throw new Error("artifact/private root overlap refused");
  const room = mkdtempSync(join(privateRoot, "deploy-"));
  const dir = join(room, "artifact");
  const dispose = () => rmSync(room, { recursive: true, force: true });
  try {
    copyTree(source, dir);
    if (artifactDigest(dir) !== manifest.artifactHash) throw new Error("artifact copy hash differs from approved revision");
    const webRoot = manifest.provider === "vercel" ? join(dir, ".vercel/output/static") : dir;
    mkdirSync(join(webRoot, ".well-known"), { recursive: true, mode: 0o700 });
    writeFileSync(join(webRoot, ".well-known/jarvis-release"), `${manifestHash(manifest)}\n`, { mode: 0o600 });
    if (manifest.provider === "vercel") {
      if (!config.orgId) throw new Error("runner Vercel organization required");
      writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify({ projectId: config.siteId, orgId: config.orgId }), { mode: 0o600 });
    }
    return { dir, dispose };
  } catch (error) { dispose(); throw error; }
}
