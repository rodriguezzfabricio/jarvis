import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LedgerEntry } from "../ledger/ledger.ts";
import { parseManifest } from "./manifest.ts";
import { recordObservation } from "./states.ts";
import { realChild } from "./paths.ts";
import type { RehearsalInput, ReleaseProjectConfig } from "./types.ts";

/** Trusted project config supplies the consistent SQLite export/Postgres dump, never a manifest. */
export function createDataSnapshot(config: ReleaseProjectConfig): { kind: "sqlite" | "postgres"; source: string } {
  const data = config.dataSnapshot;
  if (!data || !isAbsolute(config.snapshotRoot) || !isAbsolute(data.source)) throw new Error("runner snapshot configuration required");
  const st = lstatSync(data.source);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("configured snapshot source must be a regular file");
  mkdirSync(config.snapshotRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(realpathSync(config.snapshotRoot), "data-"));
  const source = join(dir, "snapshot");
  try { copyFileSync(data.source, source); chmodSync(source, 0o600); }
  catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  return { kind: data.kind, source };
}

/** Project commands run only through the runner's isolated copy executor, never as host shell code. */
export async function runRehearsal(input: RehearsalInput): Promise<{ rehearsal: LedgerEntry; restore: LedgerEntry }> {
  const { ledger } = input;
  const manifest = parseManifest(input.manifest);
  const data = manifest.data;
  if (data.kind === "none") return {
    rehearsal: recordObservation(ledger, manifest, "rehearsal", "pass", { applicable: false }),
    restore: recordObservation(ledger, manifest, "restore", "pass", { applicable: false }),
  };
  if (!isAbsolute(input.workRoot)) throw new Error("workRoot must be absolute");
  mkdirSync(input.workRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(input.workRoot, "rehearsal-"));
  const copy = join(dir, "data-copy");
  const backup = join(dir, "backup");
  const restored = join(dir, "restored-copy");
  const observations: Record<string, unknown>[] = [];
  const command = async (step: keyof typeof data.commands, target: string): Promise<boolean> => {
    try {
      const outcome = await input.execute({ command: data.commands[step], cwd: dir, timeoutMs: input.timeoutMs ?? 60_000,
        env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir, JARVIS_DATA_COPY: target, JARVIS_BACKUP: backup, JARVIS_RESTORE: restored },
        isolation: { readOnlySource: copy, writableRoot: dir, network: "none", credentials: "none", database: data.kind } });
      observations.push({ step, code: outcome.code, timedOut: outcome.timedOut,
        stdoutBytes: Buffer.byteLength(outcome.stdout), stdoutHash: createHash("sha256").update(outcome.stdout).digest("hex"),
        stderrBytes: Buffer.byteLength(outcome.stderr), stderrHash: createHash("sha256").update(outcome.stderr).digest("hex") });
      return outcome.code === 0 && !outcome.timedOut && !outcome.overflowed;
    } catch {
      observations.push({ step, status: "executor-error" });
      return false;
    }
  };
  let migrated = false;
  let recovered = false;
  try {
    const source = realChild(input.snapshotRoot, data.source);
    const st = lstatSync(data.source);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("source must be a regular snapshot file");
    const original = readFileSync(source);
    copyFileSync(source, copy);
    migrated = await command("migrate", copy) && await command("verify", copy);
    // A restore targets a separate, initially absent location; the migrated database remains intact.
    recovered = migrated && await command("backup", copy) && existsSync(backup)
      && await command("restore", restored) && existsSync(restored) && await command("verify", restored);
    if (!readFileSync(source).equals(original)) {
      migrated = false; recovered = false;
      observations.push({ status: "source-changed" });
    }
  } catch { observations.push({ status: "copy-error" }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return { rehearsal: recordObservation(ledger, manifest, "rehearsal", migrated ? "pass" : "fail", { observations }),
    restore: recordObservation(ledger, manifest, "restore", recovered ? "pass" : "fail", { observations }) };
}
