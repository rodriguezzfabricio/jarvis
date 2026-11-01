import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { deployAdapters, PROVIDERS } from "../../packages/cli/src/broker/adapters/index.ts";
import type { DeployAdapterOptions, ProviderConfig } from "../../packages/cli/src/broker/adapters/types.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runnerGitEnv } from "../../packages/cli/src/eval/git.ts";
import { artifactDigest, manifestHash, parseManifest, releaseRef } from "../../packages/cli/src/release/manifest.ts";
import { prepareRelease } from "../../packages/cli/src/release/run.ts";
import { recordAcceptedManifest } from "../../packages/cli/src/release/accepted.ts";
import { ARTIFACT_TYPE, saveReleaseSetup, parseReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { grantRelease } from "../../packages/cli/src/release/grants.ts";
import { runSmoke } from "../../packages/cli/src/release/smoke.ts";
import type { ReleaseManifest, ReleaseProjectConfig } from "../../packages/cli/src/release/types.ts";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";

const root = mkdtempSync(join(tmpdir(), "render-"));
const GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";
const PREVIEW = Buffer.from("DUMMY preview private key, never a real credential\n").toString("base64");
const PRODUCTION = Buffer.from("DUMMY production private key, never a real credential\n").toString("base64");
const destinations = {
  preview: { repo: "git@github.com:owner/preview.git", branch: "main", url: "https://habits-preview.onrender.com" },
  production: { repo: "git@github.com:owner/production.git", branch: "main", url: "https://habits.onrender.com" },
};
const ok = (stdout = "") => ({ code: 0, timedOut: false, overflowed: false, durationMs: 0, stdout, stderr: "" });
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
let n = 0;
function fixture() {
  vi.stubGlobal("fetch", async () => { throw new Error("real network forbidden in Render tests"); });
  const dir = join(root, `${++n}`); mkdirSync(dir);
  const ledger = Ledger.open(join(dir, "runner"));
  const artifactRoot = join(dir, "artifacts"), artifactDir = join(artifactRoot, "first"), privateRoot = join(ledger.dir, "deploy");
  mkdirSync(artifactDir, { recursive: true }); mkdirSync(privateRoot);
  writeFileSync(join(artifactDir, "index.html"), "first\r\n"); writeFileSync(join(artifactDir, "image.png"), Buffer.from([0, 255, 13, 10]));
  const manifest = parseManifest({ version: 1, project: "p", revision: "a".repeat(40), provider: "render", artifactDir,
    artifactHash: artifactDigest(artifactDir), siteId: "habits", productionUrl: destinations.production.url, smokePaths: ["/"], data: { kind: "none" }, rollback: { steps: ["Push the earlier verified tree."] } });
  const config: ReleaseProjectConfig = { project: "p", provider: "render", siteId: "habits", productionUrl: manifest.productionUrl,
    artifactRoot, privateRoot, snapshotRoot: ledger.dir, artifacts: { [manifest.revision]: manifest.artifactHash }, render: structuredClone(destinations) };
  const pin: ProviderConfig = { bin: GIT, version: "git version 2.50.1 (Apple Git-155)", ssh: { bin: "/usr/bin/ssh", version: "OpenSSH_10.2p1, LibreSSL 3.3.6" }, home: privateRoot, cwd: privateRoot };
  const repos = { preview: join(dir, "preview.git"), production: join(dir, "production.git") };
  for (const repo of Object.values(repos)) execFileSync(GIT, ["init", "--bare", "--template=", repo], { env: runnerGitEnv(dir), stdio: "pipe" });
  const manifests = new Map([[manifestHash(manifest), manifest]]);
  const calls: SessionSpec[] = [], reads: string[] = [], keys: string[] = [], urls: string[] = [];
  let missingKey = false;
  let marker = manifestHash(manifest), markerDelay = 0, failure = "", observe = (_s: SessionSpec) => {};
  const run: NonNullable<DeployAdapterOptions["run"]> = async s => {
    calls.push(s); observe(s);
    if (s.args.includes("--version")) return ok(failure === "version" ? "wrong" : pin.version);
    if (s.bin === "/usr/bin/ssh") return { ...ok(), stderr: pin.ssh!.version };
    const args = [...s.args];
    for (const tier of ["preview", "production"] as const) {
      const at = args.indexOf(destinations[tier].repo);
      if (at < 0) continue;
      args[at] = repos[tier];
      const keyPath = /-i '([^']+)'/.exec(s.env.GIT_SSH_COMMAND!)?.[1];
      expect(keyPath).toBeDefined(); keys.push(keyPath!);
      expect(statSync(keyPath!).mode & 0o777).toBe(0o600);
      const hosts = /UserKnownHostsFile='([^']+)'/.exec(s.env.GIT_SSH_COMMAND!)?.[1];
      expect(hosts).toBeDefined(); const hostLine = readFileSync(hosts!, "utf8").trim().split(" ");
      expect(hostLine.slice(0, 2)).toEqual(["github.com", "ssh-ed25519"]);
      expect(createHash("sha256").update(Buffer.from(hostLine[2]!, "base64")).digest("base64").replace(/=+$/, "")).toBe("+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
      expect(readFileSync(keyPath!, "utf8")).toBe(Buffer.from(tier === "preview" ? PREVIEW : PRODUCTION, "base64").toString());
    }
    if (s.args.includes("push") && failure === "push") return { ...ok(), code: 1 };
    try {
      // Transport seam only: substitute local bare repos and allow file transport in the test child.
      return ok(execFileSync(s.bin, args, { cwd: s.cwd, env: { ...s.env, GIT_ALLOW_PROTOCOL: "file" }, encoding: "utf8", stdio: "pipe" }));
    } catch (error) { const e = error as { status: number; stdout: string; stderr: string }; return { ...ok(String(e.stdout)), code: e.status, stderr: String(e.stderr) }; }
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    urls.push(String(url)); expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeDefined();
    if (failure === "hang") return new Promise(() => {});
    if (failure === "oversize") return new Response("x".repeat(4097));
    if (failure === "redirect") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } });
    return new Response(JSON.stringify({ manifestHash: markerDelay-- > 0 ? "0".repeat(64) : marker }));
  };
  const options: DeployAdapterOptions = { ledger, project: "p", projectConfig: config, resolveManifest: hash => manifests.get(hash), providers: { render: pin },
    run, fetch, readiness: { timeoutMs: 60, intervalMs: 1 }, readyToPromote: () => true };
  const broker = () => new Broker({ ledger, project: "p", adapters: deployAdapters(options), secrets: { get(key) { reads.push(key); if (missingKey) return undefined; return key === "RENDER_PREVIEW_DEPLOY_KEY" ? PREVIEW : key === "RENDER_PRODUCTION_DEPLOY_KEY" ? PRODUCTION : undefined; } } });
  const request = (m = manifest, action: "preview" | "promote" | "rollback" = "preview") => ({ op: action === "preview" ? "deploy.preview" : "deploy.promote", payload: { ref: releaseRef(m, action) } }) as const;
  const git = (tier: keyof typeof repos, args: string[]) => execFileSync(GIT, ["--git-dir", repos[tier], ...args], { env: runnerGitEnv(dir), stdio: "pipe" });
  return { dir, ledger, manifest, config, pin, options, calls, reads, keys, urls, broker, request, git, manifests,
    missingKey: () => { missingKey = true; },
    fail: (value: string) => { failure = value; }, marker: (value: string, delay = 0) => { marker = value; markerDelay = delay; }, observe: (fn: typeof observe) => { observe = fn; } };
}

describe("Render broker deploys", () => {
  it("is a registry provider and pushes exactly the approved bytes plus the runner JSON marker", async () => {
    expect(PROVIDERS).toHaveProperty("render");
    const f = fixture(); const result = await f.broker().handle(f.request()); expect(result.status).toBe("succeeded");
    expect(f.git("preview", ["ls-tree", "-r", "--name-only", "main"]).toString().trim().split("\n")).toEqual([".jarvis-build.json", "image.png", "index.html"]);
    for (const file of ["image.png", "index.html"]) expect(f.git("preview", ["show", `main:${file}`])).toEqual(readFileSync(join(f.manifest.artifactDir, file)));
    expect(JSON.parse(f.git("preview", ["show", "main:.jarvis-build.json"]).toString())).toEqual({ manifestHash: manifestHash(f.manifest) });
    expect(f.keys.length).toBeGreaterThan(0); expect(f.keys.some(existsSync)).toBe(false);
    expect(readdirSync(f.config.privateRoot)).toEqual([]);
  });
  it.each(["package.json", "nested/run.sh", ".git/config", ".jarvis-build.json", "render.yaml"])("refuses candidate %s before any process or credential read", async file => {
    const f = fixture(); mkdirSync(join(f.manifest.artifactDir, file, ".."), { recursive: true }); writeFileSync(join(f.manifest.artifactDir, file), "hostile");
    f.manifest.artifactHash = artifactDigest(f.manifest.artifactDir); f.config.artifacts[f.manifest.revision] = f.manifest.artifactHash;
    f.manifests.set(manifestHash(f.manifest), f.manifest);
    expect((await f.broker().handle(f.request())).status).toBe("failed"); expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
  });
  it("rejects a digest mismatch before processes and credentials", async () => {
    const f = fixture(); writeFileSync(join(f.manifest.artifactDir, "index.html"), "tampered");
    expect((await f.broker().handle(f.request())).status).toBe("failed"); expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
  });
  it("keeps tiers separate and locks down SSH, git and the entire child environment", async () => {
    const f = fixture(); vi.stubEnv("OTHER_TOKEN", "DUMMY other secret"); vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("SSH_AUTH_SOCK", "/host/agent");
    expect((await f.broker().handle(f.request())).status).toBe("succeeded");
    expect(f.reads).toEqual(["RENDER_PREVIEW_DEPLOY_KEY"]);
    const network = f.calls.filter(s => s.args.includes(destinations.preview.repo)); expect(network.length).toBeGreaterThan(0);
    for (const s of network) {
      expect(s.bin).toBe(GIT); expect(s.env).toEqual({ ...runnerGitEnv(s.env.HOME!), GIT_ALLOW_PROTOCOL: "ssh", GIT_SSH_VARIANT: "ssh", GIT_SSH_COMMAND: expect.any(String) });
      expect(s.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.untrackedCache=false", "commit.gpgsign=false", "protocol.file.allow=never"]));
      for (const option of ["/usr/bin/ssh", "-F /dev/null", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "IdentityAgent=none", "GlobalKnownHostsFile=/dev/null", "HostKeyAlgorithms=ssh-ed25519"]) expect(s.env.GIT_SSH_COMMAND).toContain(option);
      expect(s.args.some(a => a.includes("force") || a.startsWith("+"))).toBe(false);
      expect(Object.values(s.env).join(" ")).not.toContain(PREVIEW);
    }
    expect(readFileSync(join(f.ledger.dir, "ledger.jsonl"), "utf8")).not.toContain(PREVIEW);
  });
  it("waits for the right marker before succeeding and then the existing smoke test checks it", async () => {
    const f = fixture(); f.marker(manifestHash(f.manifest), 2); const b = f.broker();
    expect((await b.handle(f.request())).status).toBe("succeeded"); expect(f.urls.length).toBe(3);
    const receipt = f.ledger.entries().findLast(e => e.kind === "broker_receipt")!;
    const smoke = await runSmoke({ ledger: f.ledger, manifest: f.manifest, projectConfig: f.config, deploymentSeq: receipt.seq, fetch: f.options.fetch! });
    expect(smoke.data).toMatchObject({ status: "pass" }); expect(f.urls).toContain(`${destinations.preview.url}/.jarvis-build.json`);
  });
  it("records the actual HTTP status when the Render marker smoke check fails", async () => {
    const f = fixture(); expect((await f.broker().handle(f.request())).status).toBe("succeeded"); f.fail("redirect");
    const receipt = f.ledger.entries().findLast(e => e.kind === "broker_receipt")!;
    const smoke = await runSmoke({ ledger: f.ledger, manifest: f.manifest, projectConfig: f.config, deploymentSeq: receipt.seq, retries: 0, fetch: f.options.fetch! });
    expect(smoke.data).toMatchObject({ status: "fail", observations: expect.arrayContaining([{ origin: destinations.preview.url, path: "/.jarvis-build.json", statuses: [302], passed: false }]) });
  });
  it.each(["stale", "hang", "oversize", "redirect", "push"])("returns unknown for %s, cleans up, and never retries a push", async mode => {
    const f = fixture(); f.fail(mode); if (mode === "stale") f.marker("0".repeat(64));
    const b = f.broker(); expect((await b.handle(f.request())).status).toBe("unknown"); expect((await b.handle(f.request())).status).toBe("duplicate");
    expect(f.calls.filter(s => s.args.includes("push"))).toHaveLength(1); expect(f.keys.some(existsSync)).toBe(false);
  });
  it("wires the release runtime to native tools, tier keys and the injected readiness transport", async () => {
    const f = fixture(); const workRoot = join(f.dir, "work");
    const artifactDir = join(workRoot, "release/p/artifacts/first"); cpSync(f.manifest.artifactDir, artifactDir, { recursive: true });
    const m = { ...f.manifest, artifactDir }; f.marker(manifestHash(m));
    saveReleaseSetup(f.ledger.dir, parseReleaseSetup({ version: 1, provider: "render", plan: "free", siteId: m.siteId,
      productionUrl: m.productionUrl, render: destinations, build: { command: "npm run build", output: "dist" } }));
    f.ledger.append({ kind: "decision", actor: "runner", data: { type: ARTIFACT_TYPE, project: "p", revision: m.revision, artifactHash: m.artifactHash } });
    recordAcceptedManifest(f.ledger, m);
    const runtime = await prepareRelease({ projectId: "p", projectDir: f.ledger.dir, workRoot, worktreeRoot: join(workRoot, "worktrees"), repoPath: f.dir, home: f.dir, ledger: f.ledger }, {
      run: f.options.run!, fetch: f.options.fetch!, cli: { nativeTools: [ { bin: GIT, version: f.pin.version, args: ["--version"] }, { ...f.pin.ssh!, args: ["-V"] } ], run: f.options.run! },
    });
    expect(runtime?.providerConfig).toMatchObject({ bin: GIT, ssh: f.pin.ssh }); expect(runtime?.providerConfig).not.toHaveProperty("interpreter");
    const b = new Broker({ ledger: f.ledger, project: "p", adapters: runtime!.adapters, secrets: { get: key => key === "RENDER_PREVIEW_DEPLOY_KEY" ? PREVIEW : undefined } });
    expect((await b.handle(f.request(m))).status).toBe("succeeded"); expect(f.urls).toEqual([`${destinations.preview.url}/.jarvis-build.json`]);
  });
  it.each(["unaccepted", "absent"])("refuses a promotion as failed, not unknown, when production serves an %s manifest: nothing was pushed", async mode => {
    const f = fixture(); const b = f.broker(); grantRelease(b, f.manifest, "person", true);
    if (mode === "unaccepted") f.marker("c".repeat(64)); else f.fail("oversize");
    const result = await b.handle(f.request(f.manifest, "promote"));
    expect(result.status).toBe("failed");
    expect(f.calls.filter(s => s.args.includes("push") || s.args.includes("ls-remote"))).toEqual([]); expect(f.reads).toEqual([]);
    expect(f.ledger.entries().some(e => e.kind === "decision" && (e.data as { type?: string }).type === "release.production-before")).toBe(false);
  });
  it("never falls back to another tier's key", async () => {
    const f = fixture(); f.missingKey();
    expect((await f.broker().handle(f.request())).status).toBe("failed");
    expect(f.reads).toEqual(["RENDER_PREVIEW_DEPLOY_KEY"]);
    expect(f.calls.every(s => s.args.includes("--version") || s.args.includes("-V"))).toBe(true);
  });
  it("refuses wrong tool versions before reading a key", async () => {
    const f = fixture(); f.fail("version"); expect((await f.broker().handle(f.request())).status).toBe("failed"); expect(f.reads).toEqual([]);
  });
  it("promotes with only the production key and rolls back by adding a new commit of the earlier verified tree", async () => {
    const f = fixture(), old = f.manifest;
    const nextDir = join(f.config.artifactRoot, "next"); mkdirSync(nextDir); writeFileSync(join(nextDir, "index.html"), "second"); writeFileSync(join(nextDir, "new.txt"), "new");
    const next: ReleaseManifest = { ...old, revision: "b".repeat(40), artifactDir: nextDir, artifactHash: artifactDigest(nextDir) };
    f.config.artifacts[next.revision] = next.artifactHash; f.manifests.set(manifestHash(next), next);
    // The existing production site serves a previously approved manifest. Each readback follows the push.
    f.marker(manifestHash(old)); f.observe(s => { if (s.args.includes("push")) f.marker(manifestHash(next)); });
    const b = f.broker(); grantRelease(b, next, "person", true);
    expect((await b.handle(f.request(next, "promote"))).status).toBe("succeeded");
    const promoted = f.git("production", ["rev-parse", "main"]).toString().trim();
    f.observe(s => { if (s.args.includes("push")) f.marker(manifestHash(old)); });
    expect((await b.handle(f.request(next, "rollback"))).status).toBe("succeeded");
    expect(f.git("production", ["rev-parse", "main^"]).toString().trim()).toBe(promoted);
    expect(f.git("production", ["show", "main:index.html"]).toString()).toBe("first\r\n");
    expect(f.git("production", ["ls-tree", "-r", "--name-only", "main"]).toString()).not.toContain("new.txt");
    expect(f.reads).toEqual(["RENDER_PRODUCTION_DEPLOY_KEY", "RENDER_PRODUCTION_DEPLOY_KEY"]);
  });
  it("refuses identical tier repos and non-Render or insecure URLs before running", async () => {
    for (const edit of [ (c: ReleaseProjectConfig) => { c.render!.preview.repo = c.render!.production.repo; },
      (c: ReleaseProjectConfig) => { c.render!.preview.url = "http://habits.onrender.com"; },
      (c: ReleaseProjectConfig) => { c.render!.preview.repo = "git@evil.example:owner/repo.git"; } ]) {
      const f = fixture(); edit(f.config); expect((await f.broker().handle(f.request())).status).toBe("failed"); expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
    }
  });
});

describe("Render protected release setup", () => {
  const input = { version: 1, provider: "render", plan: "free", siteId: "habits", productionUrl: destinations.production.url, render: destinations, build: { command: "npm run build", output: "dist" } };
  it("accepts two distinct GitHub repos and two HTTPS Render origins on the free plan", () => { expect(parseReleaseSetup(input)).toMatchObject(input); });
  it.each([
    { plan: "paid" }, { render: undefined }, { productionUrl: "https://different.onrender.com" },
    { render: { ...destinations, preview: destinations.production } },
    { render: { ...destinations, preview: { ...destinations.preview, branch: "-bad" } } },
  ])("refuses invalid Render setup %j", changes => { expect(() => parseReleaseSetup({ ...input, ...changes })).toThrow(); });
});
