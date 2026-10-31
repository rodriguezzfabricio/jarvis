import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSession } from "../../proc/session.ts";
import { realChild } from "../../release/paths.ts";
import type { Provider } from "../../release/types.ts";
import type { DeployAdapterOptions, ProviderCommand, ProviderConfig } from "./types.ts";

/** Each process gets fresh runner-only directories; provider state never survives to the next call. */
export async function runCommand(options: DeployAdapterOptions, config: ProviderConfig, command: ProviderCommand) {
  const homeRoot = realChild(options.ledger.dir, config.home, true);
  const cwdRoot = realChild(options.ledger.dir, config.cwd, true);
  const home = mkdtempSync(join(homeRoot, "provider-home-"));
  let control: string | undefined;
  try {
    control = mkdtempSync(join(cwdRoot, "provider-control-"));
    const cwd = join(control, "cwd"); mkdirSync(cwd, { mode: 0o700 });
    return await (options.run ?? runSession)({ bin: config.bin, args: command.args, cwd,
      env: { PATH: "/usr/bin:/bin", HOME: home, CI: "1", ...command.env }, timeoutMs: options.timeoutMs ?? 120_000,
      killGraceMs: 5_000, maxOutputBytes: 1024 * 1024 });
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (control) rmSync(control, { recursive: true, force: true });
  }
}

/** Version probes run before credentials are read; failures cannot become a deployment attempt. */
export async function verifyProvider(options: DeployAdapterOptions, config: ProviderConfig, provider: Provider): Promise<void> {
  if (!config.version || !/^\d+\.\d+\.\d+$/.test(config.version)) throw new Error("exact provider version required");
  const result = await runCommand(options, config, { args: ["--version"], env: {}, readUrl: () => "" });
  const output = result.stdout.trim();
  const version = provider === "vercel" ? /^(?:Vercel CLI )?(\d+\.\d+\.\d+)$/.exec(output)?.[1]
    : /^netlify\/(\d+\.\d+\.\d+)(?: [A-Za-z0-9_.-]+)*$/.exec(output)?.[1];
  if (result.code !== 0 || result.timedOut || result.overflowed || version !== config.version) throw new Error("provider version verification failed");
}
