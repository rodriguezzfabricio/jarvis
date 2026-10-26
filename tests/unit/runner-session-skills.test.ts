// Decision 114: task sessions run with an explicit tool list that has no Skill tool (decision 68), so the
// plugin's build and debug skills are listed but can't be loaded. The runner puts their text into the
// runner-owned run header instead, and points a session at a spec only when the checkout has one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { buildRunHeader } from "../../packages/cli/src/runner/prompt.ts";
import { loadSessionSkills, SESSION_SKILLS } from "../../packages/cli/src/runner/session-skills.ts";
import { commitBase, finished, fixture, removeFixtureRoots } from "./helpers/runner-loop-fixture.ts";

afterEach(removeFixtureRoots);

const task = {
  taskId: "T1", goal: "Fix the parser", exitCondition: "AC1 passes in the protected gate",
  acceptanceCriteria: ["AC1"], decisions: [], specPath: "docs/spec/v1.md", mayNotTouch: [".git/config"], maxTurns: 8,
};

describe("session skills", () => {
  it("loads the build and debug skills from the Jarvis repo, without their frontmatter", () => {
    const skills = loadSessionSkills();
    expect(SESSION_SKILLS).toEqual(["build", "debug"]);
    expect(skills.map((s) => s.name)).toEqual(["build", "debug"]);
    const [build, debug] = skills;
    expect(build!.text).toContain("## One command per call");
    expect(build!.text).toContain("## Verify before claiming done");
    expect(debug!.text).toContain("## Isolate the root cause");
    expect(debug!.text).toContain("## Cover every path to the symptom");
    for (const s of skills) {
      expect(s.text.startsWith("---")).toBe(false);
      expect(s.text).not.toMatch(/^description:/m);
    }
  });

  it("refuses a skills folder that is missing a session skill, so no session runs without its rules", () => {
    const f = fixture();
    mkdirSync(join(f.root, "skills", "build"), { recursive: true });
    writeFileSync(join(f.root, "skills", "build", "SKILL.md"), "---\nname: build\ndescription: x\n---\n# Build\n");
    expect(() => loadSessionSkills(join(f.root, "skills"))).toThrow(/debug is missing/);
  });

  it.each([["no frontmatter", "# Debug\nReproduce first.\n"], ["an empty body", "---\nname: debug\ndescription: x\n---\n\n"]])("refuses a session skill with %s", (_label, text) => {
    const f = fixture();
    for (const name of ["build", "debug"]) mkdirSync(join(f.root, "skills", name), { recursive: true });
    writeFileSync(join(f.root, "skills", "build", "SKILL.md"), "---\nname: build\ndescription: x\n---\n# Build\n");
    writeFileSync(join(f.root, "skills", "debug", "SKILL.md"), text);
    expect(() => loadSessionSkills(join(f.root, "skills"))).toThrow(/debug has no frontmatter or no body/);
  });

  it("puts each skill's text in the run header, after the task, and says why", () => {
    const header = buildRunHeader({ ...task, runId: "run-1", specVersion: 1, skills: loadSessionSkills() });
    expect(header).toContain("Task: T1");
    expect(header).toContain("no Skill tool");
    expect(header.indexOf("Task: T1")).toBeLessThan(header.indexOf("## One command per call"));
    expect(header).toContain("## One command per call");
    expect(header).toContain("## Cover every path to the symptom");
    expect(header).toMatch(/<skill name="build">[\s\S]*<\/skill>[\s\S]*<skill name="debug">[\s\S]*<\/skill>/);
  });

  it("gives every loop session a run header that carries both skills", async () => {
    const f = fixture();
    const headers: string[] = [];
    f.setBody(async (input) => { headers.push(readFileSync(input.runHeaderPath!, "utf8")); writeFileSync(join(input.workspace, "T1.txt"), "built"); return finished(); });
    expect((await runLoop(f.options)).status).toBe("complete");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("## One command per call");
    expect(headers[0]).toContain("## Cover every path to the symptom");
  });
});

describe("the spec a session is pointed at", () => {
  it("says there is no spec when the checkout has none, instead of naming a missing file", async () => {
    const f = fixture();
    const prompts: string[] = [];
    f.setBody(async (input) => { prompts.push(input.prompt); writeFileSync(join(input.workspace, "T1.txt"), "built"); return finished(); });
    await runLoop(f.options);
    expect(prompts[0]).not.toContain("docs/spec/v1.md");
    expect(prompts[0]).toMatch(/^Spec: none/m);
  });

  it("names the spec when the checkout has it", async () => {
    const f = fixture();
    mkdirSync(join(f.repoPath, "docs", "spec"), { recursive: true });
    commitBase(f, { "docs/spec/v1.md": "# spec\n" });
    const prompts: string[] = [];
    f.setBody(async (input) => { prompts.push(input.prompt); writeFileSync(join(input.workspace, "T1.txt"), "built"); return finished(); });
    await runLoop(f.options);
    expect(prompts[0]).toMatch(/^Spec: docs\/spec\/v1\.md$/m);
  });
});
