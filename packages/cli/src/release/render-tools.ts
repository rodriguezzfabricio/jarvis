import { isAbsolute } from "node:path";
import { RENDER_TOOL_PINS } from "../config/pins.ts";
import type { DeployAdapterOptions, ProviderConfig } from "../broker/adapters/types.ts";
import { runCommand } from "../broker/adapters/execution.ts";

export interface NativeToolPin { bin: string; version: string; args: string[] }
export interface RenderToolPins { git: { bin: string; version: string }; ssh: { bin: string; version: string } }
/** Git and SSH from config/pins.ts RENDER_TOOL_PINS (decision 163). No fallback to PATH or a guessed version. */
export function renderTools(pins: RenderToolPins | undefined = RENDER_TOOL_PINS): readonly NativeToolPin[] | undefined {
  if (!pins || !isAbsolute(pins.git.bin) || !isAbsolute(pins.ssh.bin) || !pins.git.version || !pins.ssh.version) return undefined;
  return [{ ...pins.git, args: ["--version"] }, { ...pins.ssh, args: ["-V"] }];
}
export async function verifyRenderTools(options: DeployAdapterOptions, config: ProviderConfig): Promise<void> {
  if (config.interpreter || !/^git version \d+\.\d+\.\d+(?: \(Apple Git-\d+\))?$/.test(config.version)
    || config.ssh?.bin !== "/usr/bin/ssh" || !/^OpenSSH_[0-9][^\r\n]*$/.test(config.ssh.version)) throw new Error("pinned Git and system SSH required");
  for (const tool of [{ bin: config.bin, version: config.version, args: ["--version"] }, { ...config.ssh, args: ["-V"] }]) {
    const result = await runCommand(options, { ...config, bin: tool.bin }, { args: tool.args, env: {}, readUrl: () => "" });
    if (result.code !== 0 || result.timedOut || result.overflowed || `${result.stdout}${result.stderr}`.trim() !== tool.version) throw new Error("Render tool version verification failed");
  }
}
