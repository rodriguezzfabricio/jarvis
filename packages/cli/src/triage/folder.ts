import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FolderState } from "./triage.ts";

/** Entries that don't make a folder a project: version control, Jarvis's own views, tool settings, Finder litter. */
const IGNORED = new Set([".git", ".jarvis", ".claude", ".DS_Store"]);

/**
 * What triage reads from the project folder (architecture §2): whether it's empty (a new product)
 * and whether a DESIGN.md sits at its root (the design skill writes it there). A symlinked
 * DESIGN.md doesn't count: it may point anywhere.
 */
export function readFolder(dir: string): FolderState {
  if (!statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const entries = readdirSync(dir).filter((name) => !IGNORED.has(name));
  const design = entries.includes("DESIGN.md") ? lstatSync(join(dir, "DESIGN.md")) : undefined;
  return { empty: entries.length === 0, designMd: design?.isFile() === true };
}
