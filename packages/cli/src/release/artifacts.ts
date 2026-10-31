import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { artifactDigest, manifestHash } from "./manifest.ts";
import { realChild, within } from "./paths.ts";
import type { ReleaseManifest, ReleaseProjectConfig } from "./types.ts";

export class ArtifactPolicyError extends Error {}

const STATIC_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".map", ".txt", ".xml", ".svg", ".ico",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".wasm", ".pdf", ".webmanifest", ".mp4", ".webm", ".mp3", ".ogg", ".wav"]);
function assertStaticName(name: string, path: string, directory: boolean): void {
  const lower = name.toLowerCase();
  const reserved = /^(?:vercel|now)\.(?:json|[cm]?[jt]s)$/.test(lower) || lower === "netlify.toml"
    || ["netlify", "node_modules", "package.json"].includes(lower)
    || /(?:^|[.-])config\.(?:[cm]?[jt]s|json|toml|ya?ml)$/.test(lower);
  if (reserved || (name.startsWith(".") && name !== ".well-known") || /[\x00-\x1f\x7f\\]/.test(name)
    || (!directory && !STATIC_EXTENSIONS.has(extname(lower)) && !path.startsWith(".well-known/"))) {
    throw new ArtifactPolicyError(`non-static deployment file refused: ${path}`);
  }
}
function copyTree(source: string, target: string, path = ""): void {
  const st = lstatSync(source);
  if (st.isSymbolicLink()) throw new ArtifactPolicyError(`artifact symlink refused: ${path}`);
  if (st.isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(source)) {
      const child = path ? `${path}/${name}` : name;
      assertStaticName(name, child, lstatSync(join(source, name)).isDirectory());
      copyTree(join(source, name), join(target, name), child);
    }
  } else if (st.isFile()) {
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new ArtifactPolicyError(`artifact must be a regular file: ${path}`);
      writeFileSync(target, readFileSync(fd), { flag: "wx", mode: 0o600 });
    } finally { closeSync(fd); }
  } else throw new ArtifactPolicyError(`artifact must contain regular files only: ${path}`);
}

/** Input is the static publish directory, never a provider project or executable build-output tree. */
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
    mkdirSync(dir, { mode: 0o700 });
    const webRoot = join(dir, manifest.provider === "vercel" ? ".vercel/output/static" : "public");
    if (manifest.provider === "vercel") mkdirSync(join(dir, ".vercel/output"), { recursive: true, mode: 0o700 });
    copyTree(source, webRoot);
    if (artifactDigest(webRoot) !== manifest.artifactHash) throw new Error("artifact copy hash differs from approved revision");
    mkdirSync(join(webRoot, ".well-known"), { recursive: true, mode: 0o700 });
    writeFileSync(join(webRoot, ".well-known/jarvis-release"), `${manifestHash(manifest)}\n`, { mode: 0o600 });
    if (manifest.provider === "vercel") {
      if (!config.orgId) throw new Error("runner Vercel organization required");
      writeFileSync(join(dir, "vercel.json"), JSON.stringify({ framework: null, buildCommand: "", installCommand: "" }), { mode: 0o600 });
      writeFileSync(join(dir, ".vercel/output/config.json"), JSON.stringify({ version: 3 }), { mode: 0o600 });
      writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify({ projectId: config.siteId, orgId: config.orgId }), { mode: 0o600 });
    } else writeFileSync(join(dir, "netlify.toml"), '[build]\npublish = "public"\ncommand = ""\n', { mode: 0o600 });
    return { dir, dispose };
  } catch (error) { dispose(); throw error; }
}
