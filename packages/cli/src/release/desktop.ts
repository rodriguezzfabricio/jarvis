import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { runGate } from "../checks/gate.ts";
import { ChecksStore } from "../checks/store.ts";
import { checkTrustedDir } from "../config/private-file.ts";
import { installDesktopChecks, runDesktop } from "../lanes/desktop.ts";
import type { DesktopPlan } from "../lanes/desktop-types.ts";
import { materializeTree } from "../lanes/materialize.ts";
import { canonical, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import type { DesktopReleaseSetup } from "./config.ts";
import { artifactDigest } from "./manifest.ts";
import type { ReleaseStepInput, ReleaseStepOutcome } from "./run.ts";
import { recordReleaseStep } from "./run.ts";
import { evidenceIntact, releaseScope } from "./states.ts";

export const DESKTOP_ARTIFACT_TYPE = "release.desktop-artifact";
export const NATIVE_SMOKE_REASON = "input isolation is unavailable (decisions 102 and 118)";
type Data = Record<string, unknown>;
const data = (e: LedgerEntry): Data => e.data !== null && typeof e.data === "object" ? e.data as Data : {};

export function desktopReleasePlan(setup: DesktopReleaseSetup, nodeBin = process.execPath): DesktopPlan {
  // The protected shell command owns tool selection; the build worker verifies its output, offline.
  return { nodeBin, tauriBin: "/bin/sh", build: { bin: "/bin/sh", args: ["-c", setup.build.command] },
    bundle: `${setup.build.output}/${setup.bundle}`, buildTimeoutMs: setup.build.timeoutMs, stayUpMs: 1000, shutdownMs: 1000 };
}

/** Configure is the explicit approval boundary. Never bless edits to an already approved check store. */
export function installDesktopRelease(ledger: Ledger, setup: DesktopReleaseSetup): void {
  const store = new ChecksStore(ledger.dir);
  if (existsSync(store.lockPath) && !store.verify(ledger).ok) throw new Error("a protected check changed; restore the approved checks before configuring desktop");
  const path = join(store.checksDir, "desktop", "plan.json");
  const plan = desktopReleasePlan(setup);
  if (existsSync(path)) {
    if (!store.verify(ledger).ok || canonical(JSON.parse(readFileSync(path, "utf8"))) !== canonical(plan)) throw new Error("the protected desktop plan differs; changes need review");
    return;
  }
  installDesktopChecks(store, plan);
  store.approve(ledger, "jarvis release configure: approved desktop build plan and verifier");
}

/** Content hashes use artifactDigest; this additionally binds executable modes, directories and empty folders. */
function metadataHash(bundle: string): string {
  const entries: { path: string; mode: number; directory: boolean }[] = [];
  const walk = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error("desktop artifact must contain regular files and folders only");
    if (entries.length >= 200_001) throw new Error("desktop artifact entry limit exceeded");
    entries.push({ path: relative(bundle, path), mode: st.mode & 0o777, directory: st.isDirectory() });
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(bundle);
  return createHash("sha256").update(canonical(entries)).digest("hex");
}

export interface DesktopReleaseView {
  state: "built";
  entry: LedgerEntry;
  project: string;
  revision: string;
  appName: string;
  bundlePath: string;
  artifactHash: string;
  nativeSmoke: { status: "not run"; reason: string };
}

/** Latest result for every required check, under the current approved lock and bound to this release revision. */
function checksHold(entries: readonly LedgerEntry[], revision: string, seqs: unknown, names: readonly string[]): boolean {
  if (!Array.isArray(seqs) || !seqs.length || !names.length) return false;
  const approved = entries.filter(e => e.kind === "checks_approved" && e.actor === "runner").at(-1);
  if (!approved) return false;
  const latest = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const d = data(e);
    if (e.actor === "runner" && e.kind === "gate_result" && d.revision === revision && typeof d.check === "string" && !d.check.startsWith("release.")) latest.set(d.check, e);
  }
  return [...new Set([...names, ...latest.keys()])].every(name => {
    const e = latest.get(name);
    return !!e && e.task_id === null && seqs.includes(e.seq) && data(e).status === "pass"
      && data(e).checksLock === data(approved).lockHash && evidenceIntact(e);
  });
}

export function missingDesktopEvidence(entries: readonly LedgerEntry[], state: LedgerEntry): string[] {
  const d = data(state); const scope = releaseScope(entries); const missing: string[] = [];
  if (!scope.done || scope.lastGreen !== d.revision) missing.push("tasks");
  const required = Array.isArray(d.requiredChecks) && d.requiredChecks.every(n => typeof n === "string") ? d.requiredChecks as string[] : [];
  if (!checksHold(entries, String(d.revision), d.checks, [...scope.checks, ...required, "desktop-build"])) missing.push("checks");
  const artifact = entries.find(e => e.seq === d.artifactSeq && e.kind === "decision" && e.actor === "runner" && data(e).type === DESKTOP_ARTIFACT_TYPE);
  try {
    if (!artifact) throw new Error("no artifact");
    const a = data(artifact);
    if (a.revision !== d.revision || a.project !== d.project || a.buildSeq !== d.buildSeq || !evidenceIntact(artifact)) throw new Error("artifact binding differs");
    const bundle = String(a.bundlePath); const root = join(String(a.projectDir), "artifacts");
    if (relative(root, bundle).split("/").length !== 2 || !bundle.startsWith(root + "/") || realpathSync(bundle) !== bundle) throw new Error("artifact path differs");
    if (artifactDigest(bundle) !== a.artifactHash || metadataHash(bundle) !== a.metadataHash) throw new Error("artifact changed");
    const build = entries.find(e => e.seq === d.buildSeq);
    if (!build || data(build).check !== "desktop-build" || data(build).revision !== d.revision || data(build).status !== "pass" || !evidenceIntact(build)) throw new Error("build evidence missing");
  } catch { missing.push("artifact"); }
  return missing;
}

export function desktopReleaseView(entries: readonly LedgerEntry[], entry: LedgerEntry): DesktopReleaseView | undefined {
  if (missingDesktopEvidence(entries, entry).length) return undefined;
  const d = data(entry); const a = data(entries.find(e => e.seq === d.artifactSeq)!);
  return { state: "built", entry, project: String(d.project), revision: String(d.revision), appName: String(a.appName), bundlePath: String(a.bundlePath), artifactHash: String(a.artifactHash),
    nativeSmoke: { status: "not run", reason: NATIVE_SMOKE_REASON } };
}

/** Build and retain only; desktop has no ship session, provider, token or deployment operation. */
export async function runDesktopRelease(i: ReleaseStepInput, setup: DesktopReleaseSetup, revision: string, runId = randomUUID()): Promise<ReleaseStepOutcome> {
  const stop = (reason: string): ReleaseStepOutcome => { recordReleaseStep(i.ledger, runId, `stopped: ${reason}`); return { status: "stopped", reason }; };
  const store = new ChecksStore(i.projectDir);
  if (!store.verify(i.ledger).ok) return stop("a protected check changed");
  const planPath = join(store.checksDir, "desktop", "plan.json");
  if (!existsSync(planPath) || canonical(JSON.parse(readFileSync(planPath, "utf8"))) !== canonical(desktopReleasePlan(setup))) return stop("the desktop setup differs from the approved plan; run jarvis release configure");
  const root = join(realpathSync(i.projectDir), "artifacts"); mkdirSync(root, { recursive: true, mode: 0o700 }); checkTrustedDir(root);
  let room: string | undefined; let artifact: LedgerEntry | undefined;
  try {
    const built = await runDesktop({ ledger: i.ledger, store, projectDir: i.projectDir, jarvisHome: i.jarvisHome, workRoot: i.workRoot,
      repoPath: i.repoPath, revision, taskId: null, attemptId: `desktop-release-${runId}` }, {
      ...(i.seams?.desktop?.gate ? { gate: i.seams.desktop.gate } : {}),
      ...(i.seams?.desktop?.platform ? { platform: i.seams.desktop.platform } : {}),
      ...(i.seams?.desktop?.exists ? { exists: i.seams.desktop.exists } : {}),
      exportBundle: (captured, build) => {
        room = mkdtempSync(join(root, "desktop-"));
        const bundlePath = join(room, setup.bundle.split("/").at(-1)!);
        const files = materializeTree(captured.bundlePath, bundlePath, { sourceRoot: captured.bundlePath });
        if (!Object.keys(files).length || canonical(files) !== canonical(captured.files)) throw new Error("desktop artifact changed during export");
        const artifactHash = artifactDigest(bundlePath);
        artifact = i.ledger.append({ kind: "decision", actor: "runner", data: { type: DESKTOP_ARTIFACT_TYPE, project: i.projectId, projectDir: realpathSync(i.projectDir), revision,
          appName: setup.appName, bundlePath, artifactHash, metadataHash: metadataHash(bundlePath), buildSeq: build.entry.seq, evidence: (build.entry.data as Data).evidence } });
        room = undefined; // Durable artifact belongs to project state, never to the gate's cleanup.
      },
    });
    if (!artifact || !("result" in built) || built.result?.status !== "pass") return stop(`desktop build ${built.status}${"reason" in built ? `: ${built.reason}` : ""}`);
    const checks = [built.result.entry.seq];
    for (const check of i.checks) {
      const result = await (i.seams?.gate ?? runGate)({ ledger: i.ledger, store, projectDir: i.projectDir, jarvisHome: i.jarvisHome, workRoot: i.workRoot,
        repoPath: i.repoPath, revision, check, taskId: null, attemptId: `desktop-release-${runId}` });
      if (result.status !== "pass") return stop(`protected check ${check.name} ${result.status} on the release revision`);
      checks.push(result.entry.seq);
    }
    const state = { state: "built", project: i.projectId, revision, artifactSeq: artifact.seq, buildSeq: data(artifact).buildSeq, checks, requiredChecks: i.checks.map(c => c.name) };
    const candidate = { ...artifact, kind: "state_reached" as const, data: state };
    const missing = missingDesktopEvidence(i.ledger.entries(), candidate);
    if (missing.length) return stop(`built refused: missing ${missing.join(", ")}`);
    i.ledger.append({ kind: "state_reached", actor: "runner", data: state });
    const a = data(artifact); recordReleaseStep(i.ledger, runId, `built, not distributed; ${String(a.bundlePath)}; SHA-256 ${String(a.artifactHash)}; native smoke: not run (${NATIVE_SMOKE_REASON})`);
    return { status: "built", bundlePath: String(a.bundlePath), artifactHash: String(a.artifactHash) };
  } catch (error) { return stop(`desktop build could not finish: ${error instanceof Error ? error.message : String(error)}`); }
  finally { if (room) rmSync(room, { recursive: true, force: true }); }
}
