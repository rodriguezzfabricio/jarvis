import type { Ledger } from "../../ledger/ledger.ts";
import type { SessionOutcome, SessionSpec } from "../../proc/session.ts";
import type { Provider, ReleaseAction, ReleaseManifest, ReleaseProjectConfig } from "../../release/types.ts";

export interface ProviderConfig {
  /** Trusted absolute CLI path, installed outside candidate-writable directories. */
  bin: string;
  /** Exact x.y.z pin. Missing legacy pins fail closed before reading a credential. */
  version?: string;
  /** Existing runner-owned parents below ledger.dir; fresh children are created per process. */
  home: string;
  cwd: string;
}
export interface DeployAdapterOptions {
  ledger: Ledger;
  project: string;
  projectConfig: ReleaseProjectConfig;
  resolveManifest(hash: string): ReleaseManifest | undefined;
  providers: Partial<Record<Provider, ProviderConfig>>;
  run?: (spec: SessionSpec) => Promise<SessionOutcome>;
  readyToPromote?: (manifest: ReleaseManifest) => boolean;
  timeoutMs?: number;
}
export interface ProviderCommand {
  args: string[];
  env: Record<string, string>;
  readUrl(stdout: string): string;
}
export interface ProductionDeployment { id: string; url: string }
