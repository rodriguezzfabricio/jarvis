import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SessionOutcome, SessionSpec } from "../proc/session.ts";
import { localTarget } from "./browser.ts";
import { protectedQaFile, readQaToolchain, type QaToolchainInput } from "./toolchain.ts";

export type QaStatus = "observed" | "fail" | "error" | "not run" | "web-only";
export interface QaObservation { name: "playwright" | "axe" | "maestro"; status: QaStatus; reason?: string; outcome?: SessionOutcome }
export interface QaResult { status: QaStatus; verified: false; checks: QaObservation[] }
export interface QaOptions {
  repo: string;
  nodeBin: string;
  maestroBin?: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Mandatory sandboxed process seam. Never execute candidate tools with runner privileges. */
  spawn: (spec: SessionSpec) => Promise<SessionOutcome>;
  /** For discovery in a verified checkout or in tests. */
  isFile?: (path: string) => boolean;
  /** Runner-owned driver installed into checks/fixtures; defaults to the shipped driver. */
  browserDriver?: string;
  toolchain?: QaToolchainInput | undefined;
}
export interface WebTarget { url: string; testFiles?: readonly string[] }
export interface IosTarget { simulatorId: string; appId: string; builtApp: boolean; flows: readonly string[] }

const ENV = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "PLAYWRIGHT_BROWSERS_PATH"]);
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

function validate(options: QaOptions): void {
  if (!isAbsolute(options.repo) || !isAbsolute(options.nodeBin)) throw new Error("QA needs absolute repository and Node paths");
  if (options.maestroBin && !isAbsolute(options.maestroBin)) throw new Error("Maestro must be located by pins or doctor, never PATH");
  if (Object.keys(options.env).some(k => !ENV.has(k))) throw new Error("QA environment must use the runner's explicit allowlist");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("QA timeout must be positive and finite");
}

function relativeFiles(files: readonly string[]): void {
  for (const p of files) if (!p || p.startsWith("-") || isAbsolute(p) || /[\\\x00-\x1f:]/.test(p) || p.split("/").some(v => !v || v === "." || v === "..")) throw new Error("QA test files must be relative paths, never command options");
}

async function command(options: QaOptions, name: QaObservation["name"], bin: string, args: string[]): Promise<QaObservation> {
  try {
    const outcome = await options.spawn({ bin, args, cwd: options.repo, env: { ...options.env }, timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: 16 * 1024 * 1024 });
    const status = outcome.code === 0 && !outcome.timedOut && !outcome.overflowed ? "observed" : "fail";
    return { name, status, outcome };
  } catch (error) { return { name, status: "error", reason: String(error instanceof Error ? error.message : error) }; }
}

function result(checks: QaObservation[]): QaResult {
  const status = checks.some(c => c.status === "error") ? "error" : checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "web-only") ? "web-only" : checks.some(c => c.status === "not run") ? "not run" : "observed";
  return { status, verified: false, checks };
}

/** Project tests and browser output are observations. Only runGate can make a protected pass. */
export async function runPlaywright(options: QaOptions, target?: WebTarget): Promise<QaResult> {
  validate(options);
  if (!target) return result([{ name: "playwright", status: "not run", reason: "no running web target" }]);
  const url = localTarget(target.url);
  relativeFiles(target.testFiles ?? []);
  if (!options.toolchain || !options.browserDriver) return result([{ name: "playwright", status: "not run", reason: "no approved runner QA toolchain or driver" }]);
  const tools = readQaToolchain(options.toolchain, options.repo);
  const driver = protectedQaFile(options.browserDriver, join(options.toolchain.store.checksDir, "fixtures"), options.repo);
  const checks = [await command(options, "playwright", options.nodeBin, [tools.playwrightCli, "test", ...(target.testFiles ?? []), "--reporter=json"])];
  checks.push(await command(options, "axe", options.nodeBin, [driver, tools.manifestPath, tools.manifestHash, url, options.repo]));
  return result(checks);
}

export async function runMaestro(options: QaOptions, target?: IosTarget, webCovered = false): Promise<QaResult> {
  validate(options);
  const unavailable = (reason: string) => result([{ name: "maestro", status: webCovered ? "web-only" : "not run", reason }]);
  if (!target?.builtApp || !target.simulatorId || !target.appId || !target.flows.length) return unavailable("need a built app, iOS simulator and Maestro flows");
  relativeFiles(target.flows);
  if (!/^[A-Za-z0-9._-]+$/.test(target.simulatorId) || target.simulatorId.startsWith("-")) throw new Error("invalid simulator id");
  if (!options.maestroBin || !(options.isFile ?? isFile)(options.maestroBin)) return unavailable("Maestro was not located by pins or doctor");
  const checks: QaObservation[] = [];
  for (const flow of target.flows) checks.push(await command(options, "maestro", options.maestroBin, ["--device", target.simulatorId, "test", flow]));
  return result(checks);
}
