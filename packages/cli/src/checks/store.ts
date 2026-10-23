import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { atomicWrite, canonical, type Ledger } from "../ledger/ledger.ts";

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

  hashAll(): Record<string, string> {
    // No prototype: a check file named __proto__ must be an ordinary key (Codex stage 0 review 5).
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) throw new Error(`check files may not be symlinks: ${relative(this.checksDir, p)}`);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) out[relative(this.checksDir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    };
    if (existsSync(this.checksDir)) walk(this.checksDir);
    return out;
  }

  /** Records the current check files as approved (from the approved spec, or a reviewed change). */
  approve(ledger: Ledger, reason: string): { lockHash: string } {
    const files = this.hashAll();
    const content = canonical({ files });
    atomicWrite(this.lockPath, content);
    const lockHash = createHash("sha256").update(content).digest("hex");
    ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash, files, reason } });
    return { lockHash };
  }

  verify(ledger: Ledger): { ok: boolean; problems: string[]; lockHash: string | undefined } {
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
    const now = this.hashAll();
    for (const [f, h] of Object.entries(locked)) {
      if (!Object.hasOwn(now, f)) problems.push(`check removed: ${f}`);
      else if (now[f] !== h) problems.push(`check changed: ${f}`);
    }
    for (const f of Object.keys(now)) if (!Object.hasOwn(locked, f)) problems.push(`check added: ${f}`);
    return { ok: problems.length === 0, problems, lockHash };
  }
}
