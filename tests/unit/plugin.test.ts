import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs hook without types
import { check } from "../../plugin/hooks/tripwire.mjs";
import { envFileSecrets } from "../../packages/cli/src/broker/secrets.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtp-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The tripwire enforces only in Jarvis sessions (the scope tests below). Every other test runs in a
// Jarvis repo: a .git folder and a .jarvis folder, with no JARVIS_SESSION in the env.
const repoAt = (name: string, markers: string[]) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const m of markers) if (m.endsWith("/")) mkdirSync(join(dir, m), { recursive: true }); else writeFileSync(join(dir, m), "{}\n");
  return dir;
};
const jarvisRepo = repoAt("jarvis-repo", [".git/", ".jarvis/"]);
const bash = (command: string, cwd = jarvisRepo, env: Record<string, string> = {}) => check({ tool_name: "Bash", tool_input: { command }, cwd }, env);

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
    expect(check({ tool_name: "Read", tool_input: { file_path: "/Users/f/.jarvis/ledger.jsonl" }, cwd: jarvisRepo }, {})).toBeTruthy();
    expect(check({ tool_name: "Read", tool_input: { file_path: "/Users/f/repo/src/a.ts" }, cwd: jarvisRepo }, {})).toBeUndefined();
  });

  it("lets file tools write the session's own notes and scratch files", () => {
    const write = (file_path: string) => check({ tool_name: "Write", tool_input: { file_path }, cwd: jarvisRepo }, {});
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
  const fileTool = (tool_name: string, file_path: string) => check({ tool_name, tool_input: { file_path }, cwd: jarvisRepo }, {});

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
    const env = { PATH: process.env.PATH! };
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm publish" }, cwd: jarvisRepo }), encoding: "utf8", env });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/publishing packages/);
    const ok = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" }, cwd: jarvisRepo }), encoding: "utf8", env });
    expect(ok.status).toBe(0);
    // A runner-started session is Jarvis wherever it runs; without the env, a plain repo is not.
    const plain = repoAt("hook-plain", [".git/"]);
    const publish = (extra: Record<string, string>) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm publish" }, cwd: plain }), encoding: "utf8", env: { ...env, ...extra } });
    expect(publish({}).status).toBe(0);
    expect(publish({ JARVIS_SESSION: "1" }).status).toBe(2);
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

// The plugin installs at user scope, so the tripwire runs in every Claude Code session. It enforces only
// in Jarvis sessions: JARVIS_SESSION=1 (runner-started), or a cwd whose folders up to its git toplevel
// hold .jarvis or .jarvis-routing.json. Anything it can't read counts as Jarvis. The runner home stays
// off limits everywhere.
describe("tripwire scope: Jarvis sessions only", () => {
  const PUSH = "git push origin main";
  const plainRepo = repoAt("plain-repo", [".git/", "src/"]);

  it("allows hard stops in a repo that isn't a Jarvis project", () => {
    for (const c of [PUSH, "git push --force origin main", "npm publish", "vercel deploy --prod"]) expect(bash(c, plainRepo), c).toBeUndefined();
    expect(bash(PUSH, join(plainRepo, "src")), "a subfolder").toBeUndefined();
    expect(check({ tool_name: "Write", tool_input: { file_path: join(plainRepo, "src/a.ts") }, cwd: plainRepo }, {})).toBeUndefined();
  });

  it("still blocks them in a Jarvis repo, from its root or any folder below it", () => {
    expect(bash(PUSH, jarvisRepo)).toBeTruthy();
    mkdirSync(join(jarvisRepo, "packages/app"), { recursive: true });
    expect(bash(PUSH, join(jarvisRepo, "packages/app"))).toBeTruthy();
    const routed = repoAt("routed-repo", [".git/", ".jarvis-routing.json", "lib/"]);
    expect(bash(PUSH, routed), ".jarvis-routing.json marks a project").toBeTruthy();
    expect(bash(PUSH, join(routed, "lib"))).toBeTruthy();
    const worktree = repoAt("linked-worktree", [".git", ".jarvis/"]);
    expect(bash(PUSH, worktree), "a .git file marks a linked worktree's toplevel").toBeTruthy();
  });

  it("blocks them in runner sessions (JARVIS_SESSION=1) whatever the cwd", () => {
    const loose = repoAt("loose-folder", []);
    for (const cwd of [plainRepo, loose, "/"]) expect(bash(PUSH, cwd, { JARVIS_SESSION: "1" }), cwd).toBeTruthy();
    expect(bash(PUSH, plainRepo, { JARVIS_SESSION: "0" }), "only 1 turns it on").toBeUndefined();
  });

  it("counts a symlinked .jarvis or .jarvis-routing.json as Jarvis, even a dangling one", () => {
    const linked = repoAt("linked-marker", [".git/"]);
    symlinkSync(join(root, "elsewhere"), join(linked, ".jarvis"));
    expect(bash(PUSH, linked)).toBeTruthy();
    const routed = repoAt("linked-routing", [".git/"]);
    symlinkSync(join(root, "missing.json"), join(routed, ".jarvis-routing.json"));
    expect(bash(PUSH, routed)).toBeTruthy();
  });

  it("fails closed when the cwd can't be read: missing, locked, or not given as text", () => {
    expect(bash(PUSH, join(root, "does-not-exist"))).toBeTruthy();
    const locked = repoAt("locked", ["inner/"]);
    chmodSync(locked, 0o000);
    try {
      expect(bash(PUSH, join(locked, "inner"))).toBeTruthy();
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(check({ tool_name: "Bash", tool_input: { command: PUSH }, cwd: 42 }, {})).toBeTruthy();
    // A cwd it can resolve but not look inside: its markers can't be checked, so they count as present.
    const sealed = repoAt("sealed", []);
    chmodSync(sealed, 0o000);
    try {
      expect(bash(PUSH, sealed)).toBeTruthy();
    } finally {
      chmodSync(sealed, 0o700);
    }
  });

  it("checks only the cwd outside a git repo, so a home folder's .jarvis/ doesn't make every project Jarvis", () => {
    const home = repoAt("fake-home", [".jarvis/", "notes/"]);
    expect(bash(PUSH, join(home, "notes"))).toBeUndefined();
    expect(bash(PUSH, home), "the folder that holds .jarvis itself").toBeTruthy();
  });

  it("keeps the runner home off limits to file tools in every session, Jarvis or not", () => {
    for (const cwd of [plainRepo, jarvisRepo]) {
      for (const tool of ["Read", "Write", "Edit", "Glob", "Grep"]) {
        for (const p of [
          "/Users/f/.jarvis/ledger.jsonl", "~/.jarvis/secrets/p.env", "$HOME/.jarvis/secrets/p.env", "/home/f/.jarvis/run/broker.sock",
          "/Users/f/.jarvis", "/var/root/.jarvis/secrets/p.env", "/var/root/repo/../.jarvis/ledger.jsonl",
        ]) {
          const input = { tool_name: tool, tool_input: tool === "Glob" || tool === "Grep" ? { pattern: "*", path: p } : { file_path: p }, cwd };
          expect(check(input, { HOME: "/var/root" }), `${tool} ${p} from ${cwd}`).toBeTruthy();
        }
      }
    }
  });

  it("keeps Bash out of the runner home in every session too", () => {
    for (const cwd of [plainRepo, jarvisRepo]) expect(bash("cat ~/.jarvis/secrets/p.env", cwd), cwd).toBeTruthy();
    expect(bash("ls ~/.jarvis-work/worktrees", plainRepo)).toBeUndefined();
  });

  // Codex round 18, lane D, low: relative Bash paths slipped past the spelling-only runner-home rule.
  it("resolves relative Bash paths against the cwd and HOME, cd included, before matching the runner home", () => {
    const HOME = "/var/root";
    const env = { HOME };
    for (const [command, cwd] of [
      ["cat .jarvis/secrets/p.env", HOME],
      ["cat ../../.jarvis/secrets/p.env", `${HOME}/a/b`],
      ["cat '../.jarvis/ledger.jsonl'", `${HOME}/repo`],
      ["cd ~ && cat .jarvis/secrets/p.env", plainRepo],
      ["cd && cat .jarvis/secrets/p.env", plainRepo],
      ["cd $HOME; cat .jarvis/secrets/p.env", plainRepo],
      ["cd /var/root/repo && cat ../.jarvis/secrets/p.env", plainRepo],
      ["node x.js --env=../.jarvis/secrets/p.env", `${HOME}/repo`],
      ["ls .jarvis", HOME],
    ] as const) {
      expect(check({ tool_name: "Bash", tool_input: { command }, cwd }, env), `${command} from ${cwd}`).toBeTruthy();
    }
    for (const [command, cwd] of [
      ["cat .jarvis/notes/t.md", plainRepo],
      ["cat ../.jarvis-work/x", `${HOME}/repo`],
      ["cd ~/.jarvis-work && ls", plainRepo],
      ["cd repo && cat .jarvis/notes/t.md", HOME],
    ] as const) {
      expect(check({ tool_name: "Bash", tool_input: { command }, cwd }, env), `${command} from ${cwd}`).toBeUndefined();
    }
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
