import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopPlan } from "./desktop-types.ts";

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function verifyDesktopObservation(raw: unknown, plan: DesktopPlan): { ok: boolean; problems: string[] } {
  const observation = object(raw); const build = object(observation.build);
  const problems: string[] = [];
  if (observation.kind !== "qa-desktop-build" || observation.status !== "observed" || observation.bundle !== plan.bundle) problems.push("missing desktop build observation");
  if (build.code !== 0 || build.timedOut !== false || build.overflowed !== false) problems.push("desktop build did not complete");
  return { ok: problems.length === 0, problems };
}

export function verifyNativeObservation(raw: unknown, stayUpMs: number): { ok: boolean; problems: string[] } {
  const observation = object(raw); const shutdown = object(observation.shutdown); const problems: string[] = [];
  if (observation.kind !== "qa-desktop-native" || observation.status !== "observed" || !Number.isSafeInteger(observation.pid) || Number(observation.pid) <= 0) problems.push("missing native process observation");
  if (typeof observation.stayedUpMs !== "number" || !Number.isFinite(observation.stayedUpMs) || observation.stayedUpMs < stayUpMs) problems.push("desktop process did not stay up");
  if (observation.menuBar !== true) problems.push("missing native menu-bar item");
  if (shutdown.code !== 0 || shutdown.signal !== null) problems.push("unclean native shutdown");
  return { ok: problems.length === 0, problems };
}

/** Runs with observations only, outside the candidate sandbox. */
export function verifyDesktopEvidence(outDir: string, plan: DesktopPlan, completionFile: string): string {
  const dir = join(outDir, "desktop");
  if (readFileSync(join(dir, "code"), "utf8").trim() !== "0") throw new Error("desktop driver failed");
  const result = verifyDesktopObservation(JSON.parse(readFileSync(join(dir, "stdout"), "utf8")), plan);
  if (!result.ok) throw new Error(result.problems.join("; "));
  const nonce = readFileSync(completionFile, "utf8").trim();
  return `JARVIS-CHECK-COMPLETE ${nonce}`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const plan = JSON.parse(readFileSync(join(process.env.JARVIS_CHECKS!, "desktop", "plan.json"), "utf8")) as DesktopPlan;
    console.log(verifyDesktopEvidence(process.env.JARVIS_OUT!, plan, process.env.JARVIS_COMPLETION_FILE!));
  } catch { process.exitCode = 1; }
}
