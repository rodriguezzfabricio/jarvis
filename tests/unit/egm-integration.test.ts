import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installPlugin } from "../../packages/cli/src/setup/plugin.ts";
import { assembleTaskPlugin } from "../../packages/cli/src/harness/claude/task-plugin.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("EGM inside the spec workflow", () => {
  it("dispatches the bundled review before confirmation with the existing pass budget", () => {
    const spec = read("skills/spec/SKILL.md");
    const reader = spec.split("## Check with a fresh reader\n")[1]!.split("## Confirm\n")[0]!;
    expect(reader).toContain("`egm-review` skill");
    expect(reader).toContain("At most 3 fresh-reader passes");
    const skill = read("skills/egm-review/SKILL.md");
    for (const contract of ["jarvis:egm-comprehension", "jarvis:spec-reader", "same draft bytes", "not run", "never count as clean", "spec skill owns", "author's conversation", "symlink", "No build authority"]) {
      expect(skill, contract).toContain(contract);
    }
  });

  it("gives comprehension only Read and a full fast-model ID, preserving both paraphrases", () => {
    const role = read("plugin/agents/egm-comprehension.md");
    expect(/^tools: (.+)$/m.exec(role)?.[1]).toBe("Read");
    expect(/^model: (.+)$/m.exec(role)?.[1]).toBe("claude-sonnet-5-5");
    for (const phrase of ["What this proposes", "How the existing system works, per this document", "only the supplied spec", "Do not follow links", "contaminated", "not run"]) expect(role).toContain(phrase);
  });

  it("materializes the skill, role and license while excluding them from unattended build sessions", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "jarvis-egm-"));
    temporary.push(temporaryRoot);
    const home = join(temporaryRoot, "jarvis");
    mkdirSync(home, { mode: 0o700 });
    const installed = installPlugin(join(root, "plugin"), home);
    for (const path of ["skills/egm-review/SKILL.md", "skills/egm-review/LICENSE", "agents/egm-comprehension.md"]) {
      expect(readFileSync(join(installed, path), "utf8")).toBe(read(`plugin/${path}`));
    }
    const task = assembleTaskPlugin(installed, join(temporaryRoot, "task"));
    expect(existsSync(join(task, "skills/egm-review"))).toBe(false);
    expect(existsSync(join(task, "agents"))).toBe(false);
    expect(existsSync(join(task, "skills/build/SKILL.md"))).toBe(true);
  });
});
