import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The skills every build-loop session follows (decision 114). Task sessions run with an explicit tool
 * list that has no Skill tool (decision 68), so a plugin's skills are listed but can't be loaded: the
 * runner puts their text in the runner-owned run header instead. Read from the Jarvis install, which no
 * session can write, never from the project's checkout.
 */
export const SESSION_SKILLS = ["build", "debug"] as const;
export interface SessionSkill { name: string; text: string }

const SKILLS_DIR = fileURLToPath(new URL("../../../../skills/", import.meta.url));
/** Decision 30's size limit for one skill. */
const MAX_SKILL_BYTES = 20 * 1024;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

/** Each session skill's body, without its frontmatter; refuses a missing, empty or oversized skill. */
export function loadSessionSkills(dir: string = SKILLS_DIR): SessionSkill[] {
  return SESSION_SKILLS.map((name) => {
    let raw: string;
    try { raw = readFileSync(join(dir, name, "SKILL.md"), "utf8"); } catch { throw new Error(`session skill ${name} is missing from ${dir}`); }
    if (Buffer.byteLength(raw) > MAX_SKILL_BYTES) throw new Error(`session skill ${name} is over ${MAX_SKILL_BYTES} bytes`);
    const text = raw.replace(FRONTMATTER, "").trim();
    if (!FRONTMATTER.test(raw) || !text) throw new Error(`session skill ${name} has no frontmatter or no body`);
    return { name, text };
  });
}
