import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The skills plugin/commands/jarvis.md names without a "(stage N)" mark: the ones built now, which the
 * installed plugin must carry (tests/unit/jarvis-command.test.ts checks the marks themselves).
 */
export function namedSkills(repoRoot: string): string[] {
  const text = readFileSync(join(repoRoot, "plugin", "commands", "jarvis.md"), "utf8");
  return [...new Set([...text.matchAll(/`([a-z][a-z-]*)` skill(?! \(stage \d+\))/g)].map((m) => m[1] as string))];
}

/** Every skill in the repo's skills/ folder (a directory with a SKILL.md). */
export function repoSkills(repoRoot: string): string[] {
  const dir = join(repoRoot, "skills");
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md"))).map((e) => e.name).sort();
}
