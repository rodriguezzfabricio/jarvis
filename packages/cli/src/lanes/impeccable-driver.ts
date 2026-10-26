import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runSession } from "../proc/session.ts";
import { scanImpeccableBrowser } from "./impeccable-browser.ts";
import { runImpeccable, type ImpeccablePin } from "./impeccable.ts";

export interface ImpeccableDriverConfig {
  pin: ImpeccablePin;
  files: string[];
  browser?: {manifest: string; manifestHash: string; url: string; port: number};
}

/** Install only as a gate case. Its subprocesses inherit the gate's sandbox and have no network fallback. */
export async function impeccableDriver(mode: "source" | "url", config: ImpeccableDriverConfig, repo: string): Promise<unknown> {
  const options = {repo, pin: config.pin, spawn: runSession};
  if (mode === "source") return {kind: "impeccable-source", result: await runImpeccable(options, {kind: "source", files: config.files})};
  if (!config.browser) throw new Error("no approved browser configuration");
  return scanImpeccableBrowser({...config.browser, repo}, target => runImpeccable(options, target));
}
async function main(): Promise<void> {
  const [mode, config] = process.argv.slice(2);
  if ((mode !== "source" && mode !== "url") || !config) throw new Error("usage: impeccable-driver.ts source|url <protected config>");
  console.log(JSON.stringify(await impeccableDriver(mode, JSON.parse(readFileSync(config, "utf8")) as ImpeccableDriverConfig, process.cwd())));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
