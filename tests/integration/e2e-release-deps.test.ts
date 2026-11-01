import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { deployAdapters } from "../../packages/cli/src/broker/adapters/index.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { buildRelease } from "../../packages/cli/src/release/build.ts";
import { releaseProjectConfig, parseReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { manifestHash, parseManifest, releaseRef } from "../../packages/cli/src/release/manifest.ts";
import type { SandboxedRun } from "../../packages/cli/src/sandbox/srt.ts";
import { shortTmp } from "../helpers.ts";
import { initRepo } from "../unit/helpers/git-repo.ts";

const root = shortTmp("release-deps-e2e-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture(lock = true) {
  const dir = join(root, String(++serial)), repo = join(dir, "repo"), projectDir = join(dir, "runner/project"), workRoot = join(dir, "work");
  for (const d of [repo, projectDir, workRoot]) mkdirSync(d, { recursive: true });
  initRepo(repo, { identity: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0", packageManager: "npm@11.19.0", devDependencies: { "vite-like": "1.0.0" }, scripts: { postinstall: "touch BAD", build: "node build.cjs" } }));
  const lockBytes = JSON.stringify({ lockfileVersion: 3, packages: { "": { devDependencies: { "vite-like": "1.0.0" } }, "node_modules/vite-like": { version: "1.0.0", resolved: "https://registry.npmjs.org/vite-like/-/vite-like-1.0.0.tgz", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } } });
  if (lock) writeFileSync(join(repo, "package-lock.json"), lockBytes);
  writeFileSync(join(repo, "build.cjs"), "require('./node_modules/vite-like').build();");
  safeGit(repo, ["add", "-A"], { home: dir }); safeGit(repo, ["commit", "-qm", "verified source"], { home: dir });
  const revision = safeGit(repo, ["rev-parse", "HEAD"], { home: dir }).toString().trim();
  const tools = join(dir, "tools"); mkdirSync(tools); const bin = join(tools, "fake-npm.cjs");
  writeFileSync(bin, `const fs=require('node:fs'),p=require('node:path');
    if(process.argv.includes('--version')) { console.log('11.19.0'); process.exit(0); }
    if(!process.argv.includes('ci') || !process.argv.includes('--ignore-scripts')) process.exit(5);
    fs.mkdirSync('node_modules/vite-like',{recursive:true});
    fs.writeFileSync('node_modules/vite-like/index.js',fs.readFileSync(p.join(process.env.npm_config_cache,'fake-registry')));
  `);
  const calls: SandboxedRun[] = [];
  const sandbox = async (r: SandboxedRun) => {
    calls.push(r);
    if (r.policy.allowedDomains?.length) {
      expect(r.policy.allowedDomains).toEqual(["registry.npmjs.org"]);
      mkdirSync(r.env.npm_config_cache!, { recursive: true });
      writeFileSync(join(r.env.npm_config_cache!, "fake-registry"), "exports.build=()=>{const fs=require('node:fs');fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','<h1>Built offline</h1>')};");
    }
    return runSession({ bin: "/bin/sh", args: ["-c", r.command], cwd: r.cwd, env: r.env, timeoutMs: r.timeoutMs,
      ...(r.maxOutputBytes !== undefined ? { maxOutputBytes: r.maxOutputBytes } : {}), ...(r.stdoutPath ? { stdoutPath: r.stdoutPath } : {}), ...(r.stderrPath ? { stderrPath: r.stderrPath } : {}), killGraceMs: 50 });
  };
  const ledger = Ledger.open(projectDir);
  const input = { ledger, project: "p", projectDir, jarvisHome: join(dir, "runner"), workRoot, repoPath: repo, revision, gitHome: dir,
    artifactRoot: join(workRoot, "release/p/artifacts"), runId: `r${serial}`, build: { command: `'${process.execPath}' build.cjs`, output: "dist", timeoutMs: 5000 }, sandbox,
    dependencyPins: { node: process.execPath, nodeVersion: process.versions.node, npm: { bin, root: tools, version: "11.19.0" }, pnpm: { bin, root: tools, version: "11.7.0" } } };
  return { dir, repo, ledger, input, calls, lockBytes };
}

describe("release dependencies through the Render deploy tree", () => {
  it("installs the verified tree, builds offline, and deploys only static output through a fake Render adapter transport", async () => {
    const f = fixture(); writeFileSync(join(f.repo, "package.json"), "uncommitted garbage");
    const built = await buildRelease(f.input);
    expect(built.status).toBe("pass"); if (built.status !== "pass") return;
    expect(f.calls).toHaveLength(2);
    const [deps, build] = f.calls as [SandboxedRun, SandboxedRun];
    expect(build.cwd).toBe(deps.cwd); expect(build.policy.allowedDomains ?? []).toEqual([]);
    expect(build.policy.allowLocalBinding ?? false).toBe(false); expect(build.policy.allowUnixSockets ?? []).toEqual([]);
    expect(build.env.npm_config_offline).toBe("true");
    expect(deps.policy.allowRead).toEqual(expect.arrayContaining(build.policy.allowRead));
    expect(deps.policy.denyRead).toEqual(build.policy.denyRead);
    expect(readdirSync(built.artifactDir)).toEqual(["index.html"]);
    expect(f.ledger.entries()).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ type: "release.dependencies", status: "pass", revision: f.input.revision }) })]));
    const setup = parseReleaseSetup({ version: 1, provider: "render", plan: "free", siteId: "tiny", productionUrl: "https://tiny.onrender.com", build: f.input.build,
      render: { preview: { repo: "git@github.com:owner/preview.git", branch: "main", url: "https://tiny-preview.onrender.com" }, production: { repo: "git@github.com:owner/prod.git", branch: "main", url: "https://tiny.onrender.com" } } });
    const config = releaseProjectConfig(setup, { projectDir: f.input.projectDir, workRoot: f.input.workRoot, project: "p", ledger: f.ledger });
    const manifest = parseManifest({ version: 1, project: "p", revision: f.input.revision, provider: "render", artifactDir: built.artifactDir, artifactHash: built.artifactHash,
      siteId: "tiny", productionUrl: setup.productionUrl, smokePaths: ["/"], data: { kind: "none" }, rollback: { steps: ["Push the earlier static tree."] } });
    let pushed = false;
    const ok = (stdout = "") => ({ code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout, stderr: "" });
    const broker = new Broker({ ledger: f.ledger, project: "p", secrets: { get: () => Buffer.from("FAKE key, not a credential").toString("base64") },
      adapters: deployAdapters({ ledger: f.ledger, project: "p", projectConfig: config, resolveManifest: () => manifest,
        providers: { render: { bin: "/Applications/Xcode.app/Contents/Developer/usr/bin/git", version: "git version 2.50.1 (Apple Git-155)", ssh: { bin: "/usr/bin/ssh", version: "OpenSSH_10.2p1, LibreSSL 3.3.6" }, home: config.privateRoot, cwd: config.privateRoot } },
        run: async s => {
          if (s.args.includes("--version")) return ok("git version 2.50.1 (Apple Git-155)");
          if (s.args.includes("-V")) return { ...ok(), stderr: "OpenSSH_10.2p1, LibreSSL 3.3.6" };
          if (s.args.includes("ls-remote")) return { ...ok(), code: 2 };
          if (s.args.includes("push")) {
            pushed = true;
            expect(readdirSync(s.cwd).sort()).toEqual([".jarvis-build.json", "index.html"]);
            expect(readFileSync(join(s.cwd, "index.html"), "utf8")).toBe("<h1>Built offline</h1>");
            expect(JSON.parse(readFileSync(join(s.cwd, ".jarvis-build.json"), "utf8"))).toEqual({ manifestHash: manifestHash(manifest) });
          }
          return ok();
        }, fetch: async () => new Response(JSON.stringify({ manifestHash: manifestHash(manifest) })) }) });
    expect((await broker.handle({ op: "deploy.preview", payload: { ref: releaseRef(manifest, "preview") } })).status).toBe("succeeded");
    expect(pushed).toBe(true);
    expect(existsSync(build.cwd)).toBe(false);
    expect(built.artifactDir.startsWith(realpathSync(f.input.artifactRoot))).toBe(true);
  });
  it("refuses an uncommitted lockfile and records the failed attempt with its reason", async () => {
    const f = fixture(false); writeFileSync(join(f.repo, "package-lock.json"), f.lockBytes);
    const built = await buildRelease(f.input);
    expect(built).toMatchObject({ status: "fail", reason: expect.stringMatching(/dependencies.*lockfile/) });
    expect(f.calls).toEqual([]);
    const entries = f.ledger.entries();
    expect(entries.some(e => (e.data as { type?: string }).type === "release.artifact")).toBe(false);
    // The release step's own "stopped" line and REPORT.md are the caller's (release-run.test.ts).
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ type: "release.dependencies", status: "fail", reason: expect.stringMatching(/dependencies.*lockfile/) }) })]));
  });
  it("never builds or registers an artifact after a failed dependency process", async () => {
    const f = fixture();
    const built = await buildRelease({ ...f.input, sandbox: async r => {
      f.calls.push(r); return { code: 73, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
    } });
    expect(built).toMatchObject({ status: "fail", reason: expect.stringMatching(/dependencies.*size/) });
    expect(f.calls).toHaveLength(1);
    expect(f.ledger.entries().some(e => (e.data as { type?: string }).type === "release.artifact")).toBe(false);
  });
});
