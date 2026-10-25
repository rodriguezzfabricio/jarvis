import type { LedgerEntry } from "../ledger/ledger.ts";
import { hasReleaseGrant } from "./grants.ts";
import { checkManifest, manifestHash, parseManifest, releaseRef } from "./manifest.ts";
import { deploymentReceipt, evidenceIntact, recordObservation } from "./states.ts";
import type { RecoveryInput, SmokeInput } from "./types.ts";

type Data = Record<string, unknown>;
interface ResponseCheck { status: number; identity: boolean }
async function markerMatches(response: Response, expected: string): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128) return false;
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8").trim() === expected;
  } finally { void reader.cancel().catch(() => {}); }
}
async function request(fetch: typeof globalThis.fetch, url: string, timeoutMs: number, expected?: string): Promise<ResponseCheck> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(url, { method: "GET", redirect: "manual", signal: controller.signal }).then(async response => {
        const identity = expected ? await markerMatches(response, expected) : true;
        if (!expected) await response.body?.cancel();
        return { status: response.status, identity };
      }),
      new Promise<ResponseCheck>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 0, identity: false }); }, timeoutMs); }),
    ]);
  } catch { return { status: 0, identity: false }; }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function runSmoke(input: SmokeInput): Promise<LedgerEntry> {
  const manifest = parseManifest(input.manifest);
  checkManifest(manifest, input.projectConfig);
  const deployment = input.ledger.entries().find(e => e.seq === input.deploymentSeq);
  const preview = deploymentReceipt(deployment, manifest, "preview");
  if (!preview && !deploymentReceipt(deployment, manifest, "promote")) throw new Error("successful broker deployment required");
  const detail = (deployment!.data as { detail: Data }).detail;
  const url = detail.url as string;
  const origins = [...new Set([url, ...(preview ? [] : [input.projectConfig.productionUrl])])];
  const retries = input.retries ?? 2;
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error("invalid smoke limits");
  const observations: { origin: string; path: string; statuses: number[]; passed: boolean }[] = [];
  for (const origin of origins) for (const path of new Set(["/", ...manifest.smokePaths, "/.well-known/jarvis-release"])) {
    const statuses: number[] = []; let passed = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await request(input.fetch ?? globalThis.fetch, new URL(path, origin).href, timeoutMs,
        path === "/.well-known/jarvis-release" ? manifestHash(manifest) : undefined);
      statuses.push(result.status);
      passed = result.status >= 200 && result.status < 300 && result.identity;
      if (passed) break;
    }
    observations.push({ origin, path, statuses, passed });
  }
  const status = observations.every(o => o.passed) ? "pass" : "fail";
  return recordObservation(input.ledger, manifest, preview ? "preview" : "smoke", status,
    { deploymentSeq: input.deploymentSeq, url, origins, observations });
}
export async function recoverFailedSmoke(input: RecoveryInput): Promise<"not-needed" | "rolled-back" | "stopped"> {
  const { ledger, manifest } = input;
  const entries = ledger.entries();
  const entry = entries.find(e => e.seq === input.smokeSeq);
  const d = entry?.data as Data | undefined;
  if (!entry || entry.actor !== "runner" || entry.kind !== "gate_result" || d?.manifestHash !== manifestHash(manifest)
    || !evidenceIntact(entry) || !["release.smoke", "release.preview"].includes(d.check as string)) throw new Error("verified smoke evidence required");
  if (d.status === "pass") return "not-needed";
  const deployment = entries.find(e => e.seq === d.deploymentSeq);
  if (deploymentReceipt(deployment, manifest, "preview")) {
    await input.notify("Preview smoke failed. Preview release stopped.");
    return "stopped";
  }
  if (d.status !== "fail" || !deploymentReceipt(deployment, manifest, "promote") || !hasReleaseGrant(ledger, manifest, true)) {
    await input.notify("Production smoke failed. Release stopped; a person-approved rollback is manual without an automatic rollback grant.");
    return "stopped";
  }
  let rolledBack = false;
  try {
    const response = await input.broker.handle({ op: "deploy.promote", payload: { ref: releaseRef(manifest, "rollback") } });
    rolledBack = response.status === "succeeded";
  } catch { /* An ambiguous rollback is never retried. */ }
  await input.notify(rolledBack ? "Production smoke failed; broker rollback succeeded. Release stopped." : "Production smoke failed; rollback needs reconciliation. Release stopped.");
  return rolledBack ? "rolled-back" : "stopped";
}
