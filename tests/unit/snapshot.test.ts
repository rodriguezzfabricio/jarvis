import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSnapshot, redactEnvText } from "../../packages/cli/src/eval/snapshot.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jts-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

function sourceRepo(): { repo: string; base: string; fix: string } {
  const repo = join(root, "src");
  mkdirSync(join(repo, "ext"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "https://example.invalid/upstream.git");
  writeFileSync(join(repo, "app.go"), "package app\n// buggy\n");
  writeFileSync(join(repo, "ext", ".env.production"), "WXT_HIRE_ORIGIN=https://example.invalid\nWXT_GA_API_SECRET=abc123notreal\nDB_PASSWORD=\n# API_KEY=commented\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base commit with ANSWER-IN-HISTORY");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "app.go"), "package app\n// fixed\n");
  git(repo, "commit", "-qam", "the fix");
  const fix = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "untracked.env"), "SECRET=x\n");
  return { repo, base, fix };
}

describe("sanitized snapshots (golden tasks: how every task runs)", () => {
  const { repo, fix } = sourceRepo();

  it("redacts secret-looking values and keeps everything else", () => {
    const r = redactEnvText("A=1\nMY_API_KEY=xyz\nJWT_SECRET=s3\nEMPTY_TOKEN=\n# PASSWORD=c\nURL=https://x\n");
    expect(r.text).toBe("A=1\nMY_API_KEY=\nJWT_SECRET=\nEMPTY_TOKEN=\n# PASSWORD=c\nURL=https://x\n");
    expect(r.keys).toEqual(["MY_API_KEY", "JWT_SECRET"]);
  });

  it("exports one commit with no history and no remotes, secrets redacted", async () => {
    const dest = join(root, "snap1");
    const m = await createSnapshot({ sourceRepo: repo, rev: fix, dest });
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "remote")).toBe("");
    expect(git(dest, "log", "--format=%s")).toBe("snapshot");
    expect(git(dest, "log", "--all", "--format=%B")).not.toContain("ANSWER-IN-HISTORY");
    expect(readFileSync(join(dest, "ext", ".env.production"), "utf8")).toContain("WXT_GA_API_SECRET=\n");
    expect(readFileSync(join(dest, "ext", ".env.production"), "utf8")).toContain("WXT_HIRE_ORIGIN=https://example.invalid");
    expect(() => readFileSync(join(dest, "untracked.env"))).toThrow();
    expect(m.redactions).toEqual([{ file: "ext/.env.production", keys: ["WXT_GA_API_SECRET"] }]);
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("undoes a planted fix in the files, with no trace of it in git", async () => {
    const dest = join(root, "snap2");
    const m = await createSnapshot({ sourceRepo: repo, rev: fix, dest, revert: [fix] });
    expect(readFileSync(join(dest, "app.go"), "utf8")).toContain("// buggy");
    expect(git(dest, "log", "--all", "--format=%B")).not.toContain("the fix");
    expect(m.reverted).toEqual([fix]);
  });

  it("makes an empty starting folder for new products", async () => {
    const dest = join(root, "snap3");
    const m = await createSnapshot({ dest });
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "ls-files")).toBe("");
    expect(m.sourceRev).toBeNull();
  });

  it("refuses a destination that isn't empty", async () => {
    const dest = join(root, "snap4");
    mkdirSync(dest);
    writeFileSync(join(dest, "x"), "x");
    await expect(createSnapshot({ dest })).rejects.toThrow(/empty/);
  });
});
