import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeAll } from "../ledger/ledger.ts";

const label = z.string().trim().min(1).max(500);
export const tasteSchema = z.object({
  admired: z.array(label).min(3).max(5), aiMade: label, tone: z.enum(["serious", "playful"]),
  dislikedColors: z.array(label).max(20), dislikedFonts: z.array(label).max(20), platforms: z.array(label).min(1).max(20),
}).strict();
export type TasteProfile = z.infer<typeof tasteSchema>;
export interface TasteOptions { home?: string; rename?: typeof renameSync }

function refuseSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Taste storage refuses symlinks");
}
function tasteDirectory(home: string, create = true): string {
  let directory = resolve(home);
  refuseSymlink(directory);
  for (const name of [".jarvis", "memory", "user"]) {
    directory = join(directory, name);
    refuseSymlink(directory);
    if (create && !lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory, { mode: 0o700 });
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) throw new Error("Taste storage requires directories");
  }
  return directory;
}

function parseTaste(raw: string): TasteProfile {
  try { return tasteSchema.parse(JSON.parse(raw)); } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`).join("; ") : "expected JSON";
    throw new Error(`Invalid taste profile: ${detail}`);
  }
}

/** Read through the CLI, without creating memory or following storage symlinks. */
export function loadTaste(options: Pick<TasteOptions, "home"> = {}): TasteProfile | undefined {
  const directory = tasteDirectory(options.home ?? homedir(), false);
  const target = join(directory, "taste.json");
  refuseSymlink(target);
  let raw: string;
  try { raw = readFileSync(target, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return parseTaste(raw);
}

/** Called from interactive intake, outside sandboxed build sessions; the CLI owns the memory write. */
export function saveTaste(file: string, options: TasteOptions = {}): string {
  const profile = parseTaste(readFileSync(file, "utf8"));
  const directory = tasteDirectory(options.home ?? homedir());
  const target = join(directory, "taste.json");
  refuseSymlink(target);
  const temp = join(directory, `.taste-${randomBytes(16).toString("hex")}.tmp`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeAll(fd, `${JSON.stringify(profile, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    refuseSymlink(target);
    (options.rename ?? renameSync)(temp, target);
    const fdDir = openSync(directory, "r");
    try { fsyncSync(fdDir); } finally { closeSync(fdDir); }
  } finally { rmSync(temp, { force: true }); }
  return target;
}
