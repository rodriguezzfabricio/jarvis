import type { AdapterResult, SecretsBackend } from "../broker.ts";
import type { NativeToolPin } from "../../release/render-tools.ts";
import type { Ledger } from "../../ledger/ledger.ts";
import type { SessionOutcome, SessionSpec } from "../../proc/session.ts";
import type { Provider, ReleaseAction, ReleaseManifest, ReleaseProjectConfig } from "../../release/types.ts";

export interface ProviderConfig {
  /** Trusted absolute CLI path, installed outside candidate-writable directories. */
  bin: string;
  /** Exact CLI version (or native Git version line from RENDER_TOOL_PINS), checked against `--version` before every credential read. */
  version: string;
  /**
   * Absolute interpreter that runs `bin` (pinnedProviderNode() for the npm CLIs, whose `#!/usr/bin/env node` finds no
   * node under the adapters' PATH); omitted for a native binary. Started as `<interpreter> <bin> <args>`.
   */
  interpreter?: string;
  ssh?: { bin: string; version: string };
  /** Existing runner-owned parents below ledger.dir; fresh children are created per process. */
  home: string;
  cwd: string;
}
/** One deploy provider's commands and output readers (providers.ts). Nothing outside this module set names a provider. */
export interface ProviderModule {
  /** For messages: "Vercel CLI". */
  label: string;
  cli?: { bin(home: string): string; pin(): { version: string } | undefined };
  /** Native providers own a multi-process deployment, still behind the shared policy/copy gates. */
  deploy?(input: ProviderDeployInput): Promise<AdapterResult>;
  tools?(): readonly NativeToolPin[] | undefined;
  verify?(options: DeployAdapterOptions, config: ProviderConfig): Promise<void>;
  validateSetup?(setup: ReleaseProjectConfig): void;
  rollbackFromManifest?: boolean;
  markerPath?: string;
  /** Deploy (preview, promote) of the runner-built tree at `manifest.artifactDir`, or rollback to `target`. */
  command(manifest: ReleaseManifest, setup: ReleaseProjectConfig, action: ReleaseAction, token: string, target?: ProductionDeployment): ProviderCommand;
  /** Reads the provider's current production deployment for setup's site. */
  currentCommand(setup: ReleaseProjectConfig, token: string): ProviderCommand;
  readCurrent(stdout: string, setup: ReleaseProjectConfig): ProductionDeployment;
  /** The exact x.y.z its `--version` stdout names, or undefined. */
  version(stdout: string): string | undefined;
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
  fetch?: typeof globalThis.fetch;
  readiness?: { timeoutMs: number; intervalMs: number };
}
export interface ProviderCommand {
  args: string[];
  env: Record<string, string>;
  readUrl(stdout: string): string;
}
export interface ProductionDeployment { id: string; url: string }

export interface ProviderDeployInput {
  options: DeployAdapterOptions;
  config: ProviderConfig;
  manifest: ReleaseManifest;
  /** For rollback, the earlier verified manifest. Otherwise the requested manifest. */
  treeManifest: ReleaseManifest;
  staged: { dir: string; dispose(): void };
  action: ReleaseAction;
  secrets: SecretsBackend;
  target?: ProductionDeployment | undefined;
}
