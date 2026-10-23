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

  it("blocks through the hook protocol (exit 2, reason on stderr)", () => {
    const hook = fileURLToPath(new URL("../../plugin/hooks/tripwire.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm publish" } }), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/publishing packages/);
    const ok = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } }), encoding: "utf8" });
    expect(ok.status).toBe(0);
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
