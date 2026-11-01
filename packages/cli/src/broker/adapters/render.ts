import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerGitEnv } from "../../eval/git.ts";
import { runSession } from "../../proc/session.ts";
import { checkManifest, manifestHash, parseManifest } from "../../release/manifest.ts";
import { realChild } from "../../release/paths.ts";
import { validateRenderSetup } from "../../release/render-config.ts";
import { readRenderMarker, waitForRender } from "../../release/render-readiness.ts";
import { renderTools, verifyRenderTools } from "../../release/render-tools.ts";
import { recordCurrentProduction } from "./production.ts";
import type { ProviderDeployInput, ProviderModule } from "./types.ts";

// GitHub's published Ed25519 key: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
// SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU. No TOFU, ssh-keyscan, DNS trust or runtime host-key update.
export const GITHUB_KNOWN_HOSTS = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=never", "-c", "core.autocrlf=false"];
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The repo and HOME are runner-only. No command ever runs in candidate-writable folders. */
async function pushTree(input: ProviderDeployInput, encoded: string): Promise<void> {
  const { options, config, staged, action } = input;
  const target = options.projectConfig.render![action === "preview" ? "preview" : "production"];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 16_384) throw new Error("invalid deploy key encoding");
  const key = Buffer.from(encoded, "base64");
  if (key.toString("base64") !== encoded) throw new Error("invalid deploy key encoding");
  const room = mkdtempSync(join(realChild(options.ledger.dir, config.home, true), "render-push-"));
  const home = join(room, "home"), keyPath = join(room, "identity"), hosts = join(room, "known_hosts");
  try {
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
    writeFileSync(hosts, GITHUB_KNOWN_HOSTS, { mode: 0o600, flag: "wx" });
    const ssh = `/usr/bin/ssh -F /dev/null -i ${quote(keyPath)} -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(hosts)} -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o UpdateHostKeys=no -o ConnectTimeout=15`;
    const git = async (args: string[], network = false, empty = false) => {
      const result = await (options.run ?? runSession)({ bin: config.bin, args: [...SAFE_CONFIG, ...args], cwd: staged.dir,
        env: { ...runnerGitEnv(home), ...(network ? { GIT_ALLOW_PROTOCOL: "ssh", GIT_SSH_VARIANT: "ssh", GIT_SSH_COMMAND: ssh } : {}) },
        timeoutMs: options.timeoutMs ?? 120_000, killGraceMs: 5000, maxOutputBytes: 1024 * 1024 });
      if (result.timedOut || result.overflowed || (result.code !== 0 && !(empty && result.code === 2 && result.stdout === ""))) throw new Error("Render Git operation uncertain");
      return result.stdout.trim();
    };
    await git(["init", "--template=", `--initial-branch=${target.branch}`, "."]);
    const ref = `refs/heads/${target.branch}`;
    const remote = await git(["ls-remote", "--exit-code", target.repo, ref], true, true);
    if (remote) {
      const match = /^([a-f0-9]{40})\t(.+)$/.exec(remote);
      if (!match || match[2] !== ref) throw new Error("unexpected remote ref");
      await git(["fetch", "--no-tags", "--depth=1", target.repo, ref], true);
      if (await git(["rev-parse", "FETCH_HEAD"]) !== match[1]) throw new Error("remote moved before deploy");
      await git(["update-ref", ref, match[1]!]);
    }
    await git(["read-tree", "--empty"]);
    await git(["add", "--all", "--", "."]);
    await git(["commit", "--allow-empty", "--no-gpg-sign", "-m", `Jarvis ${manifestHash(input.treeManifest)}`]);
    await git(["push", "--porcelain", target.repo, `HEAD:${ref}`], true);
  } finally { key.fill(0); rmSync(room, { recursive: true, force: true }); }
}

async function renderDeploy(input: ProviderDeployInput) {
  const { options, manifest, action, secrets } = input;
  const setup = options.projectConfig;
  if (action === "promote") {
    const previous = await readRenderMarker(setup.productionUrl, options.fetch);
    if (!previous) return { outcome: "failed" as const, detail: { reason: "current Render production marker unavailable; no promotion attempted" } };
    const old = parseManifest(options.resolveManifest(previous));
    if (manifestHash(old) !== previous) throw new Error("unknown production manifest");
    checkManifest(old, setup);
    recordCurrentProduction(options.ledger, manifest, setup, { id: previous, url: setup.productionUrl });
  }
  const key = secrets.get(action === "preview" ? "RENDER_PREVIEW_DEPLOY_KEY" : "RENDER_PRODUCTION_DEPLOY_KEY");
  if (!key) return { outcome: "failed" as const, detail: { reason: "release credential unavailable" } };
  await pushTree(input, key);
  const url = setup.render![action === "preview" ? "preview" : "production"].url;
  const confirmed = await waitForRender(url, manifestHash(input.treeManifest), { ...(options.fetch ? { fetch: options.fetch } : {}), ...options.readiness });
  if (!confirmed) return { outcome: "unknown" as const, detail: { reason: "Render deployment not confirmed; reconcile before retrying" } };
  return { outcome: "succeeded" as const, detail: { provider: "render", siteId: setup.siteId, manifestHash: manifestHash(manifest), action, url } };
}
const notCli = (): never => { throw new Error("Render uses the registry's Git deploy workflow"); };
export const renderProvider: ProviderModule = {
  label: "Render Git/SSH", command: notCli, currentCommand: notCli, readCurrent: notCli, version: stdout => stdout.trim(),
  deploy: renderDeploy, tools: renderTools, verify: verifyRenderTools, validateSetup: validateRenderSetup,
  rollbackFromManifest: true, markerPath: "/.jarvis-build.json",
};
