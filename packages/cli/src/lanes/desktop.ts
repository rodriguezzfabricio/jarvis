import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate, type GateCheck, type GateInput, type GateResult } from "../checks/gate.ts";
import type { ChecksStore } from "../checks/store.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import { captureDesktopBundle, type DesktopArtifact } from "./desktop-artifact.ts";
import { verifyNativeObservation } from "./desktop-verify.ts";
import { fileHash } from "./materialize.ts";
import { validateDesktopPlan, type DesktopNativeObservation, type DesktopPlan, type NativeProbePolicy } from "./desktop-types.ts";
export type DesktopInput = Omit<GateInput, "check" | "extraEnv">;
export interface DesktopGateInput extends GateInput { afterCases: (checkout: string) => Promise<void> }
export interface DesktopRunDeps {
  gate?: (input: DesktopGateInput) => Promise<GateResult>;
  /** Native probe whose launcher sandboxes the app. Absent, native coverage is "not run" (decision 102). */
  probe?: (bundle: string, policy: NativeProbePolicy) => Promise<DesktopNativeObservation>;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}
export type DesktopResult = { status: "not run"; reason: string; result?: GateResult } | { status: "tampered" } | { status: GateResult["status"]; result: GateResult; native?: DesktopNativeObservation; entry?: LedgerEntry };
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Install build-only fixtures and a separate verifier. Native probe code never enters fixtures. */
export function installDesktopChecks(store: ChecksStore, plan: DesktopPlan): void {
  validateDesktopPlan(plan);
  const checks = join(store.checksDir, "desktop"); const fixture = join(store.checksDir, "fixtures", "desktop");
  if (existsSync(checks) || existsSync(fixture)) throw new Error("Desktop checks already installed; changes need review");
  for (const dir of [checks, join(fixture, "lanes"), join(fixture, "proc")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of ["desktop-types.ts", "desktop-build.ts", "desktop-worker.ts"]) copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(fixture, "lanes", file));
  copyFileSync(fileURLToPath(new URL("../proc/session.ts", import.meta.url)), join(fixture, "proc", "session.ts"));
  for (const file of ["desktop-verify.ts", "desktop-types.ts"]) copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(checks, file));
  for (const path of [join(checks, "plan.json"), join(fixture, "plan.json")]) writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
}
export function desktopCheck(plan: DesktopPlan): GateCheck {
  validateDesktopPlan(plan);
  return { name: "desktop-build", timeoutMs: plan.buildTimeoutMs + 5000, cases: [{ id: "desktop", command: `${quote(plan.nodeBin)} "$JARVIS_FIXTURES/desktop/lanes/desktop-worker.ts"` }], verify: `${quote(plan.nodeBin)} "$JARVIS_CHECKS/desktop/desktop-verify.ts"` };
}
function unavailable(result: GateResult): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(result.evidenceDir, "cases", "desktop", "stdout"), "utf8")) as { kind?: unknown; status?: unknown; reason?: unknown };
    if (raw.kind === "qa-desktop-build" && raw.status === "not run" && typeof raw.reason === "string" && raw.reason.startsWith("not run: desktop")) return raw.reason;
  } catch { /* A missing or malformed observation preserves the gate failure. */ }
  return undefined;
}
function recordNative(input: DesktopInput, result: GateResult, artifact: DesktopArtifact, native: DesktopNativeObservation, status: "pass" | "fail"): LedgerEntry {
  const observationPath = join(result.evidenceDir, "native-observation.json"); const bundlePath = join(result.evidenceDir, "native-bundle.json");
  writeFileSync(observationPath, JSON.stringify(native), { mode: 0o600 }); writeFileSync(bundlePath, JSON.stringify(artifact.files), { mode: 0o600 });
  return input.ledger.append({ kind: "gate_result", actor: "runner", task_id: input.taskId, attempt_id: input.attemptId, data: { check: "native-smoke", revision: input.revision, status, buildGateSeq: result.entry?.seq, evidence: { dir: result.evidenceDir, files: { "native-observation.json": fileHash(observationPath), "native-bundle.json": fileHash(bundlePath) } } } });
}

/** Build inside runGate; copy stopped build output; probe on the runner only after build verification passes. */
export async function runDesktop(input: DesktopInput, deps: DesktopRunDeps = {}): Promise<DesktopResult> {
  if (!input.store.verify(input.ledger).ok) return { status: "tampered" };
  const path = join(input.store.checksDir, "desktop", "plan.json");
  if (!existsSync(path)) return { status: "not run", reason: "not run: desktop (no protected plan)" };
  const plan = JSON.parse(readFileSync(path, "utf8")) as DesktopPlan; validateDesktopPlan(plan);
  if ((deps.platform ?? process.platform) !== "darwin" || !(deps.exists ?? existsSync)(plan.tauriBin)) return { status: "not run", reason: "not run: desktop (Tauri or macOS unavailable)" };
  const outputRoot = mkdtempSync(join(input.workRoot, "native-smoke-")); let artifact: DesktopArtifact | undefined;
  try {
    const result = await (deps.gate ?? runGate)({ ...input, extraEnv: {}, check: desktopCheck(plan), afterCases: async checkout => {
      if (existsSync(join(checkout, plan.bundle))) artifact = captureDesktopBundle(checkout, plan.bundle, outputRoot);
    } });
    if (result.status !== "pass") {
      const reason = result.status === "fail" ? unavailable(result) : undefined;
      return reason ? { status: "not run", reason, result } : { status: result.status, result };
    }
    if (!artifact) return { status: "not run", reason: "not run: desktop (protected build artifact handoff unavailable)", result };
    // The built app is candidate code: it runs only through an injected sandboxed launcher (decision 102).
    if (!deps.probe) return { status: "not run", reason: "not run: desktop (no sandboxed native launcher)", result };
    let native: DesktopNativeObservation;
    try { native = await deps.probe(artifact.bundlePath, { outputRoot, stayUpMs: plan.stayUpMs, shutdownMs: plan.shutdownMs }); }
    catch (error) { native = { kind: "qa-desktop-native", status: "fail", reason: String(error) }; }
    const status = verifyNativeObservation(native, plan.stayUpMs).ok ? "pass" : "fail";
    return { status, result, native, entry: recordNative(input, result, artifact, native, status) };
  } finally { rmSync(outputRoot, { recursive: true, force: true }); }
}
