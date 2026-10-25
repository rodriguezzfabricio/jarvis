import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const OSV_ECOSYSTEMS = ["npm", "Go", "PyPI"] as const;
export type OsvEcosystem = (typeof OSV_ECOSYSTEMS)[number];
export interface OsvDatabaseManifest {
  schema: 1;
  scannerVersion: string;
  fetchedAt: string;
  ecosystems: OsvEcosystem[];
  files: { path: string; sha256: string }[];
}
const names: Record<OsvEcosystem, readonly string[]> = {
  npm: ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"],
  Go: ["go.mod", "go.sum"],
  PyPI: ["pyproject.toml", "requirements.txt", "requirements.in", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "setup.py", "setup.cfg"],
};
const skipped = new Set([".git", "node_modules", ".venv", "venv", "vendor", "__pycache__"]);

export function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Inventory only; never import a manifest, execute a package manager, or traverse a symlink. */
export function detectOsvEcosystems(projectDir: string): OsvEcosystem[] {
  const found = new Set<OsvEcosystem>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !skipped.has(entry.name)) walk(join(dir, entry.name));
      if (entry.isFile()) for (const ecosystem of OSV_ECOSYSTEMS) {
        if (names[ecosystem].includes(entry.name) || (ecosystem === "PyPI" && /^requirements[-.].*\.txt$/.test(entry.name))) found.add(ecosystem);
      }
    }
  };
  walk(projectDir);
  return OSV_ECOSYSTEMS.filter((ecosystem) => found.has(ecosystem));
}

/** Cache files keep OSV's own layout. Hashes also make incomplete downloads fail closed. */
export function hashOsvDatabase(dir: string): OsvDatabaseManifest["files"] {
  const files: OsvDatabaseManifest["files"] = [];
  const walk = (folder: string) => {
    if (lstatSync(folder).isSymbolicLink()) throw Error("OSV database may not contain symlinks");
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error("OSV database may not contain symlinks");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && path !== join(dir, "manifest.json")) files.push({ path: relative(dir, path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
      else if (!stat.isFile()) throw Error("Invalid OSV database file");
    }
  };
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The manifest must name the pinned scanner version that fetched it (decision 103; backlog 96). */
export function osvDatabaseReady(dir: string, ecosystems: readonly OsvEcosystem[], scannerVersion: string): boolean {
  try {
    if (!isAbsolute(dir) || lstatSync(dir).isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as OsvDatabaseManifest;
    if (manifest.schema !== 1 || manifest.scannerVersion !== scannerVersion || !Array.isArray(manifest.ecosystems) || !ecosystems.every((ecosystem) => manifest.ecosystems.includes(ecosystem))) return false;
    const files = hashOsvDatabase(realpathSync(dir));
    return files.length > 0 && JSON.stringify(files) === JSON.stringify(manifest.files);
  } catch { return false; }
}
