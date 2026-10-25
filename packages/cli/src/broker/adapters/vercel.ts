import type { ReleaseAction, ReleaseManifest, ReleaseProjectConfig } from "../../release/types.ts";
import type { ProductionDeployment, ProviderCommand } from "./types.ts";

/** Prebuilt deploys only; both linked project metadata and environment come from runner setup. */
export function vercelCommand(manifest: ReleaseManifest, setup: ReleaseProjectConfig, action: ReleaseAction, token: string, target?: ProductionDeployment): ProviderCommand {
  if (action === "rollback" && !target) throw new Error("recorded rollback target required");
  const args = action === "rollback" ? ["rollback", target!.id, "--yes"]
    : ["deploy", "--prebuilt", "--yes", "--cwd", manifest.artifactDir, ...(action === "promote" ? ["--prod"] : [])];
  return { args, env: { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: setup.siteId, ...(setup.orgId ? { VERCEL_ORG_ID: setup.orgId } : {}) }, readUrl(stdout) {
    if (action === "rollback") return target!.url;
    const value = stdout.trim().split(/\s+/).at(-1) ?? "";
    if (!new URL(value).hostname.endsWith(".vercel.app")) throw new Error("invalid deploy URL");
    return value;
  } };
}
export function vercelCurrentCommand(setup: ReleaseProjectConfig, token: string): ProviderCommand {
  return { args: ["inspect", setup.productionUrl, "--json"], env: { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: setup.siteId,
    ...(setup.orgId ? { VERCEL_ORG_ID: setup.orgId } : {}) }, readUrl: () => { throw new Error("inspect is not a deploy"); } };
}
export function readVercelCurrent(stdout: string, setup: ReleaseProjectConfig): ProductionDeployment {
  const data = JSON.parse(stdout) as { id?: unknown; url?: unknown; projectId?: unknown };
  if (data.projectId !== setup.siteId || typeof data.id !== "string" || typeof data.url !== "string") throw new Error("unexpected current production");
  return { id: data.id, url: data.url.startsWith("https://") ? data.url : `https://${data.url}` };
}
