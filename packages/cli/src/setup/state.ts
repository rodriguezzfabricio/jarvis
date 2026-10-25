import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { checkTrustedDir, privateDir, readNoFollow, refuseSymlink, writePrivateAtomic, type PrivateWriteOptions, type TrustOptions } from "../config/private-file.ts";

/** The steps of jarvis setup, in the order they run (architecture §3.2, decision 43). */
export const STEPS = ["claude", "secrets", "accounts.github", "accounts.deploy", "accounts.neon", "accounts.cloudflare", "accounts.expo", "accounts.oauth", "ntfy", "taste", "plugin"] as const;
export type StepName = (typeof STEPS)[number];
export const ACCOUNT_STEPS = STEPS.filter((s) => s.startsWith("accounts."));

const secretRecord = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]*$/), tier: z.enum(["preview", "production"]), brokerOnly: z.boolean() }).strict();
const stepRecord = z.object({
  status: z.enum(["done", "skipped", "failed"]),
  at: z.string(),
  detail: z.string(),
  provider: z.string().optional(),
  /** Key names and tiers only. Values live in the secrets backend and nowhere else. */
  secrets: z.array(secretRecord).optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), steps: z.partialRecord(z.enum(STEPS), stepRecord) }).strict();
export type StepRecord = z.infer<typeof stepRecord>;
export type SetupState = z.infer<typeof stateSchema>;

/** Done and skipped are both finished: a re-run passes over them unless --redo names them. Failed runs again. */
export function isFinished(record: StepRecord | undefined): boolean {
  return record?.status === "done" || record?.status === "skipped";
}

/** ~/.jarvis, created owner-only if missing. The home folder and ~/.jarvis must be ours and writable only by us. */
export function jarvisHome(home: string, options: TrustOptions = {}): string {
  const root = resolve(home);
  checkTrustedDir(root, options);
  return privateDir(join(root, ".jarvis"), options);
}

export const statePath = (jarvisHomeDir: string) => join(jarvisHomeDir, "setup-state.json");

export function loadState(jarvisHomeDir: string): SetupState {
  const path = statePath(jarvisHomeDir);
  refuseSymlink(path);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return { version: 1, steps: {} };
  if (!st.isFile()) throw new Error(`${path} must be a regular file`);
  try {
    return stateSchema.parse(JSON.parse(readNoFollow(path)));
  } catch {
    throw new Error(`${path} is not a valid setup state; fix or remove it (finished steps would otherwise run again)`);
  }
}

export function saveState(jarvisHomeDir: string, state: SetupState, options: PrivateWriteOptions = {}): void {
  writePrivateAtomic(statePath(jarvisHomeDir), `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`, options);
}
