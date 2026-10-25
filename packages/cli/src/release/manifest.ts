import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { canonical } from "../ledger/ledger.ts";
import type { ReleaseAction, ReleaseManifest, ReleaseProjectConfig } from "./types.ts";

const text = z.string().trim().min(1).max(4000);
const absolute = text.refine(isAbsolute, "path must be absolute");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);

/** Release URLs carry no credential, query or fragment, and always use HTTPS. */
export function releaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.search === "" && u.hash === "";
  } catch { return false; }
}
const url = text.refine(releaseUrl, "expected a public HTTPS URL without credentials or query");
function smokePath(path: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9/_.~-]*$/.test(path) && !path.split("/").some(p => p === "." || p === "..");
}
const commands = z.object({ migrate: text, backup: text, restore: text, verify: text }).strict();
const schema = z.object({
  version: z.literal(1), project: id, revision: z.string().regex(/^[a-f0-9]{40}$/),
  provider: z.enum(["vercel", "netlify"]), artifactDir: absolute, artifactHash: hash, siteId: id,
  productionUrl: url.refine(v => new URL(v).pathname === "/", "production URL must be an origin"),
  smokePaths: z.array(text.refine(smokePath, "unsafe smoke path")).min(1).max(50),
  migrations: z.array(text).max(200).default([]),
  rollback: z.object({ deploymentId: id.optional(), url: url.optional(), steps: z.array(text).min(1).max(100) }).strict(),
  data: z.union([z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.enum(["sqlite", "postgres"]), source: absolute, commands }).strict()]),
}).strict();

export function parseManifest(value: unknown): ReleaseManifest {
  return schema.parse(value);
}
/** Setup owns deploy destinations; the runner's fixed-revision build owns the artifact binding. */
export function checkManifest(manifest: ReleaseManifest, config: ReleaseProjectConfig): void {
  if (manifest.project !== config.project || manifest.provider !== config.provider) throw new Error("project setup mismatch");
  if (manifest.siteId !== config.siteId || manifest.productionUrl !== config.productionUrl) throw new Error("deployment target differs from runner setup");
  if (!Object.hasOwn(config.artifacts, manifest.revision) || config.artifacts[manifest.revision] !== manifest.artifactHash) throw new Error("artifact is not bound to this revision");
}
export function manifestHash(manifest: ReleaseManifest): string {
  return createHash("sha256").update(canonical(parseManifest(manifest))).digest("hex");
}
export function releaseRef(manifest: ReleaseManifest, action: ReleaseAction): string {
  return `release:${manifestHash(manifest)}:${action}`;
}
export function parseReleaseRef(ref: unknown): { hash: string; action: ReleaseAction } | undefined {
  if (typeof ref !== "string") return undefined;
  const m = /^release:([a-f0-9]{64}):(preview|promote|rollback)$/.exec(ref);
  return m ? { hash: m[1]!, action: m[2] as ReleaseAction } : undefined;
}

/** Content-address the runner's immutable prebuilt snapshot; never follow a project symlink. */
export function artifactDigest(dir: string): string {
  const files: { path: string; hash: string }[] = [];
  const walk = (path: string, relative: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error("artifact symlink refused");
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), relative ? `${relative}/${name}` : name);
    else if (st.isFile()) files.push({ path: relative, hash: createHash("sha256").update(readFileSync(path)).digest("hex") });
    else throw new Error("artifact must contain regular files only");
  };
  walk(dir, "");
  if (!files.length) throw new Error("empty artifact snapshot");
  return createHash("sha256").update(canonical(files)).digest("hex");
}
