import type { BrokerRequest, BrokerResponse } from "../broker/broker.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import type { SessionOutcome } from "../proc/session.ts";

export type Provider = "vercel" | "netlify";
export type ReleaseAction = "preview" | "promote" | "rollback";
export type ReleaseState = "preview-ready" | "release-ready" | "deployed";
export interface CopyCommands {
  migrate: string;
  backup: string;
  restore: string;
  verify: string;
}
export interface ReleaseManifest {
  version: 1;
  project: string;
  revision: string;
  provider: Provider;
  /** Source output under the approved artifact root; only its verified private copy is deployed. */
  artifactDir: string;
  artifactHash: string;
  siteId: string;
  productionUrl: string;
  smokePaths: string[];
  migrations: string[];
  /** Legacy target claims are ignored; the broker captures the actual previous production ID. */
  rollback: { deploymentId?: string | undefined; url?: string | undefined; steps: string[] };
  /** source is a consistent SQLite snapshot or a Postgres dump, created by the runner. */
  data: { kind: "none" } | { kind: "sqlite" | "postgres"; source: string; commands: CopyCommands };
}
/** Loaded from protected runner setup/build state, never from the session's manifest. */
export interface ReleaseProjectConfig {
  project: string;
  provider: Provider;
  siteId: string;
  orgId?: string;
  productionUrl: string;
  artifactRoot: string;
  privateRoot: string;
  snapshotRoot: string;
  /** Written by the runner after building a fixed, checked revision. */
  artifacts: Record<string, string>;
  /** A consistent SQLite snapshot or Postgres dump selected by runner-owned project config. */
  dataSnapshot?: { kind: "sqlite" | "postgres"; source: string };
}
export interface ReleaseEvidence {
  checks?: number[];
  previewDeploy?: number;
  previewSmoke?: number;
  manifest?: number;
  rollback?: number;
  rehearsal?: number;
  restore?: number;
  production?: number;
  smoke?: number;
  failureSignal?: number;
}
export interface ReachStateInput {
  ledger: Ledger;
  manifest: ReleaseManifest;
  state: ReleaseState;
  evidence: ReleaseEvidence;
}
export interface StateResult {
  missing: string[];
  entry?: LedgerEntry;
}
export interface CopyCommandSpec {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** The executor must enforce this isolation before running any project command. */
  isolation: { readOnlySource: string; writableRoot: string; network: "none"; credentials: "none"; database: "sqlite" | "postgres" };
}
export interface RehearsalInput {
  ledger: Ledger;
  manifest: ReleaseManifest;
  workRoot: string;
  snapshotRoot: string;
  /** Runner-owned executor: sandbox project commands; provide a disposable local DB for Postgres. */
  execute: (spec: CopyCommandSpec) => Promise<SessionOutcome>;
  timeoutMs?: number;
}
export interface SmokeInput {
  ledger: Ledger;
  manifest: ReleaseManifest;
  projectConfig: ReleaseProjectConfig;
  deploymentSeq: number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retries?: number;
}
export interface RecoveryInput {
  ledger: Ledger;
  manifest: ReleaseManifest;
  smokeSeq: number;
  broker: { handle(req: BrokerRequest): Promise<BrokerResponse> };
  notify(message: string): Promise<void>;
}
