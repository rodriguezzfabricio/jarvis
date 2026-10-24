import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("lets file tools write the session's own notes and scratch files, nothing else under .jarvis", () => {
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
