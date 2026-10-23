import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSnapshot, findCredentials, redactEnvText } from "../../packages/cli/src/eval/snapshot.ts";
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

  // Codex review 1, high: multi-line values, credential URLs and real keys must not survive.
  it("redacts quoted multi-line secrets entirely", () => {
    const r = redactEnvText('A=1\nPRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nmorekeymaterial\n-----END PRIVATE KEY-----"\nB=2\n');
    expect(r.text).toBe("A=1\nPRIVATE_KEY=\nB=2\n");
    expect(r.text).not.toContain("MIIE");
  });

  it("strips user:password from non-local credential URLs and keeps local dev defaults", () => {
    const r = redactEnvText("DATABASE_URL=postgres://admin:hunter2@prod.db.example.com:5432/app\nDEV_URL=postgres://hire:hire@localhost:5432/hire\n");
    expect(r.text).toContain("postgres://REDACTED:REDACTED@prod.db.example.com:5432/app");
    expect(r.text).toContain("postgres://hire:hire@localhost:5432/hire");
    expect(r.keys).toEqual(["DATABASE_URL"]);
  });

  it("recognizes real-looking credentials but not dummy fixtures", () => {
    const realKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(120)}\n-----END PRIVATE KEY-----`;
    expect(findCredentials(realKey)).toEqual(["private key"]);
    expect(findCredentials("-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----")).toEqual([]);
    expect(findCredentials(`token: ghp_${"a".repeat(36)}`)).toEqual(["GitHub token"]);
    expect(findCredentials("nothing here")).toEqual([]);
  });

  it("fails closed on a credential anywhere in the tree, unless a person allowlisted that file", async () => {
    const repo2 = join(root, "src2");
    mkdirSync(repo2, { recursive: true });
    git(repo2, "init", "-q", "-b", "main");
    git(repo2, "config", "user.email", "t@t");
    git(repo2, "config", "user.name", "t");
    writeFileSync(join(repo2, "deploy.yaml"), `aws_key: AKIA${"ABCDEFGHIJKLMNOP"}\n`);
    git(repo2, "add", "-A");
    git(repo2, "commit", "-qm", "c");
    await expect(createSnapshot({ sourceRepo: repo2, rev: "HEAD", dest: join(root, "snapF") })).rejects.toThrow(/deploy.yaml \(AWS access key\)/);
    expect(existsSync(join(root, "snapF"))).toBe(false);
    const m = await createSnapshot({ sourceRepo: repo2, rev: "HEAD", dest: join(root, "snapG"), allowSecretsIn: ["deploy.yaml"] });
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("removes symlinks that point outside the snapshot", async () => {
    const repo3 = join(root, "src3");
    mkdirSync(repo3, { recursive: true });
    git(repo3, "init", "-q", "-b", "main");
    git(repo3, "config", "user.email", "t@t");
    git(repo3, "config", "user.name", "t");
    writeFileSync(join(repo3, "a.txt"), "a");
    symlinkSync("/etc/hosts", join(repo3, "out"));
    symlinkSync("a.txt", join(repo3, "in"));
    git(repo3, "add", "-A");
    git(repo3, "commit", "-qm", "c");
    const m = await createSnapshot({ sourceRepo: repo3, rev: "HEAD", dest: join(root, "snapL") });
    expect(m.removedSymlinks).toEqual(["out"]);
    expect(existsSync(join(root, "snapL", "in"))).toBe(true);
  });

  it("refuses a destination that isn't empty", async () => {
    const dest = join(root, "snap4");
    mkdirSync(dest);
    writeFileSync(join(dest, "x"), "x");
    await expect(createSnapshot({ dest })).rejects.toThrow(/empty/);
  });
});
