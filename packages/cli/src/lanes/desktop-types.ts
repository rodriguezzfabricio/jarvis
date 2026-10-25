import { isAbsolute } from "node:path";
import type { SessionOutcome } from "../proc/session.ts";
export interface DesktopPlan {
  nodeBin: string;
  tauriBin: string;
  build: { bin: string; args: readonly string[] };
  bundle: string;
  stayUpMs: number;
  shutdownMs: number;
  buildTimeoutMs: number;
}
export interface DesktopBuildObservation {
  kind: "qa-desktop-build";
  status: "observed" | "fail" | "not run";
  bundle: string;
  reason?: string;
  build?: Pick<SessionOutcome, "code" | "timedOut" | "overflowed">;
}
export interface DesktopNativeObservation {
  kind: "qa-desktop-native";
  status: "observed" | "fail";
  reason?: string;
  pid?: number;
  stayedUpMs?: number;
  menuBar?: boolean;
  shutdown?: { code: number | null; signal: string | null };
}
export interface NativeProbePolicy { outputRoot: string; stayUpMs: number; shutdownMs: number }
export const validDuration = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 3_600_000;
export function validateDesktopPlan(plan: DesktopPlan): void {
  if (![plan.nodeBin, plan.tauriBin, plan.build?.bin].every(p => typeof p === "string" && isAbsolute(p) && !/[\x00-\x1f]/.test(p))) throw new Error("Desktop binaries must be absolute");
  if (!Array.isArray(plan.build.args) || !plan.build.args.every(a => typeof a === "string" && !a.includes("\0"))) throw new Error("Invalid desktop build arguments");
  if (typeof plan.bundle !== "string" || !plan.bundle.endsWith(".app") || isAbsolute(plan.bundle) || /[\\:\x00-\x1f]/.test(plan.bundle) || plan.bundle.split("/").some(s => !s || s === "." || s === "..")) throw new Error("Desktop bundle must be checkout-relative");
  if (![plan.stayUpMs, plan.shutdownMs, plan.buildTimeoutMs].every(validDuration)) throw new Error("Desktop durations must be positive, bounded milliseconds");
}
