import type { ReleaseAction, ReleaseManifest, ReleaseProjectConfig } from "../../release/types.ts";
import type { ProductionDeployment, ProviderCommand } from "./types.ts";

export function netlifyCommand(manifest: ReleaseManifest, setup: ReleaseProjectConfig, action: ReleaseAction, token: string, target?: ProductionDeployment): ProviderCommand {
  if (action === "rollback" && !target) throw new Error("recorded rollback target required");
  const args = action === "rollback" ? ["api", "restoreSiteDeploy", "--data", JSON.stringify({ site_id: setup.siteId, deploy_id: target!.id })]
    : ["deploy", "--no-build", "--dir", manifest.artifactDir, "--site", setup.siteId, "--json", ...(action === "promote" ? ["--prod"] : [])];
  return { args, env: { NETLIFY_AUTH_TOKEN: token }, readUrl(stdout) {
    if (action === "rollback") return target!.url;
    const output = JSON.parse(stdout) as { deploy_url?: unknown };
    if (typeof output.deploy_url !== "string" || !new URL(output.deploy_url).hostname.endsWith(".netlify.app")) throw new Error("invalid deploy URL");
    return output.deploy_url;
  } };
}
export function netlifyCurrentCommand(setup: ReleaseProjectConfig, token: string): ProviderCommand {
  return { args: ["api", "getSite", "--data", JSON.stringify({ site_id: setup.siteId })], env: { NETLIFY_AUTH_TOKEN: token },
    readUrl: () => { throw new Error("inspect is not a deploy"); } };
}
export function readNetlifyCurrent(stdout: string, setup: ReleaseProjectConfig): ProductionDeployment {
  const data = JSON.parse(stdout) as { id?: unknown; published_deploy?: { id?: unknown; deploy_ssl_url?: unknown } };
  if (data.id !== setup.siteId || typeof data.published_deploy?.id !== "string" || typeof data.published_deploy.deploy_ssl_url !== "string") throw new Error("unexpected current production");
  return { id: data.published_deploy.id, url: data.published_deploy.deploy_ssl_url };
}
