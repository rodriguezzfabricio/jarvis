import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { checkTrustedDir, readNoFollow, writePrivateAtomic, type TrustOptions } from "../config/private-file.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { renderSetupSchema } from "./render-config.ts";
import { releaseUrl } from "./manifest.ts";
import type { Provider, ReleaseProjectConfig } from "./types.ts";

/**
 * A project's protected release setup (decision 157): written only by `jarvis release configure` into the runner's
 * project folder, which no session can read or write. It owns the deploy destination (provider, site, live origin),
 * the build the runner runs on a checked revision, the data snapshot source and the spend policy. Nothing in it
 * comes from a session or a manifest; a manifest that differs from it is refused (release/manifest.ts checkManifest).
 */
export const RELEASE_SETUP_FILE = "release.json";
/** Each provider's free plan (decision 33). The runner deploys only there, so a preview costs nothing. */
export const FREE_PLANS: Readonly<Record<Provider, string>> = { vercel: "hobby", netlify: "free", render: "free" };
/** Runner ledger entry types the release step writes (`decision` kind, actor runner). */
export const ARTIFACT_TYPE = "release.artifact";
export const STEP_TYPE = "release.step";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, "letters, digits, '.', '_' or '-'");
const outputPath = z.string().max(500).regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "a checkout-relative folder")
  .refine((p) => !p.split("/").some((part) => part === "." || part === ".." || /^\.git$/i.test(part) || /^\.jarvis$/i.test(part)), "no '.', '..', .git or .jarvis parts");
const schema = z.object({
  version: z.literal(1),
  provider: z.enum(["vercel", "netlify", "render"]),
  /** The account's plan, as Fabricio states it. Only the free plan is accepted (the spend policy). */
  plan: z.string().min(1).max(50),
  siteId: id,
  render: renderSetupSchema.optional(),
  /** Vercel's account or team id; Netlify has none. */
  orgId: id.optional(),
  productionUrl: z.string().refine((u) => releaseUrl(u) && new URL(u).pathname === "/", "an https origin without credentials, path, query or fragment"),
  /** Run by the runner in the sandbox, on a fresh checkout of the checked revision, offline and without credentials. */
  build: z.object({
    command: z.string().trim().min(1).max(2000),
    output: outputPath,
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  }).strict(),
  /** The consistent SQLite export or Postgres dump the runner copies for a rehearsal; absent for no persistent data. */
  data: z.object({ kind: z.enum(["sqlite", "postgres"]), source: z.string().refine(isAbsolute, "an absolute path") }).strict().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.plan !== FREE_PLANS[c.provider]) ctx.addIssue({ code: "custom", path: ["plan"],
    message: `${c.provider} plan "${c.plan}" can bill for deploys or bandwidth; Jarvis deploys only on the free plan (${FREE_PLANS[c.provider]}) unless a new decision says otherwise` });
  if (c.provider === "render" && (!c.render || c.productionUrl !== c.render.production.url || c.orgId)) ctx.addIssue({ code: "custom", path: ["render"], message: "Render needs two deploy repositories and its matching production URL, without orgId" });
  if (c.provider !== "render" && c.render) ctx.addIssue({ code: "custom", path: ["render"], message: "Render destinations require the Render provider" });
  if (c.provider === "vercel" && !c.orgId) ctx.addIssue({ code: "custom", path: ["orgId"], message: "Vercel needs the account or team id (orgId)" });
  if (c.provider === "netlify" && c.orgId) ctx.addIssue({ code: "custom", path: ["orgId"], message: "Netlify sites take no orgId" });
});
export type ReleaseSetup = z.infer<typeof schema>;

export function parseReleaseSetup(value: unknown): ReleaseSetup {
  return schema.parse(value);
}
export const releaseSetupPath = (projectDir: string) => join(projectDir, RELEASE_SETUP_FILE);

/** undefined when the project has no release setup; throws when the file isn't the runner's own, valid one. */
export function loadReleaseSetup(projectDir: string, trust: TrustOptions = {}): ReleaseSetup | undefined {
  const path = releaseSetupPath(projectDir);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return undefined;
  checkTrustedDir(projectDir, trust);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${path} must be a regular file`);
  const uid = trust.uid ?? process.getuid?.();
  if ((st.mode & 0o077) !== 0 || (uid !== undefined && st.uid !== uid)) throw new Error(`${path} must be yours and readable only by you (chmod 600)`);
  let raw: unknown;
  try { raw = JSON.parse(readNoFollow(path)); } catch { throw new Error(`${path} is not valid JSON; run jarvis release configure again`); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is refused: ${parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function saveReleaseSetup(projectDir: string, setup: ReleaseSetup, trust: TrustOptions = {}): string {
  const path = releaseSetupPath(projectDir);
  writePrivateAtomic(path, `${JSON.stringify(parseReleaseSetup(setup), null, 2)}\n`, trust);
  return path;
}

type Data = Record<string, unknown>;
const data = (e: LedgerEntry): Data => e.data !== null && typeof e.data === "object" ? e.data as Data : {};

/** revision → artifact hash, from the runner's own fixed-revision build records only (release/build.ts). */
export function registeredArtifacts(entries: readonly LedgerEntry[], project: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const e of entries) {
    const d = data(e);
    if (e.kind !== "decision" || e.actor !== "runner" || d.type !== ARTIFACT_TYPE || d.project !== project) continue;
    if (typeof d.revision === "string" && /^[a-f0-9]{40}$/.test(d.revision) && typeof d.artifactHash === "string" && /^[a-f0-9]{64}$/.test(d.artifactHash)) out[d.revision] = d.artifactHash;
  }
  return out;
}

/** Where release files live: build outputs in the runner's work area, deploy copies and snapshots in the project folder. */
export function releaseRoots(o: { projectDir: string; workRoot: string; project: string }) {
  return {
    artifactRoot: join(o.workRoot, "release", o.project, "artifacts"),
    privateRoot: join(o.projectDir, "release", "deploy"),
    snapshotRoot: join(o.projectDir, "release", "snapshots"),
    providerHome: join(o.projectDir, "release", "provider-home"),
    providerCwd: join(o.projectDir, "release", "provider-cwd"),
  };
}

/**
 * The ReleaseProjectConfig the adapters, the smoke test and the manifest check read. `artifacts` is a live view of
 * the ledger's build records, so the broker hosted before the build sees the binding the build records.
 */
export function releaseProjectConfig(setup: ReleaseSetup, o: { projectDir: string; workRoot: string; project: string; ledger: Pick<Ledger, "entries"> }): ReleaseProjectConfig {
  const roots = releaseRoots(o);
  for (const dir of [roots.artifactRoot, roots.privateRoot, roots.snapshotRoot, roots.providerHome, roots.providerCwd]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ledger = o.ledger;
  const project = o.project;
  return {
    project, provider: setup.provider, siteId: setup.siteId, ...(setup.orgId ? { orgId: setup.orgId } : {}), productionUrl: setup.productionUrl,
    ...(setup.render ? { render: setup.render } : {}),
    artifactRoot: roots.artifactRoot, privateRoot: roots.privateRoot, snapshotRoot: roots.snapshotRoot,
    get artifacts() { return registeredArtifacts(ledger.entries(), project); },
    ...(setup.data ? { dataSnapshot: { kind: setup.data.kind, source: setup.data.source } } : {}),
  };
}
