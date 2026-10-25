import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { verifyEvidence } from "../../packages/cli/src/checks/gate.ts";
import type { BrokerRequest } from "../../packages/cli/src/broker/broker.ts";
import { parseManifest, manifestHash } from "../../packages/cli/src/release/manifest.ts";
import { runSmoke, recoverFailedSmoke } from "../../packages/cli/src/release/smoke.ts";

const root = mkdtempSync(join(tmpdir(), "smoke-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function setup(action: "preview" | "promote" = "promote") {
  const ledger = Ledger.open(join(root, `p${++n}`));
  const m = parseManifest({ version: 1, project: "p", revision: "a".repeat(40), provider: "vercel", artifactDir: "/trusted/artifacts", artifactHash: "c".repeat(64), siteId: "site",
    productionUrl: "https://app.example.com", smokePaths: ["/health", "/ready"], data: { kind: "none" },
    rollback: { deploymentId: "old", url: "https://old.vercel.app", steps: ["Restore and verify."] } });
  const deployment = ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "succeeded", op: action === "preview" ? "deploy.preview" : "deploy.promote",
    detail: { manifestHash: manifestHash(m), action, url: action === "promote" ? m.productionUrl : "https://new.vercel.app" } } });
  const projectConfig = { project: m.project, provider: m.provider, siteId: m.siteId, productionUrl: m.productionUrl,
    artifactRoot: root, privateRoot: ledger.dir, snapshotRoot: ledger.dir, artifacts: { [m.revision]: m.artifactHash } };
  return { ledger, m, projectConfig, deploymentSeq: deployment.seq };
}
describe("live smoke evidence", () => {
  it("fetches root and all smoke paths, retries, disables redirects and captures hashed evidence", async () => {
    const { ledger, m, projectConfig, deploymentSeq } = setup(); const urls: string[] = []; let first = true;
    const result = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq, retries: 1, timeoutMs: 100, fetch: async (url, init) => {
      urls.push(String(url)); expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeDefined();
      if (first) { first = false; return new Response("", { status: 503 }); }
      return new Response(manifestHash(m));
    } });
    expect(urls).toEqual([m.productionUrl + "/", m.productionUrl + "/", m.productionUrl + "/health", m.productionUrl + "/ready", m.productionUrl + "/.well-known/jarvis-release"]);
    expect(result.data).toMatchObject({ status: "pass", check: "release.smoke", deploymentSeq });
    expect(verifyEvidence(result).ok).toBe(true);
  });
  it("bounds a fetch that ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const { ledger, m, projectConfig, deploymentSeq } = setup();
      const result = runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq, retries: 0, timeoutMs: 5, fetch: () => new Promise(() => {}) });
      await vi.runAllTimersAsync();
      expect((await result).data).toMatchObject({ status: "fail" });
    } finally { vi.useRealTimers(); }
  });
  it("rejects a failed deployment before fetching", async () => {
    const { ledger, m, projectConfig } = setup(); const fetch = vi.fn();
    const failed = ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "unknown" } });
    await expect(runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq: failed.seq, fetch })).rejects.toThrow(/deployment/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])("rolls back failed production smoke only with permission (%s)", async allowed => {
    const { ledger, m, projectConfig, deploymentSeq } = setup();
    if (allowed) ledger.append({ kind: "grant", actor: "runner", data: { op: "deploy.promote", scope: { project: m.project, manifestHash: manifestHash(m), allowRollback: true } } });
    const smoke = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq, retries: 0, fetch: async () => new Response("", { status: 500 }) });
    const handle = vi.fn(async (_req: BrokerRequest) => ({ status: "succeeded" as const, payloadHash: "hash", message: "succeeded" }));
    const notify = vi.fn(async (_message: string) => {});
    const result = await recoverFailedSmoke({ ledger, manifest: m, smokeSeq: smoke.seq, broker: { handle }, notify });
    expect(handle).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toBe(allowed ? "rolled-back" : "stopped");
    if (allowed) expect(handle.mock.calls[0]?.[0]).toMatchObject({ op: "deploy.promote" });
  });
  it("does not roll back previews or passing smoke", async () => {
    const { ledger, m, projectConfig, deploymentSeq } = setup("preview");
    const smoke = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq, retries: 0, fetch: async () => new Response("", { status: 500 }) });
    const handle = vi.fn();
    expect(await recoverFailedSmoke({ ledger, manifest: m, smokeSeq: smoke.seq, broker: { handle }, notify: async () => {} })).toBe("stopped");
    expect(handle).not.toHaveBeenCalled();
  });
  it("does nothing after passing production smoke", async () => {
    const { ledger, m, projectConfig, deploymentSeq } = setup();
    const smoke = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq, fetch: async () => new Response(manifestHash(m)) });
    const handle = vi.fn(); const notify = vi.fn();
    expect(await recoverFailedSmoke({ ledger, manifest: m, smokeSeq: smoke.seq, broker: { handle }, notify })).toBe("not-needed");
    expect(handle).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it("stops after an unknown rollback without retrying", async () => {
    const { ledger, m, projectConfig, deploymentSeq } = setup();
    ledger.append({ kind: "grant", actor: "runner", data: { op: "deploy.promote", scope: { project: m.project, manifestHash: manifestHash(m), allowRollback: true } } });
    const smoke = await runSmoke({ ledger, manifest: m, projectConfig, deploymentSeq, retries: 0, fetch: async () => new Response("", { status: 500 }) });
    const handle = vi.fn(async () => ({ status: "unknown" as const, payloadHash: "hash", message: "unknown" }));
    const notify = vi.fn();
    expect(await recoverFailedSmoke({ ledger, manifest: m, smokeSeq: smoke.seq, broker: { handle }, notify })).toBe("stopped");
    expect(handle).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1);
  });
});
