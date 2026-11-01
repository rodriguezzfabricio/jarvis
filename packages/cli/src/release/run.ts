import { randomUUID } from "node:crypto";
import type { Adapter, BrokerRequest, BrokerResponse } from "../broker/broker.ts";
import { deployAdapters } from "../broker/adapters/index.ts";
import type { ProviderConfig } from "../broker/adapters/types.ts";
import { runGate, type GateCheck, type GateInput, type GateResult } from "../checks/gate.ts";
import { ChecksStore } from "../checks/store.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import type { SessionOutcome, SessionSpec } from "../proc/session.ts";
import type { Harness, TaskTier } from "../runner/harness.ts";
import type { RoutingTable } from "../runner/routing.ts";
import type { runSandboxed } from "../sandbox/srt.ts";
import { acceptedManifest, recordAcceptedManifest } from "./accepted.ts";
import { buildRelease } from "./build.ts";
import { FREE_PLANS, loadReleaseSetup, releaseProjectConfig, releaseRoots, STEP_TYPE, type ReleaseSetup } from "./config.ts";
import { hasReleaseGrant } from "./grants.ts";
import { checkManifest, manifestHash, releaseRef } from "./manifest.ts";
import { verifyProviderCli, type ProviderCliCheck, type ProviderCliDeps } from "./provider-cli.ts";
import { acceptManifest, runShipStep, SHIP_TASK } from "./ship.ts";
import { recoverFailedSmoke, runSmoke } from "./smoke.ts";
import { reachState, releaseScope } from "./states.ts";
import type { ReleaseManifest, ReleaseProjectConfig } from "./types.ts";

/**
 * The run's release step (decision 157; release/integration.md "Evidence sequence" 1–3). After every planned task
 * is done, on the revision the runner last promoted: the ship session's manifest claims, the runner's own build of
 * that revision, every approved protected check on it, a preview through the hosted broker, the smoke test on the
 * broker-reported URL, then preview-ready. Production stays gated: the step never asks for deploy.promote, and the
 * broker's adapter refuses one without a grant bound to this manifest (`jarvis release grant`).
 */
export interface ReleaseSeams {
  /** Provider CLI pins, path and runner (tests use a fake provider script and fake pins). */
  cli?: ProviderCliDeps;
  /** The adapters' provider command runner (default runSession). */
  run?: (spec: SessionSpec) => Promise<SessionOutcome>;
  fetch?: typeof globalThis.fetch;
  gate?: (input: GateInput) => Promise<GateResult>;
  sandbox?: typeof runSandboxed;
}
export interface ReleaseRuntime {
  setup: ReleaseSetup;
  config: ReleaseProjectConfig;
  providerConfig: ProviderConfig | undefined;
  /** Verifies the provider CLI again; the step calls it before anything is spent on a release, and right before the deploy. */
  verifyCli(): Promise<ProviderCliCheck>;
  /** The broker's deploy.preview and deploy.promote adapters, in place of the stage 1 outbox for those operations. */
  adapters: Adapter[];
}
export interface ReleaseHost { projectId: string; projectDir: string; workRoot: string; worktreeRoot: string; repoPath: string; home: string; ledger: Ledger }

/** undefined when the project has no release setup: the run keeps the outbox for every operation (evals, stage 1). */
export async function prepareRelease(o: ReleaseHost, seams: ReleaseSeams = {}): Promise<ReleaseRuntime | undefined> {
  const setup = loadReleaseSetup(o.projectDir);
  if (!setup) return undefined;
  const config = releaseProjectConfig(setup, { projectDir: o.projectDir, workRoot: o.workRoot, project: o.projectId, ledger: o.ledger });
  const roots = releaseRoots({ projectDir: o.projectDir, workRoot: o.workRoot, project: o.projectId });
  const verifyCli = () => verifyProviderCli({ provider: setup.provider, home: o.home, providerHome: roots.providerHome, providerCwd: roots.providerCwd,
    untrusted: [o.repoPath, o.worktreeRoot, o.workRoot] }, seams.cli);
  const cli = await verifyCli();
  const providerConfig = cli.ok ? { bin: cli.bin, version: cli.version, ...(cli.interpreter ? { interpreter: cli.interpreter } : {}), ...(cli.ssh ? { ssh: cli.ssh } : {}), home: roots.providerHome, cwd: roots.providerCwd } : undefined;
  const adapters = deployAdapters({ ledger: o.ledger, project: o.projectId, projectConfig: config,
    resolveManifest: (hash) => acceptedManifest(o.ledger.entries(), hash),
    providers: providerConfig ? { [setup.provider]: providerConfig } : {}, ...(seams.run ? { run: seams.run } : {}), ...(seams.fetch ? { fetch: seams.fetch } : {}) });
  return { setup, config, providerConfig, verifyCli, adapters };
}

export interface ReleaseStepInput {
  runtime: ReleaseRuntime;
  ledger: Ledger;
  broker: { handle(req: BrokerRequest): Promise<BrokerResponse> };
  projectId: string;
  projectDir: string;
  jarvisHome: string;
  repoPath: string;
  workRoot: string;
  worktreeRoot: string;
  gitHome: string;
  runBranch: string;
  /** The runner's git in the main checkout. */
  git(args: readonly string[]): string;
  /** Every approved protected check: all of them run on the release revision. */
  checks: readonly GateCheck[];
  harness: Harness;
  routing: RoutingTable;
  tier: TaskTier;
  maxTurns: number;
  timeoutMs: number;
  notify?: (text: string) => Promise<void>;
  seams?: ReleaseSeams;
}
export type ReleaseStepOutcome = { status: "preview-ready"; manifestHash: string; url: string } | { status: "stopped"; reason: string };

type Data = Record<string, unknown>;
const data = (e: LedgerEntry | undefined): Data => e && e.data !== null && typeof e.data === "object" ? e.data as Data : {};
const short = (value: unknown) => String(value).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 300);

/** One line in the ledger per release step outcome; REPORT.md shows the latest one when no release state holds. */
export function recordReleaseStep(ledger: Ledger, runId: string, outcome: string, extra: Data = {}): LedgerEntry {
  return ledger.append({ kind: "decision", actor: "runner", data: { ...extra, type: STEP_TYPE, runId, outcome: short(outcome) } });
}

export async function runReleaseStep(i: ReleaseStepInput): Promise<ReleaseStepOutcome> {
  const runId = randomUUID();
  const { runtime, ledger } = i;
  const setup = runtime.setup;
  const stop = (reason: string, extra: Data = {}): ReleaseStepOutcome => { recordReleaseStep(ledger, runId, `stopped: ${reason}`, extra); return { status: "stopped", reason }; };

  // The revision: the run branch head, and it must be the one the runner last promoted with every planned task done.
  const revision = i.git(["rev-parse", "--verify", `refs/heads/${i.runBranch}^{commit}`]);
  const scope = releaseScope(ledger.entries());
  if (!scope.done) return stop("not every planned task is done; a release ships only finished, gated and reviewed work");
  if (scope.lastGreen !== revision) return stop(`the run branch head ${revision} is not the revision the runner last promoted (${scope.lastGreen ?? "none"})`);
  // The spend policy (decision 157): a preview on the provider's free plan costs nothing; anything else is refused here.
  if (setup.plan !== FREE_PLANS[setup.provider]) return stop(`${setup.provider} plan "${setup.plan}" is not the free plan; nothing that could spend runs without an approval`);
  const early = await runtime.verifyCli();
  if (!early.ok) return stop(early.reason);

  // 1. The ship session's claims.
  const ship = await runShipStep({ harness: i.harness, ledger, routing: i.routing, tier: i.tier, runId, projectId: i.projectId, projectDir: i.projectDir, repoPath: i.repoPath,
    revision, worktreeRoot: i.worktreeRoot, gitHome: i.gitHome, facts: { project: i.projectId, revision, setup, maxTurns: i.maxTurns }, timeoutMs: i.timeoutMs });
  if (ship.kind === "usage-limited") return stop("the usage limit stopped the ship session; the release waits for the next run");
  if (ship.kind === "failed") return stop(ship.reason);
  if (ship.notes) ledger.append({ kind: "reconciled", actor: "runner", task_id: SHIP_TASK, attempt_id: runId, data: { type: "agent_claim", runId, text: ship.notes.slice(0, 65_536), source: `.jarvis/notes/${SHIP_TASK}.md` } });
  const stray = ship.stray.length ? `; the ship session also changed ${ship.stray.join(", ")}, discarded` : "";

  // 2. The runner's own build of the checked revision, registered by its digest.
  const built = await buildRelease({ ledger, project: i.projectId, projectDir: i.projectDir, jarvisHome: i.jarvisHome, workRoot: i.workRoot, repoPath: i.repoPath,
    revision, build: setup.build, artifactRoot: runtime.config.artifactRoot, runId, gitHome: i.gitHome, ...(i.seams?.sandbox ? { sandbox: i.seams.sandbox } : {}) });
  if (built.status === "fail") return stop(built.reason);

  // 3. Acceptance: runner values everywhere a destination, revision or artifact is named; checked against setup.
  let manifest: ReleaseManifest;
  try {
    manifest = acceptManifest(ship.claims, { project: i.projectId, revision, setup, config: runtime.config, artifactDir: built.artifactDir, artifactHash: built.artifactHash });
    checkManifest(manifest, runtime.config);
  } catch (e) { return stop(`the ship session's manifest is refused: ${short(e instanceof Error ? e.message : e)}`); }
  recordAcceptedManifest(ledger, manifest, { runId });
  const hash = manifestHash(manifest);

  // 4. Every approved protected check on the release revision, bound to no task.
  const store = new ChecksStore(i.projectDir);
  const checkSeqs: number[] = [];
  for (const check of i.checks) {
    const result = await (i.seams?.gate ?? runGate)({ ledger, store, projectDir: i.projectDir, jarvisHome: i.jarvisHome, workRoot: i.workRoot, repoPath: i.repoPath,
      revision, check, taskId: null, attemptId: `release-${runId}` });
    if (result.status === "tampered") return stop("a protected check changed", { manifestHash: hash });
    if (result.status !== "pass") return stop(`protected check ${check.name} ${result.status === "fail" ? "failed" : "could not run"} on the release revision`, { manifestHash: hash });
    checkSeqs.push(result.entry.seq);
  }

  // 5. The preview, through the hosted broker; the CLI is verified again right before it is used.
  const cli = await runtime.verifyCli();
  if (!cli.ok || cli.bin !== runtime.providerConfig?.bin) return stop(cli.ok ? "the provider CLI changed since the broker was hosted" : cli.reason, { manifestHash: hash });
  const response = await i.broker.handle({ op: "deploy.preview", payload: { ref: releaseRef(manifest, "preview") } });
  const receipt = ledger.entries().filter((e) => e.kind === "broker_receipt" && e.actor === "broker" && data(e).payloadHash === response.payloadHash).at(-1);
  if (response.status !== "succeeded" || !receipt || data(receipt).status !== "succeeded") {
    const reason = (data(receipt).detail as Data | undefined)?.reason;
    return stop(`the preview deploy ${response.status}${typeof reason === "string" ? `: ${reason}` : ""}`, { manifestHash: hash });
  }
  const url = String((data(receipt).detail as Data).url);

  // 6. The smoke test on the broker-reported URL; a failure notifies and stops.
  const smoke = await runSmoke({ ledger, manifest, projectConfig: runtime.config, deploymentSeq: receipt.seq, ...(i.seams?.fetch ? { fetch: i.seams.fetch } : {}) });
  if (data(smoke).status !== "pass") {
    await recoverFailedSmoke({ ledger, manifest, smokeSeq: smoke.seq, broker: i.broker, notify: i.notify ?? (async () => {}) });
    return stop(`the preview smoke test failed at ${url}`, { manifestHash: hash });
  }

  // 7. Preview-ready, against the complete required set.
  const reached = reachState({ ledger, manifest, state: "preview-ready", evidence: { checks: checkSeqs, previewDeploy: receipt.seq, previewSmoke: smoke.seq },
    requiredChecks: i.checks.map((c) => c.name) });
  if (reached.missing.length) return stop(`preview-ready refused: missing ${reached.missing.join(", ")}`, { manifestHash: hash });
  recordReleaseStep(ledger, runId, `preview-ready at ${url}${hasReleaseGrant(ledger, manifest)
    ? "; a production grant is bound to this manifest, but promotion needs release-ready (data rehearsal, backup restore), which the runner doesn't run yet"
    : `; production gated: no grant is bound to manifest ${hash}`}${stray}`, { manifestHash: hash });
  return { status: "preview-ready", manifestHash: hash, url };
}
