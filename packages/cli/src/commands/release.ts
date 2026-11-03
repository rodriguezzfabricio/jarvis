import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { Broker } from "../broker/broker.ts";
import { resolveProject } from "../config/project.ts";
import type { TrustOptions } from "../config/private-file.ts";
import { Ledger } from "../ledger/ledger.ts";
import { acceptedManifest, latestAccepted } from "../release/accepted.ts";
import { FREE_PLANS, loadReleaseSetup, parseReleaseSetup, saveReleaseSetup } from "../release/config.ts";
import { installDesktopRelease } from "../release/desktop.ts";
import { grantRelease, hasReleaseGrant } from "../release/grants.ts";
import { releaseStatus } from "../release/states.ts";
import type { ReleaseManifest } from "../release/types.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { verifiedEntries } from "./approvals.ts";

/**
 * `jarvis release` (decisions 157, 130): the project's protected release setup, what the runner accepted, and the
 * production grant. A grant is bound to one exact accepted manifest and says whether a failed production smoke test
 * may roll back automatically; it is recorded only after the person saw that manifest, like `jarvis approve`.
 */
export interface ReleaseCommandOptions {
  jarvisHome?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  output?: (text: string) => void;
  isTTY?: () => boolean;
  confirm?: (prompt: string) => Promise<string>;
  by?: string;
  trust?: TrustOptions;
}

async function confirm(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try { return await reader.question(prompt); } finally { reader.close(); }
}

/** JSON with invisible and direction-changing characters escaped, so what the person reads is what is granted. */
function visibleJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/(?! )[\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Co}\p{Cn}]/gu,
    (c) => [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
}

export function formatGrant(manifest: ReleaseManifest, hash: string, allowRollback: boolean): string {
  return [
    "Release manifest (accepted by the runner):",
    visibleJson(manifest),
    `Manifest hash: ${hash}`,
    `Grants: deploy.promote of exactly this manifest (revision ${manifest.revision}, artifact ${manifest.artifactHash}) to ${manifest.productionUrl} on ${manifest.provider} site ${manifest.siteId}.`,
    `Rollback: ${allowRollback ? "automatic, to the production deployment the broker records just before promoting, if the production smoke test fails" : "manual: a failed production smoke test stops the release and tells you; nothing rolls back on its own"}.`,
    "A changed manifest has a new hash and needs a new grant.",
  ].join("\n");
}

export function register(program: Command, seams: ReleaseCommandOptions = {}): void {
  const out = (text: string) => (seams.output ?? console.log)(text);
  const project = (option?: string) => resolveProject({ ...(option !== undefined ? { option } : {}), env: seams.env ?? process.env, cwd: seams.cwd ?? process.cwd() });
  const dirOf = (id: string) => runnerProjectDir(id, seams.jarvisHome ?? join(homedir(), ".jarvis"));
  const release = program.command("release").description("A project's protected release setup, its accepted manifest and production grants");

  release.command("configure").description("Write the project's protected release setup: provider, site, live origin, build and data source")
    .option("--kind <kind>", "web or desktop", "web")
    .option("--app-name <name>", "desktop app name")
    .option("--bundle <path>", "desktop .app path inside --output")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .option("--provider <name>", "web: render, vercel or netlify")
    .option("--site <id>", "web: the Vercel project id, the Netlify site id, or a label for the Render sites")
    .option("--org <id>", "the Vercel account or team id")
    .option("--url <origin>", "web: the live production origin, https://… (Render: the production site's https://<name>.onrender.com)")
    .option("--plan <plan>", "the account's plan; only the free plan is accepted (hobby on Vercel, free on Netlify and Render)")
    .option("--preview-repo <ssh-url>", "Render: the preview deploy repository, git@github.com:<owner>/<repo>.git")
    .option("--production-repo <ssh-url>", "Render: the production deploy repository, a different one")
    .option("--preview-url <origin>", "Render: the preview site's https://<name>.onrender.com")
    .option("--preview-branch <branch>", "Render: the branch the preview site deploys", "main")
    .option("--production-branch <branch>", "Render: the branch the production site deploys", "main")
    .option("--build <command>", "the build the runner runs on the checked revision, offline in the sandbox", "npm run build")
    .option("--output <folder>", "the static output folder the build leaves in the checkout", "out")
    .option("--timeout-ms <ms>", "the build's time limit")
    .option("--data-kind <kind>", "sqlite or postgres, when the app keeps data")
    .option("--data-source <path>", "the consistent SQLite export or Postgres dump the runner copies for a rehearsal")
    .action((o: { project?: string; kind: string; appName?: string; bundle?: string; provider?: string; site?: string; org?: string; url?: string; plan?: string; build: string; output: string; timeoutMs?: string; dataKind?: string; dataSource?: string;
      previewRepo?: string; productionRepo?: string; previewUrl?: string; previewBranch: string; productionBranch: string }) => {
      const id = project(o.project);
      if (o.kind !== "web" && o.kind !== "desktop") throw new Error("--kind must be web or desktop");
      if (o.kind === "desktop") {
        if ([o.provider, o.site, o.org, o.url, o.plan, o.dataKind, o.dataSource, o.previewRepo, o.productionRepo, o.previewUrl].some(v => v !== undefined)) throw new Error("desktop configuration takes no provider, deploy destination, plan or data source");
        const setup = parseReleaseSetup({ version: 1, kind: "desktop", appName: o.appName, bundle: o.bundle,
          build: { command: o.build, output: o.output, ...(o.timeoutMs !== undefined ? { timeoutMs: Number(o.timeoutMs) } : {}) } });
        if (setup.kind !== "desktop") throw new Error("desktop setup required");
        const dir = dirOf(id); mkdirSync(dir, { recursive: true, mode: 0o700 });
        installDesktopRelease(Ledger.open(dir), setup);
        const path = saveReleaseSetup(dir, setup, seams.trust);
        out(`Wrote ${path}. Desktop ${setup.appName}: built, not distributed. Native smoke: not run (input isolation is unavailable).`);
        return;
      }
      if (!o.provider || !o.site || !o.url) throw new Error("web configuration requires --provider, --site and --url");
      if (o.appName !== undefined || o.bundle !== undefined) throw new Error("--app-name and --bundle require --kind desktop");
      if ((o.dataKind === undefined) !== (o.dataSource === undefined)) throw new Error("--data-kind and --data-source go together");
      if (o.provider !== "render" && [o.previewRepo, o.productionRepo, o.previewUrl].some((v) => v !== undefined)) throw new Error("--preview-repo, --production-repo and --preview-url are only for --provider render");
      const render = o.provider === "render" ? { render: {
        preview: { repo: o.previewRepo, branch: o.previewBranch, url: o.previewUrl },
        production: { repo: o.productionRepo, branch: o.productionBranch, url: o.url } } } : {};
      const setup = parseReleaseSetup({ version: 1, provider: o.provider, plan: o.plan ?? FREE_PLANS[o.provider as keyof typeof FREE_PLANS] ?? "", siteId: o.site,
        ...(o.org !== undefined ? { orgId: o.org } : {}), productionUrl: o.url, ...render,
        build: { command: o.build, output: o.output, ...(o.timeoutMs !== undefined ? { timeoutMs: Number(o.timeoutMs) } : {}) },
        ...(o.dataKind !== undefined ? { data: { kind: o.dataKind, source: o.dataSource } } : {}) });
      const dir = dirOf(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = saveReleaseSetup(dir, setup, seams.trust);
      const tokens = setup.provider === "render" ? "RENDER_PREVIEW_DEPLOY_KEY and RENDER_PRODUCTION_DEPLOY_KEY"
        : `${setup.provider.toUpperCase()}_PREVIEW_TOKEN and ${setup.provider.toUpperCase()}_PRODUCTION_TOKEN`;
      const tools = setup.provider === "render" ? "Git and SSH must match config/pins.ts RENDER_TOOL_PINS"
        : `the ${setup.provider} CLI must be pinned (config/pins.ts PROVIDER_CLI_PINS)`;
      out([`Wrote ${path}.`, `Previews deploy to ${setup.provider} site ${setup.siteId} on the ${setup.plan} plan; production ${setup.productionUrl} stays gated until you grant a manifest.`,
        `The broker reads ${tokens} (jarvis setup --redo accounts.deploy stores them), and ${tools}.`].join("\n"));
    });

  release.command("show").description("Print the release setup, the latest accepted manifest and the release state that holds now")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .action((o: { project?: string }) => {
      const id = project(o.project);
      const dir = dirOf(id);
      const setup = loadReleaseSetup(dir, seams.trust);
      const entries = verifiedEntries(dir);
      const latest = latestAccepted(entries);
      const status = releaseStatus(entries);
      if (setup?.kind === "desktop") {
        const built = status.current?.state === "built" ? status.current : undefined;
        out([`Setup: desktop ${setup.appName}, build \`${setup.build.command}\` → ${setup.build.output}/${setup.bundle}`,
          `State: ${built ? "built, not distributed" : "not-reached"}`,
          ...(built ? [`Bundle: ${built.bundlePath}`, `SHA-256: ${built.artifactHash}`, `Native smoke: not run (${built.nativeSmoke.reason})`] : [])].join("\n"));
        return;
      }
      const current = status.current?.state === "built" ? undefined : status.current;
      out([
        setup ? `Setup: ${setup.provider} site ${setup.siteId} (${setup.plan}), live ${setup.productionUrl}, build \`${setup.build.command}\` → ${setup.build.output}` : "Setup: none (jarvis release configure)",
        latest ? `Latest accepted manifest: ${String((latest.entry.data as { manifestHash: string }).manifestHash)} at revision ${latest.manifest.revision}` : "Latest accepted manifest: none",
        `State: ${current ? `${current.state}${current.previewUrl ? ` at ${current.previewUrl}` : ""}` : "not-reached"}`,
        ...(current ? [`Production: ${current.productionGranted ? "granted for this manifest" : `gated; jarvis release grant ${current.manifestHash}`}`] : []),
      ].join("\n"));
    });

  release.command("grant").description("Show an accepted manifest, then grant production for exactly that manifest")
    .argument("<manifest-hash>")
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .option("--allow-rollback", "let a failed production smoke test roll back automatically")
    .option("--yes", "confirm the displayed manifest without prompting")
    .action(async (hash: string, o: { project?: string; allowRollback?: boolean; yes?: boolean }) => {
      const id = project(o.project);
      const dir = dirOf(id);
      const manifest = acceptedManifest(verifiedEntries(dir), hash);
      if (!manifest) throw new Error(`No manifest ${hash} was accepted by the runner for project ${id}; jarvis release show names the latest one.`);
      if (manifest.project !== id) throw new Error(`Manifest ${hash} belongs to project ${manifest.project}.`);
      const allowRollback = o.allowRollback === true;
      const ledger = Ledger.open(dir);
      if (hasReleaseGrant(ledger, manifest, allowRollback)) { out(`Production is already granted for manifest ${hash}${allowRollback ? ", with automatic rollback" : ""}; nothing new recorded.`); return; }
      out(formatGrant(manifest, hash, allowRollback));
      if (!o.yes) {
        if (!(seams.isTTY ?? (() => stdin.isTTY === true))()) throw new Error("Non-interactive grant requires --yes.");
        const answer = await (seams.confirm ?? confirm)("Grant production for this manifest? [y/N] ");
        if (!/^(y|yes)$/i.test(answer.trim())) { out("No grant recorded."); return; }
      }
      // Recheck after the prompt: the grant binds what the ledger holds now, never a stale read.
      if (!acceptedManifest(ledger.entries(), hash)) throw new Error(`Manifest ${hash} is no longer resolvable; nothing recorded.`);
      grantRelease(new Broker({ ledger, project: id, adapters: [], secrets: { get: () => undefined } }), manifest, seams.by ?? `${process.env.USER ?? "user"} (terminal)`, allowRollback);
      out(`Granted production for manifest ${hash}${allowRollback ? ", with automatic rollback" : ", rollback manual"}.`);
    });
}
