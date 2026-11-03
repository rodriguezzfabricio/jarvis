import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../eval/git.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Harness, TaskOutcome, TaskTier } from "../runner/harness.ts";
import { routeTask, type RoutingTable } from "../runner/routing.ts";
import { loadSkills } from "../runner/session-skills.ts";
import { recordSessionUsage } from "../runner/usage-log.ts";
import { createWorkspace, readTaskNotes } from "../runner/worktrees.ts";
import type { WebReleaseSetup } from "./config.ts";
import { parseManifest } from "./manifest.ts";
import { createDataSnapshot } from "./rehearsal.ts";
import type { ReleaseManifest, ReleaseProjectConfig } from "./types.ts";

/**
 * The ship step (decision 157): one fresh session, in a fresh checkout of the checked revision, with the ship skill
 * as text (decision 114). It writes `.jarvis/release/manifest.json`; the runner reads that one file after the session
 * ends, keeps only the fields a session may claim (smoke paths, migrations, rollback steps, data commands), and
 * discards everything else the session changed. Never retried; a session that leaves no usable manifest stops the
 * release before anything is built or deployed.
 */
export const SHIP_TASK = "ship";
export const SHIP_MANIFEST = ".jarvis/release/manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface ShipClaims {
  smokePaths: unknown;
  migrations: unknown;
  rollbackSteps: unknown;
  data: unknown;
}
export interface ShipFacts { project: string; revision: string; setup: WebReleaseSetup; maxTurns: number }

export function shipPrompt(f: ShipFacts): string {
  return [
    `Task: ${SHIP_TASK}`,
    `Goal: Prepare the release manifest for revision ${f.revision} of ${f.project}, for a preview deploy on ${f.setup.provider}.`,
    `Exit condition: ${SHIP_MANIFEST} is written; or stop after ${f.maxTurns} turns.`,
    "The runner fills these fields itself and ignores what the manifest says about them: version, project, revision, provider, siteId, productionUrl,",
    `artifactDir and artifactHash (its own build of this revision with \`${f.setup.build.command}\`, output folder ${f.setup.build.output}), and data.source.`,
    "Write only: smokePaths (absolute paths such as \"/\" and a health check, with the main user path), migrations (file names), rollback.steps (written recovery steps),",
    "and data: {\"kind\": \"none\"} with no persistent data, else {\"kind\": \"sqlite\" or \"postgres\", \"commands\": {\"migrate\", \"backup\", \"restore\", \"verify\"}} using $JARVIS_DATA_COPY, $JARVIS_BACKUP and $JARVIS_RESTORE.",
    "Do not deploy, run a provider CLI, call jarvis act, or change any other file: the runner builds and deploys the preview after this session ends, and discards anything else you change.",
    `Write your result notes to .jarvis/notes/${SHIP_TASK}.md.`,
  ].join("\n");
}

export function shipHeader(i: { runId: string; skills: readonly { name: string; text: string }[] }): string {
  return [
    `Jarvis run: ${i.runId}`,
    "Role: the ship step. Your manifest and notes are claims, not evidence: the runner checks the manifest against its protected setup and its own build, then deploys, smoke-tests and records the release state.",
    "",
    `This session has no Skill tool, so the runner includes the Jarvis skill it follows: ${i.skills.map((s) => s.name).join(", ")}. Here the runner supplies the release ref and makes the broker request itself; write the manifest and your notes, nothing else.`,
    ...i.skills.map((s) => `<skill name="${s.name}">\n${s.text}\n</skill>`),
  ].join("\n\n") + "\n";
}

/** The manifest file a session wrote, read without following links, bounded, from plain folders only. */
export function readShipClaims(workspace: string): ShipClaims {
  for (const dir of [join(workspace, ".jarvis"), join(workspace, ".jarvis", "release")]) {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) throw new Error(`the ship session wrote no ${SHIP_MANIFEST}`);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} must be a plain folder`);
  }
  const path = join(workspace, SHIP_MANIFEST);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`the ship session wrote no ${SHIP_MANIFEST}`);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) throw new Error(`${SHIP_MANIFEST} must be a regular, unlinked file`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${SHIP_MANIFEST} must be a regular file`);
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let used = 0;
    for (let n = 1; n > 0 && used < buffer.length;) { n = readSync(fd, buffer, used, buffer.length - used, null); used += n; }
    if (used > MAX_MANIFEST_BYTES) throw new Error(`${SHIP_MANIFEST} is over ${MAX_MANIFEST_BYTES} bytes`);
    text = buffer.subarray(0, used).toString("utf8");
  } finally { closeSync(fd); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${SHIP_MANIFEST} is not JSON`); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${SHIP_MANIFEST} is not a JSON object`);
  const r = raw as Record<string, unknown>;
  const rollback = r.rollback !== null && typeof r.rollback === "object" ? (r.rollback as Record<string, unknown>).steps : undefined;
  return { smokePaths: r.smokePaths, migrations: r.migrations ?? [], rollbackSteps: rollback, data: r.data };
}

/**
 * The accepted manifest: the session's claims, with every destination, revision and artifact value from the runner.
 * A data snapshot is the runner's fresh private copy of the configured source, never a path the session named.
 */
export function acceptManifest(claims: ShipClaims, r: { project: string; revision: string; setup: WebReleaseSetup; config: ReleaseProjectConfig; artifactDir: string; artifactHash: string }): ReleaseManifest {
  const data = claims.data !== null && typeof claims.data === "object" ? claims.data as Record<string, unknown> : { kind: claims.data };
  let manifestData: unknown;
  if (data.kind === "none") manifestData = { kind: "none" };
  else if (data.kind === "sqlite" || data.kind === "postgres") {
    if (r.setup.data?.kind !== data.kind) throw new Error(`the manifest declares ${String(data.kind)} data, but the project's release setup has ${r.setup.data ? `${r.setup.data.kind} data` : "no data snapshot source"} (jarvis release configure)`);
    manifestData = { kind: data.kind, source: createDataSnapshot(r.config).source, commands: data.commands };
  } else throw new Error("the manifest's data.kind must be none, sqlite or postgres");
  return parseManifest({
    version: 1, project: r.project, revision: r.revision, provider: r.setup.provider, artifactDir: r.artifactDir, artifactHash: r.artifactHash,
    siteId: r.setup.siteId, productionUrl: r.setup.productionUrl, smokePaths: claims.smokePaths, migrations: claims.migrations,
    rollback: { steps: claims.rollbackSteps }, data: manifestData,
  });
}

export type ShipStepResult =
  | { kind: "claims"; claims: ShipClaims; notes: string | undefined; stray: string[] }
  | { kind: "usage-limited"; until: number | undefined }
  | { kind: "failed"; reason: string };

export interface ShipStepInput {
  harness: Harness;
  ledger: Ledger;
  routing: RoutingTable;
  tier: TaskTier;
  runId: string;
  projectId: string;
  projectDir: string;
  repoPath: string;
  revision: string;
  worktreeRoot: string;
  gitHome: string;
  facts: ShipFacts;
  timeoutMs: number;
}

/** What the session changed besides runner metadata: discarded with its checkout, and said so. */
function strayEdits(workspace: string, home: string): string[] {
  const raw = safeGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { home }).toString();
  return raw.split("\0").filter(Boolean).map((row) => row.slice(3)).filter((path) => !path.startsWith(".jarvis/")).slice(0, 20);
}

export async function runShipStep(i: ShipStepInput): Promise<ShipStepResult> {
  const ws = createWorkspace({ repoPath: i.repoPath, projectId: i.projectId, taskId: SHIP_TASK, attemptId: i.runId, baseRevision: i.revision, worktreeRoot: i.worktreeRoot, home: i.gitHome });
  try {
    const sessionDir = join(i.projectDir, "sessions", `${SHIP_TASK}-${i.runId}`);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const header = join(sessionDir, "header.md");
    writeFileSync(header, shipHeader({ runId: i.runId, skills: loadSkills([SHIP_TASK]) }), { flag: "wx", mode: 0o600 });
    const outcome: TaskOutcome = await i.harness.runTask({ workspace: ws.path, prompt: shipPrompt(i.facts), runHeaderPath: header, role: "build", tier: i.tier,
      maxTurns: i.facts.maxTurns, timeoutMs: i.timeoutMs, logPath: join(sessionDir, "stream.jsonl") });
    recordSessionUsage(i.ledger, { runId: i.runId, taskId: SHIP_TASK, attemptId: i.runId, role: "build", tier: i.tier, route: routeTask("build", i.tier, undefined, i.routing), outcome });
    if (outcome.status === "usage-limited") return { kind: "usage-limited", until: outcome.resetAt ?? outcome.usageWaitUntil };
    if (outcome.status !== "finished") return { kind: "failed", reason: `the ship session ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : "message" in outcome ? `: ${outcome.message}` : ""}` };
    let claims: ShipClaims;
    try { claims = readShipClaims(ws.path); } catch (e) { return { kind: "failed", reason: e instanceof Error ? e.message : String(e) }; }
    let notes: string | undefined;
    try { notes = readTaskNotes(ws)?.text; } catch { notes = undefined; }
    return { kind: "claims", claims, notes, stray: strayEdits(ws.path, i.gitHome) };
  } finally {
    rmSync(ws.path, { recursive: true, force: true }); // only the manifest and notes leave this checkout, through the runner
  }
}
