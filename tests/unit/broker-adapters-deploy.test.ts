import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { SessionSpec, SessionOutcome } from "../../packages/cli/src/proc/session.ts";
import { parseManifest, manifestHash, releaseRef, artifactDigest } from "../../packages/cli/src/release/manifest.ts";
import { grantRelease } from "../../packages/cli/src/release/grants.ts";
import { deployAdapters } from "../../packages/cli/src/broker/adapters/index.ts";

const root = mkdtempSync(join(tmpdir(), "deploy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TOKEN = "FAKE-release-token-never-a-real-credential";
let n = 0;
function setup(provider: "vercel" | "netlify" = "vercel", behavior?: (s: SessionSpec) => Promise<SessionOutcome>) {
  const dir = join(root, `p${++n}`); const ledger = Ledger.open(join(dir, "runner"));
  const artifactRoot = join(dir, "artifacts"); const artifactDir = join(artifactRoot, "build"); const privateRoot = join(ledger.dir, "deployments");
  mkdirSync(artifactDir, { recursive: true }); mkdirSync(privateRoot);
  writeFileSync(join(artifactDir, "index.html"), "original");
  const m = parseManifest({ version: 1, project: "p", revision: "a".repeat(40), provider, artifactDir, artifactHash: artifactDigest(artifactDir), siteId: "site-1",
    productionUrl: "https://app.example.com", smokePaths: ["/health"], data: { kind: "none" },
    rollback: { deploymentId: "old-deploy", url: `https://old.${provider === "vercel" ? "vercel.app" : "netlify.app"}`, steps: ["Restore then verify."] } });
  const calls: SessionSpec[] = [];
  const reads: string[] = [];
  const projectConfig = { project: m.project, provider, siteId: m.siteId, orgId: "runner-org", productionUrl: m.productionUrl,
    artifactRoot, privateRoot, snapshotRoot: ledger.dir, artifacts: { [m.revision]: m.artifactHash } };
  const adapters = deployAdapters({ ledger, project: "p", resolveManifest: hash => hash === manifestHash(m) ? m : undefined,
    projectConfig, readyToPromote: () => true,
    providers: { [provider]: { bin: `/trusted/bin/${provider}`, home: "/trusted/home", cwd: "/trusted/control" } },
    run: async spec => { calls.push(spec);
      if (spec.args.includes("inspect")) return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: JSON.stringify({ id: "old-deploy", url: "https://old.vercel.app", projectId: m.siteId }), stderr: "" };
      if (spec.args.includes("getSite")) return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: JSON.stringify({ id: m.siteId, published_deploy: { id: "old-deploy", deploy_ssl_url: "https://old.netlify.app" } }), stderr: "" };
      return behavior ? behavior(spec) : { code: 0, timedOut: false, overflowed: false, durationMs: 1,
      stdout: provider === "vercel" ? "https://new.vercel.app\n" : '{"deploy_url":"https://new.netlify.app","url":"https://app.example.com"}', stderr: "" }; } });
  const broker = new Broker({ ledger, project: "p", adapters, secrets: { get: key => { reads.push(key); return TOKEN; } } });
  return { ledger, m, projectConfig, calls, reads, broker, adapters };
}

describe("provider adapters through the broker", () => {
  it.each(["vercel", "netlify"] as const)("runs %s previews without approval and gives only its child a preview token", async provider => {
    const { ledger, m, calls, reads, broker } = setup(provider);
    const result = await broker.handle({ op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } });
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe(`/trusted/bin/${provider}`);
    expect(Object.values(calls[0]!.env).filter(v => v === TOKEN)).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).not.toContain(TOKEN);
    if (provider === "netlify") expect(calls[0]!.args).toContain("--no-build");
    expect(calls[0]!.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(reads).toEqual([`${provider.toUpperCase()}_PREVIEW_TOKEN`]);
    expect(readFileSync(join(ledger.dir, "ledger.jsonl"), "utf8")).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it("requires a grant bound to this exact manifest, even with a generic project grant", async () => {
    const { broker, m, calls } = setup();
    const req = { op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } } as const;
    expect((await broker.handle(req)).status).toBe("pending");
    broker.grant("deploy.promote", { project: "p" }, "person");
    expect((await broker.handle(req)).status).toBe("failed");
    expect(calls).toHaveLength(0);
    grantRelease(broker, m, "person", false);
    expect((await broker.handle(req)).status).toBe("succeeded");
    expect(calls).toHaveLength(2);
  });
  it("does not treat exact payload approval as a manifest grant", async () => {
    const { broker, m, calls } = setup();
    const req = { op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } } as const;
    const pending = await broker.handle(req); broker.decide(pending.approvalId!, "approve", "person");
    expect((await broker.handle(req)).status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
  it.each(["vercel", "netlify"] as const)("runs %s production and rollback through the same grant class", async provider => {
    const { broker, m, calls, reads } = setup(provider);
    grantRelease(broker, m, "person", true);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } })).status).toBe("succeeded");
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "rollback") } })).status).toBe("succeeded");
    expect(calls).toHaveLength(3);
    expect(calls[2]!.args.join(" ")).toContain(provider === "vercel" ? "rollback" : "restoreSiteDeploy");
    expect(reads).toEqual([`${provider.toUpperCase()}_PRODUCTION_TOKEN`, `${provider.toUpperCase()}_PRODUCTION_TOKEN`]);
  });
  it("rejects rollback if the bound grant omitted automatic rollback", async () => {
    const { broker, m, calls } = setup(); grantRelease(broker, m, "person", false);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } })).status).toBe("succeeded");
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "rollback") } })).status).toBe("failed");
    expect(calls).toHaveLength(2);
  });
  it("refuses missing/changed manifests and action confusion before reading a secret", async () => {
    const { broker, m, reads } = setup();
    for (const ref of ["abc", `release:${"b".repeat(64)}:preview`, releaseRef(m, "promote")]) {
      expect((await broker.handle({ op: "deploy.preview", payload: { ref } })).status).toBe("failed");
    }
    expect(reads).toEqual([]);
  });
  it.each(["output", "throw", "timeout"])("never leaks child secrets on %s and never retries an uncertain action", async mode => {
    const { broker, m, calls, ledger } = setup("vercel", async () => {
      if (mode === "throw") throw new Error(TOKEN);
      return { code: mode === "output" ? 1 : null, timedOut: mode === "timeout", overflowed: false, durationMs: 1, stdout: TOKEN, stderr: TOKEN };
    });
    const req = { op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } } as const;
    const result = await broker.handle(req);
    expect(result.status).toBe("unknown");
    expect((await broker.handle(req)).status).toBe("duplicate");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(readFileSync(join(ledger.dir, "ledger.jsonl"), "utf8")).not.toContain(TOKEN);
  });
  it("refuses relative CLI paths", () => {
    const { ledger, projectConfig } = setup();
    expect(() => deployAdapters({ ledger, project: "p", projectConfig, resolveManifest: () => undefined,
      providers: { vercel: { bin: "vercel", home: "/home", cwd: "/control" } } })).toThrow(/absolute/);
  });
  it("does not use a grant for another manifest", async () => {
    const { broker, m, calls } = setup();
    grantRelease(broker, { ...m, smokePaths: ["/changed"] }, "person", true);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } })).status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
  it("hashes artifact bytes and refuses symlinks", () => {
    const dir = join(root, `artifact${++n}`); mkdirSync(dir);
    writeFileSync(join(dir, "index.html"), "first");
    const hash = artifactDigest(dir);
    writeFileSync(join(dir, "index.html"), "changed");
    expect(artifactDigest(dir)).not.toBe(hash);
    symlinkSync(join(dir, "index.html"), join(dir, "link"));
    expect(() => artifactDigest(dir)).toThrow(/symlink/);
  });
  it("refuses changed artifact bytes before reading a credential", async () => {
    const { ledger, m, projectConfig } = setup(); const run = async (_spec: SessionSpec) => { throw new Error("must not execute"); };
    writeFileSync(join(m.artifactDir, "index.html"), "changed after approval");
    const adapters = deployAdapters({ ledger, project: "p", projectConfig, resolveManifest: () => m, run,
      providers: { vercel: { bin: "/trusted/bin/vercel", home: "/trusted/home", cwd: "/trusted/control" } } });
    let reads = 0;
    const broker = new Broker({ ledger, project: "p", adapters, secrets: { get: () => { reads++; return TOKEN; } } });
    expect((await broker.handle({ op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } })).status).toBe("failed");
    expect(reads).toBe(0);
  });
  it("does not promote before release-ready even with a bound grant", async () => {
    const { ledger, m, projectConfig } = setup(); let calls = 0;
    const adapters = deployAdapters({ ledger, project: "p", projectConfig, resolveManifest: () => m,
      providers: { vercel: { bin: "/trusted/bin/vercel", home: "/trusted/home", cwd: "/trusted/control" } },
      run: async () => { calls++; throw new Error("must not run"); } });
    const broker = new Broker({ ledger, project: "p", adapters, secrets: { get: () => TOKEN } });
    grantRelease(broker, m, "person", false);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } })).status).toBe("failed");
    expect(calls).toBe(0);
  });
});
