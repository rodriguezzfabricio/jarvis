import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { GateCheck } from "../checks/gate.ts";
import type { SessionOutcome, SessionSpec } from "../proc/session.ts";
import { localTarget } from "./browser.ts";

export const IMPECCABLE_OUTPUT_BYTES = 1024 * 1024;
/** `sha256` is the engine file's hash: the runner refuses any other file at `bin` (decision 124). */
export interface ImpeccablePin { bin: string; version: string; sha256: string }
export type ImpeccableTarget = { kind: "source"; files: readonly string[] } | { kind: "url"; port: number; url: string };
export interface ImpeccableOptions {
  repo: string;
  /** The native engine pin, not the npm launcher (which can download an engine). */
  pin: ImpeccablePin;
  /** Required: the runner's sandboxed process adapter. No unrestricted default. */
  spawn: (spec: SessionSpec) => Promise<SessionOutcome>;
  isFile?: (path: string) => boolean;
  /** Test seam; production hashes the engine file before every run. */
  hashFile?: (path: string) => string;
}
const fileSha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const Finding = z.object({ antipattern: z.string().min(1).max(256), severity: z.string().min(1).max(32).optional(), message: z.string().max(8192).optional() }).passthrough();
export type ImpeccableFinding = z.infer<typeof Finding>;
export interface ImpeccableResult { status: "pass" | "fail" | "error"; findings: ImpeccableFinding[]; error?: string }
const errorResult = (error: string): ImpeccableResult => ({ status: "error", findings: [], error });

/** Called by the isolated verifier too. Exit 2 is findings; every incomplete scan is an error. */
export function evaluateImpeccable(raw: SessionOutcome): ImpeccableResult {
  if (raw.timedOut || raw.overflowed || ![0, 2].includes(raw.code ?? -1) || Buffer.byteLength(raw.stdout) > IMPECCABLE_OUTPUT_BYTES) return errorResult("Impeccable did not complete within its bounds");
  try {
    const findings = z.array(Finding).max(1000).parse(JSON.parse(raw.stdout));
    const primary = findings.some(f => f.severity !== "advisory");
    if ((raw.code === 2) !== primary) return errorResult("Impeccable exit and findings disagree");
    return { status: primary ? "fail" : "pass", findings };
  } catch { return errorResult("unparseable Impeccable output"); }
}

export function impeccableArguments(repo: string, target: ImpeccableTarget): string[] {
  const args = ["detect", "--json", "--no-config", "--no-inline-ignores"];
  if (target.kind === "source") {
    if (!target.files.length || target.files.length > 256) throw new Error("need a bounded changed source scope");
    for (const file of target.files) {
      if (!file || file.startsWith("-") || isAbsolute(file) || /[\\:\x00-\x1f]/.test(file) || file.split("/").some(p => !p || p === "." || p === "..")) throw new Error("invalid changed source path");
    }
    return [...args, ...target.files.map(file => resolve(repo, file))];
  }
  if (target.kind !== "url" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("need the runner's local CDP port");
  return [...args, "--no-overlay-hiding", "--no-consent-hiding", "--cdp", String(target.port), "--target", localTarget(target.url)];
}

export async function runImpeccable(options: ImpeccableOptions, target: ImpeccableTarget): Promise<ImpeccableResult> {
  try {
    if (!isAbsolute(options.repo) || !isAbsolute(options.pin.bin) || !/^\d+\.\d+\.\d+$/.test(options.pin.version) || !/^[a-f0-9]{64}$/.test(options.pin.sha256)) throw new Error("Impeccable requires an absolute engine pin, exact version and sha256");
    if (typeof options.spawn !== "function") throw new Error("sandboxed scanner adapter is required");
    const args = impeccableArguments(options.repo, target);
    if (!(options.isFile ?? (path => statSync(path).isFile()))(options.pin.bin)) throw new Error("pinned Impeccable is missing");
    // The exact engine file, not only a binary that prints the right version (decision 124).
    if ((options.hashFile ?? fileSha256)(options.pin.bin) !== options.pin.sha256) throw new Error("pinned Impeccable engine sha256 differs from its pin");
    const common = { bin: options.pin.bin, cwd: options.repo, env: { PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1", IMPECCABLE_NO_TELEMETRY: "1" }, timeoutMs: 120_000, maxOutputBytes: IMPECCABLE_OUTPUT_BYTES };
    const version = await options.spawn({ ...common, args: ["--version"] });
    if (version.code !== 0 || version.timedOut || version.overflowed || version.stdout.trim() !== `${options.pin.version}+engine`) throw new Error("pinned Impeccable version check failed");
    return evaluateImpeccable(await options.spawn({ ...common, args }));
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
}

export interface ImpeccableDefinitionInput { nodeBin: string; driver: string; verifier: string; config: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Driver/config live in fixtures; assertions live in checks, outside the candidate sandbox. */
export function impeccableDefinitions(input: ImpeccableDefinitionInput): Record<"impeccable-source" | "impeccable-url", GateCheck> {
  if (!isAbsolute(input.nodeBin)) throw new Error("Node pin must be absolute");
  for (const file of [input.driver, input.verifier, input.config]) if (!/^[\w./-]+$/.test(file) || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) throw new Error("invalid protected file path");
  const definition = (mode: "source" | "url"): GateCheck => ({
    name: `impeccable-${mode}`, timeoutMs: 120_000, allowLocalBinding: mode === "url",
    cases: [{ id: "scan", command: `${quote(input.nodeBin)} "$JARVIS_FIXTURES/${input.driver}" ${mode} "$JARVIS_FIXTURES/${input.config}"` }],
    verify: `${quote(input.nodeBin)} "$JARVIS_CHECKS/${input.verifier}" ${mode}`,
  });
  return { "impeccable-source": definition("source"), "impeccable-url": definition("url") };
}
