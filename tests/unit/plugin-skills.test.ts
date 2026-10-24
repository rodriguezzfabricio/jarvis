import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { namedSkills, repoSkills } from "../plugin-skills.ts";

/** The plugin ships the repo's skills (architecture §3.1, §7): plugin/skills links to ../skills. */
const repoRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const link = join(repoRoot, "plugin", "skills");

describe("plugin skills", () => {
  it("plugin/skills is a relative link to the repo's skills/, so clones and archives keep it", () => {
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../skills");
    expect(realpathSync(link)).toBe(join(repoRoot, "skills"));
  });

  it("every repo skill is reachable through the plugin", () => {
    const skills = repoSkills(repoRoot);
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(readFileSync(join(link, s, "SKILL.md"), "utf8"), s).toBe(readFileSync(join(repoRoot, "skills", s, "SKILL.md"), "utf8"));
    }
  });

  it("every skill /jarvis names as built now is in the plugin", () => {
    const named = namedSkills(repoRoot);
    expect(named.length).toBeGreaterThan(0);
    for (const s of named) expect(existsSync(join(link, s, "SKILL.md")), s).toBe(true);
  });
});
