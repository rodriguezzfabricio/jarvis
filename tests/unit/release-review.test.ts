import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { deployAdapters } from "../../packages/cli/src/broker/adapters/index.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { artifactDigest, manifestHash, parseManifest, releaseRef } from "../../packages/cli/src/release/manifest.ts";
import { grantRelease } from "../../packages/cli/src/release/grants.ts";
import { runRehearsal } from "../../packages/cli/src/release/rehearsal.ts";
import * as rehearsal from "../../packages/cli/src/release/rehearsal.ts";
import { reachState, recordObservation } from "../../packages/cli/src/release/states.ts";
import { recoverFailedSmoke, runSmoke } from "../../packages/cli/src/release/smoke.ts";
import { notifierSummary, renderReport } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";

const root = mkdtempSync(join(tmpdir(), "release-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const outcome = (stdout = "", code = 0) => ({ code, timedOut: false, overflowed: false, durationMs: 1, stdout, stderr: "" });
function setup(provider: "vercel" | "netlify" = "vercel", project = "p") {
  const dir = join(root, String(++n));
  const ledger = Ledger.open(join(dir, "runner"));
  const artifactRoot = join(dir, "artifacts"); const artifactDir = join(artifactRoot, "build");
  const privateRoot = join(ledger.dir, "deployments"); const snapshotRoot = join(ledger.dir, "snapshots");
  for (const p of [artifactDir, privateRoot, snapshotRoot]) mkdirSync(p, { recursive: true });
  writeFileSync(join(artifactDir, "index.html"), "original");
  const m = parseManifest({ version: 1, project, revision: "a".repeat(40), provider, artifactDir, artifactHash: artifactDigest(artifactDir), siteId: "site",
    productionUrl: "https://app.example.com", smokePaths: ["/health"], data: { kind: "none" },
    rollback: { deploymentId: "session-chosen", url: "https://session.example.com", steps: ["Restore recorded previous production."] } });
  const projectConfig = { project, provider, siteId: m.siteId, orgId: "runner-org", productionUrl: m.productionUrl, artifactRoot, privateRoot, snapshotRoot,
    artifacts: { [m.revision]: m.artifactHash } };
  const providerUrl = `https://new.${provider === "vercel" ? "vercel.app" : "netlify.app"}`;
  const current = { id: "runner-captured-id", url: `https://old.${provider === "vercel" ? "vercel.app" : "netlify.app"}` };
  const calls: SessionSpec[] = []; const reads: string[] = [];
  let beforeRun: ((spec: SessionSpec) => void) | undefined;
  const config = { bin: `/trusted/bin/${provider}`, home: ledger.dir, cwd: ledger.dir };
  const run = async (spec: SessionSpec) => {
    calls.push(spec); beforeRun?.(spec);
    if (spec.args.includes("inspect")) return outcome(JSON.stringify({ ...current, projectId: m.siteId }));
    if (spec.args.includes("getSite")) return outcome(JSON.stringify({ id: m.siteId, published_deploy: { id: current.id, deploy_ssl_url: current.url } }));
    return outcome(provider === "vercel" ? providerUrl : JSON.stringify({ deploy_url: providerUrl, url: m.productionUrl }));
  };
  const makeBroker = (manifest = m, trusted = projectConfig) => new Broker({ ledger, project: "p", secrets: { get: key => { reads.push(key); return "FAKE_ADAPTER_ONLY"; } },
    adapters: deployAdapters({ ledger, project: "p", projectConfig: trusted, resolveManifest: () => manifest, providers: { [provider]: config }, readyToPromote: () => true, run }) });
  return { ledger, m, projectConfig, calls, reads, providerUrl, current, makeBroker, setBeforeRun: (fn: (s: SessionSpec) => void) => { beforeRun = fn; } };
}
function allEvidenceFiles(dir: string): string {
  let contents = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    contents += e.isDirectory() ? allEvidenceFiles(path) : readFileSync(path, "utf8");
  }
  return contents;
}

describe("review H1: snapshot confinement and output containment", () => {
  it("creates a fresh data snapshot from runner project configuration", () => {
    const { ledger, projectConfig } = setup(); const source = join(ledger.dir, "configured-dump"); writeFileSync(source, "configured data");
    const saved = rehearsal.createDataSnapshot({ ...projectConfig, dataSnapshot: { kind: "postgres", source } });
    expect(saved.kind).toBe("postgres"); expect(saved.source.startsWith(realpathSync(projectConfig.snapshotRoot) + "/")).toBe(true);
    writeFileSync(source, "changed later"); expect(readFileSync(saved.source, "utf8")).toBe("configured data");
  });
  it.each([false, true])("refuses a fake secret outside snapshotRoot (symlink=%s) before executing", async symlink => {
    const { ledger, m, projectConfig } = setup();
    const secret = join(ledger.dir, "fake-secret.env"); writeFileSync(secret, "FAKE_SOURCE_SECRET_SENTINEL");
    const source = symlink ? join(projectConfig.snapshotRoot, "escape") : secret;
    if (symlink) symlinkSync(secret, source);
    let calls = 0;
    const manifest = parseManifest({ ...m, data: { kind: "sqlite", source, commands: { migrate: "cat $JARVIS_DATA_COPY", verify: "verify", backup: "backup", restore: "restore" } } });
    const result = await runRehearsal({ ledger, manifest, snapshotRoot: projectConfig.snapshotRoot, workRoot: ledger.dir,
      execute: async spec => { calls++; return outcome(readFileSync(spec.env.JARVIS_DATA_COPY!, "utf8")); } });
    expect(calls).toBe(0);
    expect(result.rehearsal.data).toMatchObject({ status: "fail" });
    expect(allEvidenceFiles(join(ledger.dir, "evidence"))).not.toContain("FAKE_SOURCE_SECRET_SENTINEL");
  });
  it("stores only output byte counts and hashes; no sentinel reaches ledger, evidence, report or notifier", async () => {
    const { ledger, m, projectConfig } = setup();
    const source = join(projectConfig.snapshotRoot, "data.sqlite"); writeFileSync(source, "data");
    const sentinel = "FAKE_COMMAND_OUTPUT_SENTINEL";
    const manifest = parseManifest({ ...m, data: { kind: "sqlite", source, commands: { migrate: "migrate", verify: "verify", backup: "backup", restore: "restore" } } });
    const result = await runRehearsal({ ledger, manifest, snapshotRoot: projectConfig.snapshotRoot, workRoot: ledger.dir,
      execute: async () => ({ ...outcome(sentinel, 1), stderr: sentinel }) });
    const entries = ledger.entries(); const state = rebuildState(entries, { now: 0 });
    for (const text of [JSON.stringify(entries), allEvidenceFiles(join(ledger.dir, "evidence")), renderReport(state, entries), notifierSummary(state, entries)]) expect(text).not.toContain(sentinel);
    expect(result.rehearsal.data).toMatchObject({ observations: [expect.objectContaining({ code: 1, timedOut: false,
      stdoutBytes: Buffer.byteLength(sentinel), stderrBytes: Buffer.byteLength(sentinel), stdoutHash: createHash("sha256").update(sentinel).digest("hex") })] });
  });
});

describe("review H2 and artifact/rollback boundaries", () => {
  it("accepts rollback steps without any session-selected target", () => {
    const { m } = setup();
    expect(() => parseManifest({ ...m, rollback: { steps: ["Restore recorded production."] } })).not.toThrow();
  });
  it.each(["vercel", "netlify"] as const)("uses %s provider-reported deploy URL", async provider => {
    const { m, makeBroker, providerUrl } = setup(provider); const broker = makeBroker(); grantRelease(broker, m, "person", true);
    const r = await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } });
    expect(r.status).toBe("succeeded"); expect(r.receipt).toMatchObject({ detail: { url: providerUrl } });
  });
  it.each(["siteId", "productionUrl"] as const)("refuses manifest %s differing from runner configuration before reading a token", async field => {
    const { m, makeBroker, reads, calls } = setup();
    const altered = parseManifest({ ...m, [field]: field === "siteId" ? "other-site" : "https://always200.example.com" });
    const broker = makeBroker(altered); grantRelease(broker, altered, "person", true);
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(altered, "promote") } })).status).toBe("failed");
    expect(reads).toEqual([]); expect(calls).toEqual([]);
  });
  it("rejects cross-project manifests even when their own setup configuration matches", async () => {
    const { m, makeBroker, reads, calls } = setup("vercel", "q");
    expect((await makeBroker().handle({ op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } })).status).toBe("failed");
    expect(reads).toEqual([]); expect(calls).toEqual([]);
  });
  it("refuses artifact paths outside runner artifactRoot", async () => {
    const { m, projectConfig, makeBroker, reads } = setup(); const artifactRoot = join(projectConfig.artifactRoot, "other"); mkdirSync(artifactRoot);
    const broker = makeBroker(m, { ...projectConfig, artifactRoot });
    expect((await broker.handle({ op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } })).status).toBe("failed");
    expect(reads).toEqual([]);
  });
  it("refuses staging outside the runner project before reading credentials", async () => {
    const { m, projectConfig, makeBroker, reads } = setup(); const privateRoot = join(projectConfig.artifactRoot, "public-staging"); mkdirSync(privateRoot);
    expect((await makeBroker(m, { ...projectConfig, privateRoot }).handle({ op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } })).status).toBe("failed");
    expect(reads).toEqual([]);
  });
  it("refuses an artifact hash not approved for this revision", async () => {
    const { m, makeBroker, reads } = setup(); const altered = parseManifest({ ...m, revision: "b".repeat(40) });
    expect((await makeBroker(altered).handle({ op: "deploy.preview", payload: { ref: releaseRef(altered, "preview") } })).status).toBe("failed");
    expect(reads).toEqual([]);
  });
  it("replaces session Vercel project metadata with the trusted site and organization", async () => {
    const { m, projectConfig, makeBroker, setBeforeRun } = setup();
    mkdirSync(join(m.artifactDir, ".vercel"));
    writeFileSync(join(m.artifactDir, ".vercel/project.json"), JSON.stringify({ projectId: "session-site", orgId: "session-org" }));
    const manifest = parseManifest({ ...m, artifactHash: artifactDigest(m.artifactDir) });
    const trusted = { ...projectConfig, artifacts: { [m.revision]: manifest.artifactHash } };
    let linked: unknown;
    setBeforeRun(spec => { const dir = spec.args[spec.args.indexOf("--cwd") + 1]!; linked = JSON.parse(readFileSync(join(dir, ".vercel/project.json"), "utf8")); });
    expect((await makeBroker(manifest, trusted).handle({ op: "deploy.preview", payload: { ref: releaseRef(manifest, "preview") } })).status).toBe("succeeded");
    expect(linked).toEqual({ projectId: m.siteId, orgId: projectConfig.orgId });
  });
  it.each(["vercel", "netlify"] as const)("deploys an immutable %s private copy with the release marker despite live source replacement", async provider => {
    const { m, makeBroker, projectConfig, setBeforeRun } = setup(provider);
    let deployedDir = ""; let deployedBytes = ""; let marker = "";
    setBeforeRun(spec => {
      const flag = provider === "vercel" ? "--cwd" : "--dir";
      deployedDir = spec.args[spec.args.indexOf(flag) + 1]!;
      writeFileSync(join(m.artifactDir, "index.html"), "swapped by session");
      deployedBytes = readFileSync(join(deployedDir, "index.html"), "utf8");
      const markerPath = provider === "vercel" ? join(deployedDir, ".vercel/output/static/.well-known/jarvis-release") : join(deployedDir, ".well-known/jarvis-release");
      marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "missing";
    });
    const r = await makeBroker().handle({ op: "deploy.preview", payload: { ref: releaseRef(m, "preview") } });
    expect(r.status).toBe("succeeded"); expect(deployedDir.startsWith(realpathSync(projectConfig.privateRoot) + "/")).toBe(true);
    expect(deployedBytes).toBe("original"); expect(marker).toBe(manifestHash(m));
    expect(existsSync(deployedDir)).toBe(false);
  });
  it.each(["vercel", "netlify"] as const)("captures %s current production before promotion and rolls back only to the recorded ID", async provider => {
    const { ledger, m, makeBroker, calls, current, setBeforeRun } = setup(provider); const broker = makeBroker(); grantRelease(broker, m, "person", true);
    setBeforeRun(spec => {
      if (spec.args[0] === "deploy" && spec.args.includes("--prod")) expect(ledger.entries().some(e => e.kind === "decision"
        && (e.data as { type?: string }).type === "release.production-before")).toBe(true);
    });
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "promote") } })).status).toBe("succeeded");
    expect((await broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(m, "rollback") } })).status).toBe("succeeded");
    expect(calls[0]!.args).toContain(provider === "vercel" ? "inspect" : "getSite");
    expect(calls.at(-1)!.args.join(" ")).toContain(current.id);
    expect(calls.at(-1)!.args.join(" ")).not.toContain("session-chosen");
    const recorded = ledger.entries().find(e => e.kind === "decision" && (e.data as { type?: string }).type === "release.production-before");
    expect(recorded?.data).toMatchObject({ deployment: current, manifestHash: manifestHash(m) });
  });
});

describe("review smoke identity and failure signal", () => {
  it("refuses an always-200 preview serving the wrong release marker", async () => {
    const { ledger, m, projectConfig } = setup(); const deployment = ledger.append({ kind: "broker_receipt", actor: "broker", data: { op: "deploy.preview", status: "succeeded",
      detail: { action: "preview", manifestHash: manifestHash(m), url: "https://new.vercel.app" } } });
    const result = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq: deployment.seq, retries: 0, fetch: async () => new Response("wrong release") });
    expect(result.data).toMatchObject({ status: "fail" });
  });
  it("checks the reported deployment and the trusted production origin for the same release", async () => {
    const { ledger, m, projectConfig, providerUrl } = setup(); const urls: string[] = [];
    const deployment = ledger.append({ kind: "broker_receipt", actor: "broker", data: { op: "deploy.promote", status: "succeeded",
      detail: { action: "promote", manifestHash: manifestHash(m), url: providerUrl } } });
    const result = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq: deployment.seq, retries: 0, fetch: async url => {
      urls.push(String(url)); return new Response(String(url).startsWith(m.productionUrl) ? "wrong release" : manifestHash(m));
    } });
    expect(urls).toContain(providerUrl + "/.well-known/jarvis-release");
    expect(urls).toContain(m.productionUrl + "/.well-known/jarvis-release");
    expect(result.data).toMatchObject({ status: "fail" });
  });
  it("keeps failureSignal missing even when a generic observation says pass", () => {
    const { ledger, m } = setup(); const fake = recordObservation(ledger, m, "failure-signal", "pass");
    const result = reachState({ ledger, manifest: m, state: "deployed", evidence: { failureSignal: fake.seq } });
    expect(result.missing).toContain("failureSignal"); expect(result.entry).toBeUndefined();
  });
  it("never mentions production rollback when preview smoke fails", async () => {
    const { ledger, m } = setup(); const deploy = ledger.append({ kind: "broker_receipt", actor: "broker", data: { op: "deploy.preview", status: "succeeded",
      detail: { action: "preview", manifestHash: manifestHash(m), url: "https://new.vercel.app" } } });
    const smoke = recordObservation(ledger, m, "preview", "fail", { deploymentSeq: deploy.seq }); const messages: string[] = [];
    await recoverFailedSmoke({ ledger, manifest: m, smokeSeq: smoke.seq, broker: { handle: async () => { throw new Error("must not act"); } }, notify: async text => { messages.push(text); } });
    expect(messages.join(" ")).toMatch(/preview/i); expect(messages.join(" ")).not.toMatch(/production|rollback/i);
  });
});
