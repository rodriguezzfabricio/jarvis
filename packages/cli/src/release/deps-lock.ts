import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, visit } from "yaml";

export interface DependencyPlan { manager: "npm" | "pnpm"; version: string; lockfile: string }
type ObjectValue = Record<string, unknown>;
const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dependency lockfile needs an object");
  return value as ObjectValue;
}
function textFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("dependency input must be a regular file");
    if (st.size > 8 * 1024 * 1024) throw new Error("dependency input size limit exceeded");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function requiredFile(root: string, name: string): string {
  const path = join(root, name), st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`committed ${name} lockfile required`);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`${name} must be a regular file`);
  return textFile(path);
}
function registrySpec(value: unknown): void {
  if (typeof value !== "string" || !/^(?:[~^<>=*v\d][a-zA-Z0-9.*+~^<>=| -]*|latest|next)$/.test(value)) {
    throw new Error("only public registry version specifications are allowed");
  }
}
function groups(value: ObjectValue): void {
  for (const group of GROUPS) {
    if (value[group] === undefined) continue;
    for (const [name, spec] of Object.entries(object(value[group]))) {
      if (!NAME.test(name)) throw new Error("invalid registry dependency name");
      registrySpec(spec);
    }
  }
}
function integrity(value: unknown): void {
  if (typeof value !== "string" || !/^(?:sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/.test(value)) throw new Error("dependency integrity required (sha256 or sha512)");
}
function matchingGroups(manifest: ObjectValue, root: ObjectValue): void {
  for (const group of GROUPS) {
    const actual = object(manifest[group] ?? {}), locked = object(root[group] ?? {});
    if (Object.keys(actual).length !== Object.keys(locked).length || Object.entries(actual).some(([k, v]) => locked[k] !== v)) throw new Error("manifest and lockfile dependency specifications must match");
  }
}
function npmLock(raw: string, manifest: ObjectValue): void {
  const lock = object(JSON.parse(raw));
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) throw new Error("npm lockfile version 2 or 3 required");
  const packages = object(lock.packages);
  matchingGroups(manifest, object(packages[""]));
  for (const [path, value] of Object.entries(packages)) {
    const pkg = object(value); groups(pkg);
    if (path === "") continue;
    if (!/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(path) || pkg.link || pkg.inBundle) throw new Error("only registry packages, no links or bundled dependencies");
    const name = path.slice(path.lastIndexOf("node_modules/") + 13);
    if (typeof pkg.version !== "string" || !VERSION.test(pkg.version)) throw new Error("registry package needs an exact version");
    const base = name.slice(name.lastIndexOf("/") + 1);
    if (pkg.resolved !== `https://registry.npmjs.org/${name}/-/${base}-${pkg.version}.tgz`) throw new Error("dependency resolution must be a canonical public npm registry tarball");
    integrity(pkg.integrity);
  }
  // v2 also carries a legacy resolution tree; inspect every entry rather than letting a second representation hide a URL.
  const legacy = (value: unknown, depth = 0): void => {
    if (depth > 64) throw new Error("dependency lockfile depth limit exceeded");
    for (const [name, entry] of Object.entries(object(value))) {
      const pkg = object(entry);
      if (!NAME.test(name) || typeof pkg.version !== "string" || !VERSION.test(pkg.version) || pkg.resolved !== `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${pkg.version}.tgz`) throw new Error("legacy dependency must use the public npm registry");
      integrity(pkg.integrity);
      if (pkg.requires) for (const spec of Object.values(object(pkg.requires))) registrySpec(spec);
      if (pkg.dependencies) legacy(pkg.dependencies, depth + 1);
    }
  };
  if (lock.dependencies) legacy(lock.dependencies);
}
function pnpmLock(raw: string, manifest: ObjectValue): void {
  const doc = parseDocument(raw, { schema: "core", uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error("invalid lockfile YAML");
  visit(doc, (_key, node) => { if (node && typeof node === "object" && "anchor" in node && node.anchor) throw new Error("lockfile YAML anchors refused"); });
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 0 }); } catch { throw new Error("lockfile YAML aliases refused"); }
  const lock = object(value);
  if (String(lock.lockfileVersion) !== "9.0" && lock.lockfileVersion !== 9) throw new Error("pnpm lockfile version 9 required");
  if (Object.keys(lock).some(k => !["lockfileVersion", "settings", "importers", "packages", "snapshots"].includes(k))) throw new Error("pnpm lockfile configuration refused");
  const importers = object(lock.importers);
  if (Object.keys(importers).length !== 1 || !Object.hasOwn(importers, ".")) throw new Error("workspace configuration refused");
  const root = object(importers["."]), specs: ObjectValue = {};
  for (const group of GROUPS) {
    specs[group] = Object.fromEntries(Object.entries(object(root[group] ?? {})).map(([name, entry]) => {
      const dep = object(entry); reference(dep.version); return [name, dep.specifier];
    }));
  }
  matchingGroups(manifest, specs);
  for (const [key, value] of Object.entries(object(lock.packages ?? {}))) {
    const at = key.lastIndexOf("@"), name = key.slice(0, at), version = key.slice(at + 1);
    if (!NAME.test(name) || !VERSION.test(version)) throw new Error("pnpm package must use a registry name and exact version");
    // pnpm 11 has a built-in @jsr registry at npm.jsr.io, even with an empty HOME.
    if (name.startsWith("@jsr/")) throw new Error("pnpm built-in non-npm registry scope refused");
    const resolution = object(object(value).resolution);
    if (Object.keys(resolution).some(k => k !== "integrity")) throw new Error("pnpm registry resolution refuses tarball, git and local entries");
    integrity(resolution.integrity);
  }
  for (const [key, value] of Object.entries(object(lock.snapshots ?? {}))) {
    reference(key.slice(key.indexOf("@", key.startsWith("@") ? 1 : 0) + 1));
    for (const group of GROUPS) for (const [name, version] of Object.entries(object(object(value)[group] ?? {}))) {
      if (!NAME.test(name)) throw new Error("invalid registry dependency name");
      reference(version);
    }
  }
}
function reference(value: unknown): void {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+[a-zA-Z0-9.+_()@/=-]*$/.test(value) || value.includes("..")) throw new Error("pnpm reference must be a registry version");
}

/** Called only on the fresh committed release checkout, before any package manager or build runs. */
export function readDependencyPlan(checkout: string): DependencyPlan | undefined {
  const manifestPath = join(checkout, "package.json");
  if (!lstatSync(manifestPath, { throwIfNoEntry: false })) return undefined;
  const manifest = object(JSON.parse(requiredFile(checkout, "package.json")));
  const declaration = typeof manifest.packageManager === "string" ? /^(npm|pnpm)@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager) : null;
  if (!declaration) throw new Error("packageManager must declare npm or pnpm at an exact pinned version");
  const manager = declaration[1] as "npm" | "pnpm";
  const lockfile = manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  const raw = requiredFile(checkout, lockfile);
  for (const name of [".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs", "pnpm-workspace.yaml", "npm-shrinkwrap.json", manager === "npm" ? "pnpm-lock.yaml" : "package-lock.json"]) {
    if (lstatSync(join(checkout, name), { throwIfNoEntry: false })) throw new Error("project package-manager configuration refused");
  }
  if (manifest.engines && Object.keys(object(manifest.engines)).some(key => !["node", "npm", "pnpm"].includes(key))) throw new Error("automatic runtime configuration refused");
  if (manifest.pnpm || manifest.workspaces || manifest.overrides || manifest.resolutions || manifest.devEngines || manifest.config) throw new Error("project package-manager configuration refused");
  if (lstatSync(join(checkout, "node_modules"), { throwIfNoEntry: false })) throw new Error("committed node_modules refused");
  groups(manifest);
  if (manager === "npm") npmLock(raw, manifest); else pnpmLock(raw, manifest);
  return { manager, version: declaration[2]!, lockfile };
}
