import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs hook without types
import { check } from "../../plugin/hooks/tripwire.mjs";
import { envFileSecrets } from "../../packages/cli/src/broker/secrets.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtp-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bash = (command: string) => check({ tool_name: "Bash", tool_input: { command } });

describe("plugin tripwire (decision 12, layer 3)", () => {
  it("blocks hard-stop commands", () => {
    for (const c of [
      "git push --force origin main", "git push -f", "git push origin main",
      "rm -rf ~/", "rm -rf /", "rm -fr $HOME",
      "vercel deploy --prod", "netlify deploy --prod --dir=out",
      "npm publish", "pnpm publish --access public",
      "npx drizzle-kit push", "prisma db push",
      "gh repo create x --private", "sendmail jane@example.com < m.txt",
      "security find-generic-password -s x", "cat ~/.jarvis/secrets/p.env",
    ]) expect(bash(c), c).toBeTruthy();
  });

  it("lets ordinary build work through", () => {
    for (const c of ["pnpm test", "go test ./...", "git status", "git diff", "rm -rf node_modules", "rm -rf ./dist", "vercel --help", "node scripts/build.js"]) {
      expect(bash(c), c).toBeUndefined();
    }
  });

  it("keeps file tools out of the runner folder", () => {
    expect(check({ tool_name: "Read", tool_input: { file_path: "/Users/f/.jarvis/ledger.jsonl" } })).toBeTruthy();
    expect(check({ tool_name: "Read", tool_input: { file_path: "/Users/f/repo/src/a.ts" } })).toBeUndefined();
  });

  it("lets file tools write the session's own notes and scratch files", () => {
    const write = (file_path: string) => check({ tool_name: "Write", tool_input: { file_path } });
    for (const p of [
      ".jarvis/notes/T1.md", "/Users/x/.jarvis-work/worktrees/a/.jarvis/notes/T1.md",
      ".jarvis/scratch/run-tests.sh", "/Users/x/.jarvis-work/worktrees/a/.jarvis/scratch/list_1.sh",
    ]) expect(write(p), p).toBeUndefined();
    for (const p of [
      "/Users/f/.jarvis/notes/x.md", "~/.jarvis/scratch/x.sh", "$HOME/.jarvis/notes/x.md", "/home/f/.jarvis/notes/x.md",
      ".jarvis/ledger.jsonl", ".jarvis/notes/sub/x.md", ".jarvis/notes/x.txt", ".jarvis/scratch/..", ".jarvis/scratch/.hidden",
      "/tmp/.jarvis/../../Users/f/.jarvis/notes/x.md", "a/.jarvis/notes/../ledger/x.md",
    ]) expect(write(p), p).toBeTruthy();
  });

  // The files the skills write under the repo's `.jarvis/` (intake, spec, design, architect, onboard, sweep).
  // After decision 87 the repo's `.jarvis/` is no privileged channel: the inbox lives in the runner home,
  // candidates touching `.jarvis/` are refused, and the runner reads its own copies (decision 91). The
  // runner home stays off limits without exception.
  const SKILL_FILES = [
    ".jarvis/intake/round-1.json", ".jarvis/intake/round-12.json", ".jarvis/intake/answers-3.json", ".jarvis/intake/taste.json",
    ".jarvis/mockups/index.html", ".jarvis/mockups/calm/direction.md", ".jarvis/mockups/calm/home.html", ".jarvis/mockups/calm/home.png",
    ".jarvis/plan.json",
    ".jarvis/checks/habit-create.check.json", ".jarvis/checks/verify.sh", ".jarvis/checks/verify.mjs",
    ".jarvis/checks/fixtures/driver.mjs", ".jarvis/checks/fixtures/inputs/one.json", ".jarvis/checks/expected/habit-create/out.txt",
    ".jarvis/onboard/2026-10-24.md", ".jarvis/onboard/plan.json",
    ".jarvis/sweep/2026-10-24.md", ".jarvis/sweep/plan.json",
  ];
  const fileTool = (tool_name: string, file_path: string) => check({ tool_name, tool_input: { file_path } });

  it("lets Write, Edit and Read reach every file a skill writes under the repo's .jarvis/", () => {
    for (const tool of ["Write", "Edit", "Read"]) {
      for (const rel of SKILL_FILES) {
        for (const p of [rel, `/Users/f/repo/${rel}`, `/Users/x/.jarvis-work/worktrees/a/${rel}`]) expect(fileTool(tool, p), `${tool} ${p}`).toBeUndefined();
      }
    }
  });

  it("keeps the runner home refused for those same names, through ~, $HOME, /Users/<u>, /home/<u> and ..", () => {
    for (const tool of ["Write", "Edit", "Read"]) {
      for (const rel of SKILL_FILES) {
        const inner = rel.slice(".jarvis/".length);
        for (const p of [
          `~/.jarvis/${inner}`, `$HOME/.jarvis/${inner}`, `/Users/f/.jarvis/${inner}`, `/home/f/.jarvis/${inner}`,
          `/Users/f/repo/../.jarvis/${inner}`, `/Users/f/repo/.jarvis/../../.jarvis/${inner}`, `/tmp/x/../../Users/f/.jarvis/${inner}`,
          `/Users/f/.jarvis/projects/p-1/${rel}`,
        ]) expect(fileTool(tool, p), `${tool} ${p}`).toBeTruthy();
      }
    }
  });

  it("refuses every other .jarvis/ path, so the allowlist never becomes everything", () => {
    for (const p of [
      ".jarvis", ".jarvis/", ".jarvis/REPORT.md", ".jarvis/progress.md", ".jarvis/inbox.md", ".jarvis/ledger.jsonl",
      ".jarvis/plan.md", ".jarvis/plan.json.bak", ".jarvis/other-1a2b3c.txt", "/Users/f/work/probe/.jarvis/other-1a2b3c.txt",
      ".jarvis/intake/round-0.json", ".jarvis/intake/round-x.json", ".jarvis/intake/round-1.json.sh", ".jarvis/intake/notes.md", ".jarvis/intake/sub/round-1.json",
      ".jarvis/mockups/calm/home.js", ".jarvis/mockups/calm/deep/home.html", ".jarvis/mockups/.hidden/home.html", ".jarvis/mockups/index.js",
      ".jarvis/checks/notes.md", ".jarvis/checks/.hidden.sh", ".jarvis/checks/sub/x.check.json", ".jarvis/checks/fixtures/../../plan.json", ".jarvis/checks/fixtures/.env",
      ".jarvis/checks/fixtures",
      ".jarvis/onboard/notes.md", ".jarvis/onboard/2026-10-24.sh", ".jarvis/onboard/sub/plan.json",
      ".jarvis/sweep/26-10-24.md", ".jarvis/sweep/plan.json/x", ".jarvis/inbox/1.md", ".jarvis/evidence/1/log.txt",
    ]) {
      for (const tool of ["Write", "Edit", "Read"]) expect(fileTool(tool, p), `${tool} ${p}`).toBeTruthy();
    }
  });

  it("allows every .jarvis/ file a skill or template names as a target, so a new skill can't silently break", () => {
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    // Placeholders the skills use in their .jarvis/ paths, filled with a valid example each.
    const examples: Record<string, string> = {
      "<n>": "2", "<task>": "T1", "<name>": "verify", "<direction>": "calm", "<screen>": "home", "<YYYY-MM-DD>": "2026-10-24", "<date>": "2026-10-24",
    };
    const sources = [
      ...readdirSync(join(repo, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(repo, "skills", d.name, "SKILL.md")),
      ...readdirSync(join(repo, "templates")).map((f) => join(repo, "templates", f)),
      join(repo, "plugin", "commands", "jarvis.md"),
    ].filter((f) => existsSync(f));
    const targets = new Set<string>();
    for (const file of sources) {
      // Repo-relative mentions only: `~/.jarvis/…` names the runner home, which stays refused.
      for (const m of readFileSync(file, "utf8").matchAll(/(?<![\w/~$-])\.jarvis\/[A-Za-z0-9<>._\/-]*/g)) {
        const path = m[0].replace(/\.+$/, "");
        if (path.endsWith("/")) continue; // a folder named in prose, not a file to write
        const filled = path.replace(/<[^>]+>/g, (ph) => {
          expect(examples, `placeholder ${ph} in ${file}`).toHaveProperty(ph);
          return examples[ph]!;
        });
        targets.add(filled);
      }
    }
    expect(targets.size).toBeGreaterThan(5);
    expect([...targets]).toEqual(expect.arrayContaining([".jarvis/intake/round-2.json", ".jarvis/plan.json"]));
    for (const p of targets) for (const tool of ["Write", "Edit", "Read"]) expect(fileTool(tool, p), `${tool} ${p}`).toBeUndefined();
  });

  it("blocks through the hook protocol (exit 2, reason on stderr)", () => {
    const hook = fileURLToPath(new URL("../../plugin/hooks/tripwire.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm publish" } }), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/publishing packages/);
    const ok = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } }), encoding: "utf8" });
    expect(ok.status).toBe(0);
  });

  // Decision 80: with no run header (an interactive desktop session), SessionStart still prints a fixed
  // receipt, so the desktop check can find it in the hook record Claude Code writes. With a header, the
  // output is the header alone, as before.
  it("SessionStart prints a fixed receipt without a run header, and only the header with one", () => {
    const hook = fileURLToPath(new URL("../../plugin/hooks/session-start.mjs", import.meta.url));
    const env = { PATH: process.env.PATH! };
    const bare = spawnSync(process.execPath, [hook], { input: "{}", encoding: "utf8", env });
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe("Jarvis plugin: SessionStart ran (no run header).\n");
    const header = join(root, "header.md");
    writeFileSync(header, "Task: build the thing.\n");
    const withHeader = spawnSync(process.execPath, [hook], { input: "{}", encoding: "utf8", env: { ...env, JARVIS_RUN_HEADER: header } });
    expect(withHeader.status).toBe(0);
    expect(withHeader.stdout).toBe("Task: build the thing.\n");
    const missing = spawnSync(process.execPath, [hook], { input: "{}", encoding: "utf8", env: { ...env, JARVIS_RUN_HEADER: join(root, "absent.md") } });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe("");
  });

  it("is valid plugin JSON", () => {
    const hooks = JSON.parse(readFileSync(fileURLToPath(new URL("../../plugin/hooks/hooks.json", import.meta.url)), "utf8"));
    expect(Object.keys(hooks.hooks)).toEqual(["PreToolUse", "SessionStart"]);
  });
});

describe("secrets backend (decision 13)", () => {
  it("reads an owner-only env file and refuses one others can read", () => {
    const f = join(root, "p.env");
    writeFileSync(f, 'SMTP_PASSWORD="abc"\nexport TOKEN=xyz\n', { mode: 0o600 });
    expect(envFileSecrets(f).get("SMTP_PASSWORD")).toBe("abc");
    expect(envFileSecrets(f).get("TOKEN")).toBe("xyz");
    chmodSync(f, 0o644);
    expect(() => envFileSecrets(f)).toThrow(/owner only/);
  });
});
