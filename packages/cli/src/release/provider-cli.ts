import { PROVIDERS } from "../broker/adapters/providers.ts";
import type { NativeToolPin } from "./render-tools.ts";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pinnedProviderNode } from "../config/pins.ts";
import { providerLaunch } from "../broker/adapters/execution.ts";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import { within } from "./paths.ts";
import type { Provider } from "./types.ts";

/**
 * The provider CLI is verified before every use (decision 157): it runs outside the sandbox with a deploy token,
 * so it must be the pinned version, at its pinned path, in a file and folder only Fabricio (or root) can change,
 * and outside every folder a session or a candidate build can write. The version is read with the same command
 * environment the broker's adapters use, so a CLI that can't start there fails here first.
 */
export type ProviderCliCheck = { ok: true; bin: string; version: string; interpreter?: string; ssh?: { bin: string; version: string } } | { ok: false; reason: string };
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
  nativeTools?: readonly NativeToolPin[];
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
  const provider = PROVIDERS[input.provider];
  if (provider.tools) return verifyNativeTools(input, deps, deps.nativeTools ?? provider.tools());
  const pin = deps.pins ? deps.pins[input.provider] : provider.cli?.pin();
  if (!pin || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pin.version)) return { ok: false, reason: `no pinned ${input.provider} CLI version (config/pins.ts PROVIDER_CLI_PINS)` };
  const pinned = deps.bin ? deps.bin(input.provider, input.home) : provider.cli!.bin(input.home);
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
    // Started as the adapters start it (decision 161): the npm CLIs under the pinned Node, never node through PATH.
    const launch = providerLaunch({ bin, interpreter: pinnedProviderNode() }, ["--version"]);
    result = await (deps.run ?? runSession)({ bin: launch.bin, args: launch.args, cwd: input.providerCwd, env: { PATH: "/usr/bin:/bin", HOME: input.providerHome, CI: "1" },
      timeoutMs: 30_000, killGraceMs: 2_000, maxOutputBytes: 64 * 1024 });
  } catch (error) { return { ok: false, reason: `the ${input.provider} CLI did not start: ${(error as Error).message}` }; }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || result.timedOut || result.overflowed) return { ok: false, reason: `the ${input.provider} CLI's --version failed (exit ${String(result.code)})` };
  // The exact version as a whole token: "41.2.0" never matches 141.2.0, 41.2.0.1, 41.2.0-beta.1 or 41.2.0+build.
  if (!new RegExp(`(?:^|[^0-9A-Za-z.])v?${escape(pin.version)}(?:$|[^0-9A-Za-z.+-])`, "m").test(output)) return { ok: false, reason: `the ${input.provider} CLI is not the pinned version ${pin.version}` };
  return { ok: true, bin, version: pin.version, interpreter: pinnedProviderNode() };
}

/** Native providers use absolute executables directly, including their companion transport binary. */
async function verifyNativeTools(input: ProviderCliInput, deps: ProviderCliDeps, tools: readonly NativeToolPin[] | undefined): Promise<ProviderCliCheck> {
  if (!tools || tools.length !== 2) return { ok: false, reason: "no pinned Render Git/SSH tools (config/pins.ts RENDER_TOOL_PINS)" };
  const paths: string[] = [];
  try {
    for (const tool of tools) {
      if (!isAbsolute(tool.bin) || !tool.version) throw new Error("absolute native tool and exact version required");
      const bin = realpathSync(tool.bin), st = statSync(bin);
      if (!st.isFile() || (st.mode & 0o111) === 0) throw new Error("native tool is not executable");
      const issue = trusted(bin, deps.uid ?? process.getuid?.()) ?? trusted(dirname(bin), deps.uid ?? process.getuid?.());
      if (issue) throw new Error(issue);
      for (const root of input.untrusted) {
        let real: string; try { real = realpathSync(root); } catch { continue; }
        if (within(real, bin, true)) throw new Error("native tool is in an untrusted root");
      }
      paths.push(bin);
    }
    for (const [i, tool] of tools.entries()) {
      const home = mkdtempSync(join(input.providerHome, "native-home-")); let cwd: string | undefined;
      try {
        cwd = mkdtempSync(join(input.providerCwd, "native-cwd-"));
        const result = await (deps.run ?? runSession)({ bin: paths[i]!, args: tool.args, cwd,
          env: { PATH: "/usr/bin:/bin", HOME: home, CI: "1" }, timeoutMs: 30_000, killGraceMs: 2000, maxOutputBytes: 64 * 1024 });
        if (result.code !== 0 || result.timedOut || result.overflowed || `${result.stdout}${result.stderr}`.trim() !== tool.version) throw new Error("native tool version differs from pin");
      } finally { rmSync(home, { recursive: true, force: true }); if (cwd) rmSync(cwd, { recursive: true, force: true }); }
    }
    return { ok: true, bin: paths[0]!, version: tools[0]!.version, ssh: { bin: paths[1]!, version: tools[1]!.version } };
  } catch (error) { return { ok: false, reason: `Render tools refused: ${(error as Error).message}` }; }
}
