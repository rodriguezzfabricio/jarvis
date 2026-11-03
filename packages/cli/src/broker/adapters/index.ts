import { isAbsolute } from "node:path";
import type { Adapter, AdapterResult, SecretsBackend } from "../broker.ts";
import { runCommand, verifyProvider } from "./execution.ts";
import { ArtifactPolicyError, copyDeploymentArtifacts } from "../../release/artifacts.ts";
import { hasReleaseGrant } from "../../release/grants.ts";
import { checkManifest, manifestHash, parseManifest, parseReleaseRef, releaseUrl } from "../../release/manifest.ts";
import { isReleaseReady } from "../../release/states.ts";
import { PROVIDERS } from "./providers.ts";
import { recordCurrentProduction, recordedRollbackTarget } from "./production.ts";
import type { DeployAdapterOptions, ProductionDeployment, ProviderConfig } from "./types.ts";
export type { DeployAdapterOptions, ProviderConfig, ProviderModule } from "./types.ts";
export { PROVIDER_NAMES, PROVIDERS } from "./providers.ts";

const failed = (reason: string): AdapterResult => ({ outcome: "failed", detail: { reason } });
const unknown = (): AdapterResult => ({ outcome: "unknown", detail: { reason: "provider outcome uncertain; reconcile before retrying" } });
const safeUrl = (url: string, token: string): boolean => releaseUrl(url) && !url.includes(token) && !decodeURIComponent(url).includes(token);

async function readProduction(options: DeployAdapterOptions, config: ProviderConfig, token: string): Promise<ProductionDeployment> {
  const setup = options.projectConfig; const provider = PROVIDERS[setup.provider];
  const command = provider.currentCommand(setup, token);
  const result = await runCommand(options, config, command);
  if (result.code !== 0 || result.timedOut || result.overflowed) throw new Error("current production could not be established");
  const current = provider.readCurrent(result.stdout, setup);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(current.id) || !safeUrl(current.url, token) || JSON.stringify(current).includes(token)) throw new Error("current production refused");
  return current;
}

/** Register these instead of deploy outboxes. Credentials are read only after policy and copy checks. */
export function deployAdapters(options: DeployAdapterOptions): Adapter[] {
  for (const config of Object.values(options.providers)) {
    if (![config.bin, config.home, config.cwd].every(isAbsolute)) throw new Error("provider bin, home and cwd must be absolute");
    if (config.interpreter !== undefined && !isAbsolute(config.interpreter)) throw new Error("provider interpreter must be absolute");
  }
  const execute = (op: "deploy.preview" | "deploy.promote") => async (payload: unknown, secrets: SecretsBackend): Promise<AdapterResult> => {
    let prepared: ReturnType<typeof prepare>;
    try { prepared = prepare(options, op, payload); }
    catch (error) { return failed(error instanceof ArtifactPolicyError ? error.message : "release policy or provider configuration refused"); }
    if (!prepared) return failed("release policy or provider configuration refused");
    const { manifest, action, config, staged, target, treeManifest } = prepared;
    try {
      try { await verifyProvider(options, config, manifest.provider); }
      catch { return failed("provider version or private execution configuration refused"); }
      const native = PROVIDERS[manifest.provider].deploy;
      if (native) return await native({ options, config, manifest, treeManifest, staged: staged!, action, secrets, target });
      const key = `${manifest.provider.toUpperCase()}_${action === "preview" ? "PREVIEW" : "PRODUCTION"}_TOKEN`;
      const token = secrets.get(key);
      if (!token) return failed("release credential unavailable");
      if (action === "promote") {
        try {
          const current = await readProduction(options, config, token);
          recordCurrentProduction(options.ledger, prepared.manifest, options.projectConfig, current);
        }
        catch { return failed("current production could not be established; no promotion attempted"); }
      }
      const deployManifest = staged ? { ...manifest, artifactDir: staged.dir } : manifest;
      const command = PROVIDERS[manifest.provider].command(deployManifest, options.projectConfig, action, token, target);
      const result = await runCommand(options, config, command);
      if (result.code !== 0 || result.timedOut || result.overflowed) return unknown();
      let url: string;
      if (action === "rollback") {
        const current = await readProduction(options, config, token);
        if (current.id !== target!.id || current.url !== target!.url) return unknown();
        url = current.url;
      } else url = command.readUrl(result.stdout);
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
  const provider = PROVIDERS[manifest.provider];
  provider.validateSetup?.(options.projectConfig);
  if (op === "deploy.promote" && !hasReleaseGrant(options.ledger, manifest, ref.action === "rollback")) return undefined;
  if (ref.action === "promote" && !(options.readyToPromote ?? (m => isReleaseReady(options.ledger, m)))(manifest)) return undefined;
  const config = options.providers[manifest.provider];
  if (!config) return undefined;
  const target: ProductionDeployment | undefined = ref.action === "rollback" ? recordedRollbackTarget(options.ledger, manifest, options.projectConfig) : undefined;
  if (ref.action === "rollback" && !target) return undefined;
  let treeManifest = manifest;
  if (ref.action === "rollback" && provider.rollbackFromManifest) {
    treeManifest = parseManifest(options.resolveManifest(target!.id));
    if (manifestHash(treeManifest) !== target!.id || target!.url !== options.projectConfig.productionUrl) return undefined;
    checkManifest(treeManifest, options.projectConfig);
  }
  const staged = ref.action !== "rollback" || provider.rollbackFromManifest ? copyDeploymentArtifacts(treeManifest, options.projectConfig, options.ledger.dir) : undefined;
  return { manifest, treeManifest, action: ref.action, config, staged, target };
}
