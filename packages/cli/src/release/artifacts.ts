import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { artifactDigest, manifestHash } from "./manifest.ts";
import { realChild, within } from "./paths.ts";
import type { Provider, ReleaseManifest, ReleaseProjectConfig } from "./types.ts";

export class ArtifactPolicyError extends Error {}

const STATIC_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".map", ".txt", ".xml", ".svg", ".ico",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".wasm", ".pdf", ".webmanifest", ".mp4", ".webm", ".mp3", ".ogg", ".wav"]);
/** A candidate path as printable ASCII of bounded length: it reaches receipts, reports and notifications. */
function shown(path: string): string {
  const text = path.replace(/[^\x20-\x7e]/gu, ch => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
/**
 * Static content only: a file needs a listed extension or none at all (`/health`, `CNAME`); Netlify reads `_redirects`
 * and `_headers` from the publish folder as configuration, so those are refused with the providers' config files.
 */
function assertStaticName(path: string, directory: boolean): void {
  const name = basename(path); const lower = name.toLowerCase();
  const reserved = /^(?:vercel|now)\.(?:json|[cm]?[jt]s)$/.test(lower) || lower === "netlify.toml"
    || ["netlify", "node_modules", "package.json", "_redirects", "_headers"].includes(lower)
    || /(?:^|[.-])config\.(?:[cm]?[jt]s|json|toml|ya?ml)$/.test(lower);
  if (reserved || (name.startsWith(".") && name !== ".well-known") || /[\x00-\x1f\x7f\\]/.test(name)
    || (!directory && extname(lower) !== "" && !STATIC_EXTENSIONS.has(extname(lower)) && !path.startsWith(".well-known/"))) {
    throw new ArtifactPolicyError(`non-static deployment file refused: ${shown(path)}`);
  }
}
/** The name rule and the copy use the same stat, so a swap between checking and copying can't skip a rule. */
function copyTree(source: string, target: string, path = ""): void {
  const st = lstatSync(source);
  if (st.isSymbolicLink()) throw new ArtifactPolicyError(`artifact symlink refused: ${shown(path)}`);
  if (!path && !st.isDirectory()) throw new ArtifactPolicyError("artifact must be a static directory");
  if (st.isDirectory()) {
    if (path) assertStaticName(path, true);
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name), path ? `${path}/${name}` : name);
  } else if (st.isFile()) {
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new ArtifactPolicyError(`artifact must be a regular file: ${shown(path)}`);
      assertStaticName(path, false);
      writeFileSync(target, readFileSync(fd), { flag: "wx", mode: 0o600 });
    } finally { closeSync(fd); }
  } else throw new ArtifactPolicyError(`artifact must contain regular files only: ${shown(path)}`);
}

/**
 * Each provider's deploy tree (decision 161): where the static files go, and the fixed configuration the runner writes
 * beside them, so no candidate byte sits where the provider's CLI reads configuration. Vercel's is a Build Output API
 * tree for `vercel deploy --prebuilt`; Netlify's a publish folder and its own `netlify.toml`.
 */
interface DeployTree { webRoot: string; jsonMarker?: boolean; write(dir: string, config: ReleaseProjectConfig): void }
const DEPLOY_TREES: Record<Provider, DeployTree> = {
  render: { webRoot: "", jsonMarker: true, write() {} },
  vercel: { webRoot: ".vercel/output/static", write(dir, config) {
    if (!config.orgId) throw new Error("runner Vercel organization required");
    writeFileSync(join(dir, "vercel.json"), JSON.stringify({ framework: null, buildCommand: "", installCommand: "" }), { mode: 0o600 });
    writeFileSync(join(dir, ".vercel/output/config.json"), JSON.stringify({ version: 3 }), { mode: 0o600 });
    writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify({ projectId: config.siteId, orgId: config.orgId }), { mode: 0o600 });
  } },
  netlify: { webRoot: "public", write(dir) {
    writeFileSync(join(dir, "netlify.toml"), '[build]\npublish = "public"\ncommand = ""\n', { mode: 0o600 });
  } },
} satisfies Record<Provider, DeployTree>;

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
    const tree = DEPLOY_TREES[manifest.provider];
    const webRoot = join(dir, tree.webRoot);
    mkdirSync(dirname(webRoot), { recursive: true, mode: 0o700 });
    copyTree(source, webRoot);
    if (artifactDigest(webRoot) !== manifest.artifactHash) throw new Error("artifact copy hash differs from approved revision");
    if (tree.jsonMarker) writeFileSync(join(webRoot, ".jarvis-build.json"), JSON.stringify({ manifestHash: manifestHash(manifest) }), { mode: 0o600, flag: "wx" });
    else {
      mkdirSync(join(webRoot, ".well-known"), { recursive: true, mode: 0o700 });
      writeFileSync(join(webRoot, ".well-known/jarvis-release"), `${manifestHash(manifest)}\n`, { mode: 0o600 });
    }
    tree.write(dir, config);
    return { dir, dispose };
  } catch (error) { dispose(); throw error; }
}
