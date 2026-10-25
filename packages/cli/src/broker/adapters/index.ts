import { isAbsolute } from "node:path";
import type { Adapter, AdapterResult, SecretsBackend } from "../broker.ts";
import { runSession } from "../../proc/session.ts";
import { copyDeploymentArtifacts } from "../../release/artifacts.ts";
import { hasReleaseGrant } from "../../release/grants.ts";
import { checkManifest, manifestHash, parseManifest, parseReleaseRef, releaseUrl } from "../../release/manifest.ts";
import { isReleaseReady } from "../../release/states.ts";
import { netlifyCommand, netlifyCurrentCommand, readNetlifyCurrent } from "./netlify.ts";
import { vercelCommand, vercelCurrentCommand, readVercelCurrent } from "./vercel.ts";
import { recordCurrentProduction, recordedRollbackTarget } from "./production.ts";
import type { DeployAdapterOptions, ProductionDeployment, ProviderCommand, ProviderConfig } from "./types.ts";
export type { DeployAdapterOptions, ProviderConfig } from "./types.ts";

const failed = (reason: string): AdapterResult => ({ outcome: "failed", detail: { reason } });
const unknown = (): AdapterResult => ({ outcome: "unknown", detail: { reason: "provider outcome uncertain; reconcile before retrying" } });
const safeUrl = (url: string, token: string): boolean => releaseUrl(url) && !url.includes(token) && !decodeURIComponent(url).includes(token);

function runCommand(options: DeployAdapterOptions, config: ProviderConfig, command: ProviderCommand) {
  return (options.run ?? runSession)({ bin: config.bin, args: command.args, cwd: config.cwd,
    env: { PATH: "/usr/bin:/bin", HOME: config.home, CI: "1", ...command.env }, timeoutMs: options.timeoutMs ?? 120_000,
    killGraceMs: 5_000, maxOutputBytes: 1024 * 1024 });
}
async function captureProduction(options: DeployAdapterOptions, prepared: NonNullable<ReturnType<typeof prepare>>, token: string): Promise<void> {
  const setup = options.projectConfig;
  const command = (setup.provider === "vercel" ? vercelCurrentCommand : netlifyCurrentCommand)(setup, token);
  const result = await runCommand(options, prepared.config, command);
  if (result.code !== 0 || result.timedOut || result.overflowed) throw new Error("current production could not be established");
  const current = (setup.provider === "vercel" ? readVercelCurrent : readNetlifyCurrent)(result.stdout, setup);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(current.id) || !safeUrl(current.url, token) || JSON.stringify(current).includes(token)) throw new Error("current production refused");
  recordCurrentProduction(options.ledger, prepared.manifest, setup, current);
}

/** Register these instead of deploy outboxes. Credentials are read only after policy and copy checks. */
export function deployAdapters(options: DeployAdapterOptions): Adapter[] {
  for (const config of Object.values(options.providers)) {
    if (![config.bin, config.home, config.cwd].every(isAbsolute)) throw new Error("provider bin, home and cwd must be absolute");
  }
  const execute = (op: "deploy.preview" | "deploy.promote") => async (payload: unknown, secrets: SecretsBackend): Promise<AdapterResult> => {
    let prepared: ReturnType<typeof prepare>;
    try { prepared = prepare(options, op, payload); }
    catch { return failed("release policy or provider configuration refused"); }
    if (!prepared) return failed("release policy or provider configuration refused");
    const { manifest, action, config, staged, target } = prepared;
    try {
      const key = `${manifest.provider.toUpperCase()}_${action === "preview" ? "PREVIEW" : "PRODUCTION"}_TOKEN`;
      const token = secrets.get(key);
      if (!token) return failed("release credential unavailable");
      if (action === "promote") {
        try { await captureProduction(options, prepared, token); }
        catch { return failed("current production could not be established; no promotion attempted"); }
      }
      const deployManifest = staged ? { ...manifest, artifactDir: staged.dir } : manifest;
      const command = (manifest.provider === "vercel" ? vercelCommand : netlifyCommand)(deployManifest, options.projectConfig, action, token, target);
      const result = await runCommand(options, config, command);
      if (result.code !== 0 || result.timedOut || result.overflowed) return unknown();
      const url = command.readUrl(result.stdout);
      if (!safeUrl(url, token)) return unknown();
      return { outcome: "succeeded", detail: { provider: manifest.provider, siteId: options.projectConfig.siteId, manifestHash: manifestHash(manifest), action, url } };
    } catch { return unknown(); }
    finally { staged?.dispose(); }
  };
  return [{ op: "deploy.preview", execute: execute("deploy.preview") }, { op: "deploy.promote", execute: execute("deploy.promote") }];
}
function prepare(options: DeployAdapterOptions, op: "deploy.preview" | "deploy.promote", payload: unknown) {
  const ref = parseReleaseRef((payload as { ref?: unknown } | null)?.ref);
  if (!ref || (op === "deploy.preview") !== (ref.action === "preview")) return undefined;
  const manifest = parseManifest(options.resolveManifest(ref.hash));
  if (manifest.project !== options.project || manifestHash(manifest) !== ref.hash) return undefined;
  checkManifest(manifest, options.projectConfig);
  if (op === "deploy.promote" && !hasReleaseGrant(options.ledger, manifest, ref.action === "rollback")) return undefined;
  if (ref.action === "promote" && !(options.readyToPromote ?? (m => isReleaseReady(options.ledger, m)))(manifest)) return undefined;
  const config = options.providers[manifest.provider];
  if (!config) return undefined;
  const target: ProductionDeployment | undefined = ref.action === "rollback" ? recordedRollbackTarget(options.ledger, manifest, options.projectConfig) : undefined;
  if (ref.action === "rollback" && !target) return undefined;
  const staged = ref.action !== "rollback" ? copyDeploymentArtifacts(manifest, options.projectConfig, options.ledger.dir) : undefined;
  return { manifest, action: ref.action, config, staged, target };
}
