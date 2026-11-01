import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Stats } from "node:fs";
import { join, relative } from "node:path";
import { atomicWrite, canonical, type Ledger } from "../ledger/ledger.ts";

/** Existing installer namespaces stay stable: cases can read fixtures, never the verifier copy. */
const RUNTIME_ROOTS = ["qa-toolchain", "fixtures/qa-toolchain", "design-runtime", "fixtures/design-runtime", "design-lint", "fixtures/design-lint", "security", "fixtures/security", "desktop", "fixtures/desktop"];
const PROTECTED_FILES = [
  "design-review.json", "design-plan.json", "design-checks.json", "fixtures/design-plan.json", "fixtures/impeccable.json",
  // The runner's axe baseline for the base revision (decision 125); nothing an architect writes may stand in for it.
  "expected/axe-base.json",
  ...["impeccable-source", "impeccable-url", "design-browser", "ai-tells", "token-lint", "design-md-lint"].map(name => `${name}.check.json`),
];
const inRoots = (file: string, roots: readonly string[]) => roots.some(root => file === root || file.startsWith(`${root}/`));
/**
 * Reserved for reviewed protected installers, never for architect-authored changes: each reserved name and
 * everything below it, in any letter case, because the default APFS volume folds case and `Design-Runtime`
 * is the same folder as `design-runtime` (decision 162). The installers write only lower-case ASCII names.
 */
export const protectedCheckPath = (file: string): boolean => inRoots(file.toLowerCase(), [...RUNTIME_ROOTS, ...PROTECTED_FILES]);
export const CHECK_RUNTIME_LIMITS = { fileBytes: 256 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, files: 4096, directories: 4096, depth: 32 } as const;

/** Hash bytes in chunks: binary runtimes never become text or a file-sized allocation. */
function hashFile(path: string, before: Stats): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const start = fstatSync(fd);
    if (!start.isFile() || start.nlink !== 1 || start.dev !== before.dev || start.ino !== before.ino || start.size !== before.size) throw new Error("check file changed during hash");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n;
      if (bytes > start.size) throw new Error("check file grew during hash");
      hash.update(buffer.subarray(0, n));
    }
    const end = fstatSync(fd), current = lstatSync(path);
    if (bytes !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs || current.ino !== start.ino || current.dev !== start.dev || current.isSymbolicLink()) throw new Error("check file changed during hash");
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

/** Bounded runtime hashing shared by the live store and an installer staging directory. */
export function hashCheckArtifacts(checksDir: string, runtimeRoot = false): Record<string, string> {
  const runtimePath = (name: string) => runtimeRoot || inRoots(name.toLowerCase(), RUNTIME_ROOTS);
  // No prototype: a check file named __proto__ must be an ordinary key (Codex stage 0 review 5).
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const files: { path: string; name: string; stat: Stats }[] = [];
  const directories: { path: string; stat: Stats }[] = [];
  let runtimeBytes = 0, runtimeFiles = 0, runtimeDirs = 0;
  const walk = (dir: string, depth: number) => {
    const stat = lstatSync(dir), name = relative(checksDir, dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("check directories may not be symlinks");
    if (runtimePath(name) && (++runtimeDirs > CHECK_RUNTIME_LIMITS.directories || depth > CHECK_RUNTIME_LIMITS.depth)) throw new Error("check runtime directory limit exceeded");
    directories.push({ path: dir, stat });
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name), name = relative(checksDir, path), st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`check files may not be symlinks: ${name}`);
      if (st.isDirectory()) walk(path, depth + 1);
      else {
        if (!st.isFile() || st.nlink !== 1) throw new Error(`check files must be regular without hard links: ${name}`);
        if (runtimePath(name)) {
          runtimeBytes += st.size;
          if (st.size > CHECK_RUNTIME_LIMITS.fileBytes || runtimeBytes > CHECK_RUNTIME_LIMITS.totalBytes || ++runtimeFiles > CHECK_RUNTIME_LIMITS.files) throw new Error("check runtime byte or file count limit exceeded");
        }
        files.push({ path, name, stat: st });
      }
    }
  };
  if (lstatSync(checksDir, { throwIfNoEntry: false })) walk(checksDir, 0);
  for (const file of files) out[file.name] = hashFile(file.path, file.stat);
  for (const before of directories) {
    const after = lstatSync(before.path);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.stat.dev || after.ino !== before.stat.ino || after.mtimeMs !== before.stat.mtimeMs || after.ctimeMs !== before.stat.ctimeMs) throw new Error("check directory changed during hash");
  }
  return out;
}

/**
 * Protected checks (decisions 15, 49): acceptance tests, test config and gate scripts live in the
 * runner-owned project folder. checks.lock holds each file's hash, and the ledger holds the hash of
 * the approved lock, so editing a check, or a check and the lock together, is detected before any run.
 */
export class ChecksStore {
  readonly checksDir: string;
  readonly lockPath: string;
  constructor(projectDir: string) {
    this.checksDir = join(projectDir, "checks");
    this.lockPath = join(projectDir, "checks.lock");
  }

  hashAll(): Record<string, string> { return hashCheckArtifacts(this.checksDir); }

  /** Records the current check files as approved (from the approved spec, or a reviewed change). */
  approve(ledger: Ledger, reason: string): { lockHash: string } {
    const files = this.hashAll();
    const content = canonical({ files });
    atomicWrite(this.lockPath, content);
    const lockHash = createHash("sha256").update(content).digest("hex");
    ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash, files, reason } });
    return { lockHash };
  }

  /** Needs only verified entries, so a reader with no ledger writer can check the store too. */
  verify(ledger: Pick<Ledger, "entries">): { ok: boolean; problems: string[]; lockHash: string | undefined } {
    const problems: string[] = [];
    if (!existsSync(this.lockPath)) return { ok: false, problems: ["no checks.lock: checks were never approved"], lockHash: undefined };
    const content = readFileSync(this.lockPath, "utf8");
    const lockHash = createHash("sha256").update(content).digest("hex");
    const approved = ledger.entries().filter((e) => e.kind === "checks_approved").at(-1);
    if (!approved || (approved.data as { lockHash?: string }).lockHash !== lockHash) problems.push("checks.lock is not the approved lock recorded in the ledger");
    let locked: Record<string, string> = Object.create(null) as Record<string, string>;
    try {
      const parsed = (JSON.parse(content) as { files?: Record<string, string> }).files ?? {};
      for (const k of Object.keys(parsed)) locked[k] = parsed[k] as string;
    } catch {
      problems.push("checks.lock is not valid JSON");
    }
    let now: Record<string, string>;
    try { now = this.hashAll(); }
    catch (error) { return { ok: false, problems: [...problems, error instanceof Error ? error.message : String(error)], lockHash }; }
    for (const [f, h] of Object.entries(locked)) {
      if (!Object.hasOwn(now, f)) problems.push(`check removed: ${f}`);
      else if (now[f] !== h) problems.push(`check changed: ${f}`);
    }
    for (const f of Object.keys(now)) if (!Object.hasOwn(locked, f)) problems.push(`check added: ${f}`);
    return { ok: problems.length === 0, problems, lockHash };
  }
}
