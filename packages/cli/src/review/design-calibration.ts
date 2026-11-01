import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { checkTrustedDir, readNoFollow, writePrivateAtomic } from "../config/private-file.ts";
import { verifyLedger, type LedgerEntry } from "../ledger/ledger.ts";
import { readPlanningFile } from "../runner/checks-author.ts";

export interface DesignCalibration { generic: string; good: string }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const RecordSchema = z.object({version:z.literal(1),model:z.string(),policyHash:hash,ledgerFile:z.string(),generic:hash,good:hash}).strict();
export type DesignCalibrationRecord = z.infer<typeof RecordSchema>;

/** Both the record and its ledger must stay under the runner home, with no writable or symlink ancestry. */
export function calibrationEntries(jarvisHome: string, ledgerFile: string): LedgerEntry[] {
  const root = realpathSync(jarvisHome), file = resolve(ledgerFile);
  if (!file.startsWith(`${root}/`) || !file.endsWith("/ledger.jsonl")) throw new Error("calibration ledger must be runner-owned");
  checkTrustedDir(jarvisHome);
  let directory = root;
  for (const part of relative(root, dirname(file)).split("/").filter(Boolean)) {
    directory = join(directory, part); checkTrustedDir(directory);
  }
  for (const path of [file, join(directory, "head.hash")]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()) throw new Error("calibration ledger files must be runner-owned");
    readNoFollow(path);
  }
  const verified = verifyLedger(directory);
  if (!verified.ok || verified.repairable.length) throw new Error("calibration ledger failed verification");
  return verified.entries;
}

export function readDesignCalibration(jarvisHome: string): {record: DesignCalibrationRecord; entries: LedgerEntry[]} | undefined {
  try {
    checkTrustedDir(jarvisHome);
    const record = RecordSchema.parse(JSON.parse(readPlanningFile(realpathSync(jarvisHome), "design-calibration.json")));
    return {record, entries: calibrationEntries(jarvisHome, record.ledgerFile)};
  } catch { return undefined; }
}

/** Called only after the service has checked both control verdicts against the current policy. */
export function writeDesignCalibration(jarvisHome: string, record: DesignCalibrationRecord): void {
  writePrivateAtomic(join(jarvisHome, "design-calibration.json"), JSON.stringify(RecordSchema.parse(record)) + "\n");
}
