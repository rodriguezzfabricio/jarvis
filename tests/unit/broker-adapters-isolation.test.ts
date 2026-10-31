import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { deployAdapters } from "../../packages/cli/src/broker/adapters/index.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { copyDeploymentArtifacts } from "../../packages/cli/src/release/artifacts.ts";
import { artifactDigest, manifestHash, parseManifest, releaseRef } from "../../packages/cli/src/release/manifest.ts";
import { grantRelease } from "../../packages/cli/src/release/grants.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "adapter-isolation-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const TOKEN = "DUMMY-CANARY-PROVIDER-TOKEN";
const ok = (stdout = ""): SessionOutcome => ({ stdout, stderr: "", code: 0, timedOut: false, overflowed: false, durationMs: 1 });
function fixture(provider: "vercel" | "netlify", files: Record<string, string> = {}) {
  const room = mkdtempSync(join(root, "case-"));
  const ledger = Ledger.open(join(room, "runner"));
  const artifactDir = join(room, "build"); const privateRoot = join(ledger.dir, "private");
  mkdirSync(artifactDir); mkdirSync(privateRoot);
  for (const [name, content] of Object.entries({ "index.html": "approved", "assets/app.js": "browser code", ...files })) {
    mkdirSync(dirname(join(artifactDir, name)), { recursive: true }); writeFileSync(join(artifactDir, name), content);
  }
  const m = parseManifest({ version: 1, project: "p", provider, revision: "a".repeat(40), artifactDir, artifactHash: artifactDigest(artifactDir),
    siteId: "site", productionUrl: "https://app.example.com", smokePaths: ["/"], data: { kind: "none" }, rollback: { steps: ["Restore captured target"] } });
  const projectConfig = { project: "p", provider, siteId: "site", orgId: "org", productionUrl: m.productionUrl, artifactRoot: artifactDir,
    privateRoot, snapshotRoot: privateRoot, artifacts: { [m.revision]: m.artifactHash } };
  const config = { bin: `/trusted/bin/${provider}`, version: "1.2.3", home: privateRoot, cwd: privateRoot };
  const calls: SessionSpec[] = []; const reads: string[] = [];
  let inspectCount = 0;
  let inspect = (_count: number): SessionOutcome => current("old");
  let version = (): SessionOutcome => ok(provider === "vercel" ? "1.2.3\n" : "netlify/1.2.3 darwin-arm64 node-v24.0.0\n");
  let observe = (_s: SessionSpec): void => {};
  function current(id: string, siteId = "site", url = `https://${id}.${provider === "vercel" ? "vercel.app" : "netlify.app"}`) {
    return ok(JSON.stringify(provider === "vercel" ? { id, url, projectId: siteId } : { id: siteId, published_deploy: { id, deploy_ssl_url: url } }));
  }
  const adapters = () => deployAdapters({ ledger, project: "p", projectConfig, resolveManifest: () => m, readyToPromote: () => true,
    providers: { [provider]: config }, run: async s => {
      calls.push(s); observe(s);
      if (s.args.includes("--version")) return version();
      if (s.args.includes("inspect") || s.args.includes("getSite")) return inspect(++inspectCount);
      return ok(provider === "vercel" ? "https://new.vercel.app" : '{"deploy_url":"https://new.netlify.app"}');
    } });
  const broker = () => new Broker({ ledger, project: "p", adapters: adapters(), secrets: { get: key => { reads.push(key); return TOKEN; } } });
  return { m, projectConfig, ledger, config, calls, reads, broker, current, setInspect: (fn: typeof inspect) => { inspect = fn; },
    setVersion: (fn: typeof version) => { version = fn; }, setObserve: (fn: typeof observe) => { observe = fn; } };
}

const hostile = ["vercel.ts", "vercel.js", "vercel.mjs", "vercel.cjs", "VERCEL.TS", "netlify.toml", "netlify/functions/leak.js",
  ".netlify/plugins/leak.js", "netlify/edge-functions/leak.js", "package.json", ".npmrc", ".yarnrc.yml", "node_modules/hook.js",
  ".vercel/output/functions/leak.func/index.js", "vercel.json", "now.json", ".git/config", "assets/package.json", "payload.exe"];
describe.each(["vercel", "netlify"] as const)("%s credential isolation", provider => {
  it.each(hostile)("refuses approved but executable configuration %s before any process or credential read", async name => {
    const f = fixture(provider, { [name]: 'require("node:fs").writeFileSync("leaked", process.env.VERCEL_TOKEN || process.env.NETLIFY_AUTH_TOKEN)' });
    const result = await f.broker().handle({ op: "deploy.preview", payload: { ref: releaseRef(f.m, "preview") } });
    expect(result.status).toBe("failed"); expect(JSON.stringify(result)).toContain(/^(netlify|node_modules|\.netlify|\.vercel|\.git)\//.test(name) ? name.split("/")[0]! : name);
    expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
    expect(existsSync(join(f.m.artifactDir, "leaked"))).toBe(false);
  });
  it("constructs only static output and fixed metadata, checking the copied digest", () => {
    const f = fixture(provider); chmodSync(join(f.m.artifactDir, "assets/app.js"), 0o755);
    const staged = copyDeploymentArtifacts(f.m, f.projectConfig, f.ledger.dir);
    try {
      const web = join(staged.dir, provider === "vercel" ? ".vercel/output/static" : "public");
      expect(readFileSync(join(web, "index.html"), "utf8")).toBe("approved");
      expect(readFileSync(join(web, "assets/app.js"), "utf8")).toBe("browser code");
      expect(readFileSync(join(web, ".well-known/jarvis-release"), "utf8")).toBe(`${manifestHash(f.m)}\n`);
      expect(statSync(join(web, "assets/app.js")).mode & 0o111).toBe(0);
      if (provider === "vercel") {
        expect(JSON.parse(readFileSync(join(staged.dir, ".vercel/output/config.json"), "utf8"))).toEqual({ version: 3 });
        expect(JSON.parse(readFileSync(join(staged.dir, ".vercel/project.json"), "utf8"))).toEqual({ projectId: "site", orgId: "org" });
        expect(JSON.parse(readFileSync(join(staged.dir, "vercel.json"), "utf8"))).toEqual({ framework: null, buildCommand: "", installCommand: "" });
      } else expect(readFileSync(join(staged.dir, "netlify.toml"), "utf8")).toBe('[build]\npublish = "public"\ncommand = ""\n');
    } finally { staged.dispose(); }
    expect(existsSync(staged.dir)).toBe(false);
    writeFileSync(join(f.m.artifactDir, "index.html"), "unapproved");
    expect(() => copyDeploymentArtifacts(f.m, f.projectConfig, f.ledger.dir)).toThrow(/hash/);
  });
  it("uses exact pins, fresh private empty HOME/cwd and an exact child environment", async () => {
    const f = fixture(provider); vi.stubEnv("NODE_OPTIONS", "--require=/candidate/steal.js"); vi.stubEnv("OTHER_TOKEN", "DUMMY-OTHER-TOKEN");
    f.setObserve(s => {
      expect(s.bin).toBe(f.config.bin); expect(s.cwd.startsWith(f.projectConfig.privateRoot + "/")).toBe(true);
      expect(s.env.HOME!.startsWith(f.projectConfig.privateRoot + "/")).toBe(true);
      expect(readdirSync(s.cwd)).toEqual([]); expect(readdirSync(s.env.HOME!)).toEqual([]);
      expect(statSync(s.cwd).mode & 0o077).toBe(0); expect(statSync(s.env.HOME!).mode & 0o077).toBe(0);
      if (s.args[0] === "deploy") {
        const flag = provider === "vercel" ? "--cwd" : "--dir";
        const deployed = s.args[s.args.indexOf(flag) + 1]!;
        expect(deployed.startsWith(f.projectConfig.privateRoot + "/")).toBe(true);
        const web = provider === "vercel" ? join(deployed, ".vercel/output/static") : deployed;
        writeFileSync(join(f.m.artifactDir, "index.html"), "changed after staging");
        expect(readFileSync(join(web, "index.html"), "utf8")).toBe("approved");
        expect(readFileSync(join(web, ".well-known/jarvis-release"), "utf8")).toBe(`${manifestHash(f.m)}\n`);
      }
    });
    const result = await f.broker().handle({ op: "deploy.preview", payload: { ref: releaseRef(f.m, "preview") } });
    expect(result.status).toBe("succeeded"); expect(f.calls).toHaveLength(2);
    const [probe, deploy] = f.calls;
    expect(probe!.args).toEqual(["--version"]); expect(probe!.env).toEqual({ PATH: "/usr/bin:/bin", HOME: probe!.env.HOME, CI: "1" });
    expect(deploy!.env).toEqual({ PATH: "/usr/bin:/bin", HOME: deploy!.env.HOME, CI: "1", ...(provider === "vercel"
      ? { VERCEL_TOKEN: TOKEN, VERCEL_PROJECT_ID: "site", VERCEL_ORG_ID: "org" } : { NETLIFY_AUTH_TOKEN: TOKEN }) });
    expect(deploy!.args).toContain(provider === "vercel" ? "--prebuilt" : "--no-build");
    expect(deploy!.args.join(" ")).not.toContain(TOKEN);
    if (provider === "netlify") {
      expect(deploy!.args).toContain("--config"); expect(deploy!.args[deploy!.args.indexOf("--dir") + 1]).toMatch(/\/public$/);
    }
    expect(deploy!.cwd).not.toBe(probe!.cwd); expect(deploy!.env.HOME).not.toBe(probe!.env.HOME);
    for (const s of f.calls) { expect(existsSync(s.cwd)).toBe(false); expect(existsSync(s.env.HOME!)).toBe(false); }
  });
  it.each(["mismatch", "malformed", "failure", "timeout", "overflow"])("refuses %s version verification before reading a token", async mode => {
    const f = fixture(provider);
    f.setVersion(() => ({ ...ok(mode === "mismatch" ? "9.9.9" : "some text mentions 1.2.3"),
      code: mode === "failure" ? 1 : 0, timedOut: mode === "timeout", overflowed: mode === "overflow" }));
    expect((await f.broker().handle({ op: "deploy.preview", payload: { ref: releaseRef(f.m, "preview") } })).status).toBe("failed");
    expect(f.reads).toEqual([]); expect(f.calls).toHaveLength(1);
  });
  it.each(["home", "cwd"] as const)("refuses unpinned versions and public %s roots before running", async field => {
    const f = fixture(provider); f.config.version = "latest";
    expect((await f.broker().handle({ op: "deploy.preview", payload: { ref: releaseRef(f.m, "preview") } })).status).toBe("failed");
    expect(f.calls).toEqual([]);
    f.config.version = "1.2.3"; f.config[field] = f.m.artifactDir;
    expect((await f.broker().handle({ op: "deploy.preview", payload: { ref: releaseRef(f.m, "preview") } })).status).toBe("failed");
    expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
  });
  it.each(["different-id", "different-url", "wrong-site", "malformed", "timeout", "overflow", "failure"])("returns unknown on rollback readback %s even after exit zero", async mode => {
    const f = fixture(provider); const broker = f.broker(); grantRelease(broker, f.m, "person", true);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(f.m, "promote") } })).status).toBe("succeeded");
    f.setInspect(() => mode === "malformed" ? ok("{}") : mode === "different-id" ? f.current("new") : mode === "wrong-site" ? f.current("old", "other")
      : mode === "different-url" ? f.current("old", "site", "https://different.example.com")
      : { ...f.current("old"), timedOut: mode === "timeout", overflowed: mode === "overflow", code: mode === "failure" ? 1 : 0 });
    const req = { op: "deploy.promote", payload: { ref: releaseRef(f.m, "rollback") } } as const;
    expect((await broker.handle(req)).status).toBe("unknown"); expect((await broker.handle(req)).status).toBe("duplicate");
  });
  it("succeeds only after rollback readback matches the recorded target", async () => {
    const f = fixture(provider); const broker = f.broker(); grantRelease(broker, f.m, "person", true);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(f.m, "promote") } })).status).toBe("succeeded");
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(f.m, "rollback") } })).status).toBe("succeeded");
    expect(f.calls.at(-1)!.args).toContain(provider === "vercel" ? "inspect" : "getSite");
  });
});
