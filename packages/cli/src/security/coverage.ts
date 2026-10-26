import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

// Matches the protected JS/TS, Python and Go rules, including Node's module extensions.
const extensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".pyi", ".go"]);
// Node-ecosystem runners (tsx, bun, deno, npx) execute JS/TS too; pinned Semgrep skips every extensionless file.
const interpreters = /^(?:node|nodejs|js|ts-node(?:-esm)?|tsx|bun|deno|npx|python(?:[23](?:\.\d+)?)?|pypy3?)$/;
const invalid = (): never => { throw Error("Invalid scanner output"); };

/** Skip metadata is checked with the required positive coverage evidence, never instead of it. */
export function semgrepScannedPaths(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const output = raw as Record<string, unknown>;
  if (!output.paths || typeof output.paths !== "object" || Array.isArray(output.paths)) return invalid();
  const paths = output.paths as Record<string, unknown>;
  if (paths.skipped !== undefined && (!Array.isArray(paths.skipped) || paths.skipped.length !== 0)) invalid();
  if (output.skipped_targets !== undefined && (!Array.isArray(output.skipped_targets) || output.skipped_targets.length !== 0)) invalid();
  if (!Array.isArray(paths.scanned) || paths.scanned.some((path) => typeof path !== "string" || path.length === 0 || path.includes("\0"))) return invalid();
  return paths.scanned as string[];
}

function shebangRunners(path: string): string[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Error("Not a regular file");
    const buffer = Buffer.alloc(4096);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString("utf8");
    if (!text.startsWith("#!")) return [];
    if (!text.includes("\n") && bytes === buffer.length) throw Error("Shebang exceeds read bound");
    const words = text.split("\n", 1)[0]!.slice(2).trim().split(/\s+/);
    const command = basename(words.shift() ?? "");
    if (command !== "env") return [command];
    // env takes options (-S, -i, -u NAME), NAME=value pairs and wrappers (pnpm exec) before the interpreter,
    // so any later word naming a covered runner counts; executable bits do not affect coverage.
    return words.map((word) => basename(word));
  } finally { closeSync(fd); }
}

function coveredShebang(path: string): boolean {
  const words = shebangRunners(path);
  return words.some((word) => interpreters.test(basename(word)));
}

/** Only known language aliases are remapped; ordinary missing files must still fail coverage. */
export function mappedSemgrepExtension(path: string): string | undefined {
  const original = extname(path); const extension = original.toLowerCase();
  if (extension === ".mts" || extension === ".cts") return ".ts";
  if (extensions.has(extension) && original !== extension) return extension;
  if (extension !== "") return undefined;
  const runners = shebangRunners(path);
  if (runners.some((runner) => /^(?:ts-node(?:-esm)?|tsx|bun|deno|npx)$/.test(runner))) return ".ts";
  if (runners.some((runner) => /^(?:node|nodejs|js)$/.test(runner))) return ".js";
  if (runners.some((runner) => /^(?:python(?:[23](?:\.\d+)?)?|pypy3?)$/.test(runner))) return ".py";
  return undefined;
}

export function coveredFiles(root: string): string[] {
  const files: string[] = []; const pending = [""];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const name of readdirSync(join(root, dir))) {
      if (name === ".git") continue;
      const path = join(dir, name); const absolute = join(root, path); const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw Error("Coverage cannot follow symlinks");
      if (stat.isDirectory()) { pending.push(path); continue; }
      if (!stat.isFile()) throw Error("Coverage requires regular files");
      const extension = extname(name).toLowerCase();
      if (extensions.has(extension) || (extension === "" && coveredShebang(absolute))) files.push(path);
    }
  }
  return files.sort();
}

/** A bounded diagnostic, with no scanner snippets or filesystem error text. */
export function semgrepCoverage(cwd: string, scanned: readonly string[]): string | undefined {
  try {
    const reported = new Set(scanned.map((path) => resolve(cwd, path)));
    const missing = coveredFiles(cwd).filter((path) => !reported.has(resolve(cwd, path)));
    if (missing.length === 0) return undefined;
    return `semgrep coverage missing: ${JSON.stringify(missing.slice(0, 20))}${missing.length > 20 ? ` (+${missing.length - 20} more)` : ""}`;
  } catch { return "semgrep coverage unavailable"; }
}
