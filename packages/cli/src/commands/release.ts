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
    .option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .requiredOption("--provider <name>", "vercel or netlify")
    .requiredOption("--site <id>", "the Vercel project id or the Netlify site id")
    .option("--org <id>", "the Vercel account or team id")
    .requiredOption("--url <origin>", "the live production origin, https://…")
    .option("--plan <plan>", "the account's plan; only the free plan is accepted (hobby on Vercel, free on Netlify)")
    .option("--build <command>", "the build the runner runs on the checked revision, offline in the sandbox", "npm run build")
    .option("--output <folder>", "the static output folder the build leaves in the checkout", "out")
    .option("--timeout-ms <ms>", "the build's time limit")
    .option("--data-kind <kind>", "sqlite or postgres, when the app keeps data")
    .option("--data-source <path>", "the consistent SQLite export or Postgres dump the runner copies for a rehearsal")
    .action((o: { project?: string; provider: string; site: string; org?: string; url: string; plan?: string; build: string; output: string; timeoutMs?: string; dataKind?: string; dataSource?: string }) => {
      const id = project(o.project);
      if ((o.dataKind === undefined) !== (o.dataSource === undefined)) throw new Error("--data-kind and --data-source go together");
      const setup = parseReleaseSetup({ version: 1, provider: o.provider, plan: o.plan ?? FREE_PLANS[o.provider as keyof typeof FREE_PLANS] ?? "", siteId: o.site,
        ...(o.org !== undefined ? { orgId: o.org } : {}), productionUrl: o.url,
        build: { command: o.build, output: o.output, ...(o.timeoutMs !== undefined ? { timeoutMs: Number(o.timeoutMs) } : {}) },
        ...(o.dataKind !== undefined ? { data: { kind: o.dataKind, source: o.dataSource } } : {}) });
      const dir = dirOf(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = saveReleaseSetup(dir, setup, seams.trust);
      const tokens = `${setup.provider.toUpperCase()}_PREVIEW_TOKEN and ${setup.provider.toUpperCase()}_PRODUCTION_TOKEN`;
      out([`Wrote ${path}.`, `Previews deploy to ${setup.provider} site ${setup.siteId} on the ${setup.plan} plan; production ${setup.productionUrl} stays gated until you grant a manifest.`,
        `The broker reads ${tokens} (jarvis setup --redo accounts.deploy stores them), and the ${setup.provider} CLI must be pinned (config/pins.ts PROVIDER_CLI_PINS).`].join("\n"));
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
      out([
        setup ? `Setup: ${setup.provider} site ${setup.siteId} (${setup.plan}), live ${setup.productionUrl}, build \`${setup.build.command}\` → ${setup.build.output}` : "Setup: none (jarvis release configure)",
        latest ? `Latest accepted manifest: ${String((latest.entry.data as { manifestHash: string }).manifestHash)} at revision ${latest.manifest.revision}` : "Latest accepted manifest: none",
        `State: ${status.current ? `${status.current.state}${status.current.previewUrl ? ` at ${status.current.previewUrl}` : ""}` : "not-reached"}`,
        ...(status.current ? [`Production: ${status.current.productionGranted ? "granted for this manifest" : `gated; jarvis release grant ${status.current.manifestHash}`}`] : []),
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
