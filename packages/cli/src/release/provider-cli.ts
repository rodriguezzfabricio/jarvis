import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pinnedProviderBin, PROVIDER_CLI_PINS } from "../config/pins.ts";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import { within } from "./paths.ts";
import type { Provider } from "./types.ts";

/**
 * The provider CLI is verified before every use (decision 157): it runs outside the sandbox with a deploy token,
 * so it must be the pinned version, at its pinned path, in a file and folder only Fabricio (or root) can change,
 * and outside every folder a session or a candidate build can write. The version is read with the same command
 * environment the broker's adapters use, so a CLI that can't start there fails here first.
 */
export type ProviderCliCheck = { ok: true; bin: string; version: string } | { ok: false; reason: string };
export interface ProviderCliInput {
  provider: Provider;
  /** The home the pinned path is under. */
  home: string;
  /** The adapters' private provider home and control folder (release/config.ts releaseRoots). */
  providerHome: string;
  providerCwd: string;
  /** Folders sessions or candidate code can write (the repo, worktrees, the work root): the CLI may not live there. */
  untrusted: readonly string[];
}
export interface ProviderCliDeps {
  pins?: Readonly<Partial<Record<Provider, { version: string }>>>;
  bin?: (provider: Provider, home: string) => string;
  run?: (spec: SessionSpec) => Promise<SessionOutcome>;
  /** Test seam for ownership checks; defaults to process.getuid(). */
  uid?: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function trusted(path: string, uid: number | undefined): string | undefined {
  const st = statSync(path);
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) return `${path} belongs to uid ${st.uid}`;
  if ((st.mode & 0o022) !== 0) return `${path} is writable by others`;
  return undefined;
}

export async function verifyProviderCli(input: ProviderCliInput, deps: ProviderCliDeps = {}): Promise<ProviderCliCheck> {
  const pin = (deps.pins ?? PROVIDER_CLI_PINS)[input.provider];
  if (!pin || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pin.version)) return { ok: false, reason: `no pinned ${input.provider} CLI version (config/pins.ts PROVIDER_CLI_PINS)` };
  const pinned = (deps.bin ?? pinnedProviderBin)(input.provider, input.home);
  if (!isAbsolute(pinned)) return { ok: false, reason: `the ${input.provider} CLI path must be absolute` };
  let bin: string;
  try { bin = realpathSync(pinned); } catch { return { ok: false, reason: `the ${input.provider} CLI is not installed at ${pinned}` }; }
  const uid = deps.uid ?? process.getuid?.();
  try {
    if (!statSync(bin).isFile() || (statSync(bin).mode & 0o111) === 0) return { ok: false, reason: `${bin} is not an executable file` };
    const problem = trusted(bin, uid) ?? trusted(dirname(bin), uid);
    if (problem) return { ok: false, reason: `the ${input.provider} CLI is refused: ${problem}` };
    for (const root of input.untrusted) {
      let real: string;
      try { real = realpathSync(root); } catch { continue; }
      if (within(real, bin, true)) return { ok: false, reason: `the ${input.provider} CLI lives in a folder sessions or builds can write (${root})` };
    }
  } catch (error) { return { ok: false, reason: `the ${input.provider} CLI could not be checked: ${(error as Error).message}` }; }
  let result: SessionOutcome;
  try {
    result = await (deps.run ?? runSession)({ bin, args: ["--version"], cwd: input.providerCwd, env: { PATH: "/usr/bin:/bin", HOME: input.providerHome, CI: "1" },
      timeoutMs: 30_000, killGraceMs: 2_000, maxOutputBytes: 64 * 1024 });
  } catch (error) { return { ok: false, reason: `the ${input.provider} CLI did not start: ${(error as Error).message}` }; }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || result.timedOut || result.overflowed) return { ok: false, reason: `the ${input.provider} CLI's --version failed (exit ${String(result.code)})` };
  // The exact version as a whole token: "41.2.0" never matches 141.2.0, 41.2.0.1, 41.2.0-beta.1 or 41.2.0+build.
  if (!new RegExp(`(?:^|[^0-9A-Za-z.])v?${escape(pin.version)}(?:$|[^0-9A-Za-z.+-])`, "m").test(output)) return { ok: false, reason: `the ${input.provider} CLI is not the pinned version ${pin.version}` };
  return { ok: true, bin, version: pin.version };
}
