export { register } from "./command.ts";
export { LANES, selectLanes, type Lane, type LaneSelection, type CheckId, type SelectionInput } from "./selection.ts";
export { DESIGN_SECTIONS, lintDesign, lintTokens, type DesignLint, type DesignTokens, type TokenLintOptions } from "./design.ts";
export { detectAiTells, type TellOptions, type TellRule, type TellException } from "./tells.ts";
export { runLaneChecks, type LaneGateInput, type LaneCheckResult } from "./gates.ts";
export { runPlaywright, runMaestro, type QaOptions, type QaResult, type QaStatus, type QaObservation, type WebTarget, type IosTarget } from "./qa.ts";
export { observeWeb, type BrowserRuntime, type WebObservation } from "./browser.ts";
export {
  recordWebBaseline,
  verifyWebObservation,
  type WebBaseline,
  type WebExpectation,
  type ObservationVerification,
} from "./verify.ts";
export { readQaToolchain, verifyQaToolchain, loadBrowserRuntime, type QaToolchainInput, type QaToolchainManifest, type VerifiedQaToolchain } from "./toolchain.ts";
export type { SourceFile, Finding, LineRange } from "./source.ts";
export { installDesktopChecks, desktopCheck, runDesktop, type DesktopInput, type DesktopResult, type DesktopRunDeps, type DesktopGateInput } from "./desktop.ts";
export { observeDesktopBuild, probeDesktop, type DesktopBuildDeps, type NativeProbeDeps } from "./desktop-observe.ts";
export { verifyDesktopObservation, verifyDesktopEvidence, verifyNativeObservation } from "./desktop-verify.ts";
export type { DesktopPlan, DesktopBuildObservation, DesktopNativeObservation, NativeProbePolicy } from "./desktop-types.ts";
export type { DesktopProcess } from "./desktop-process.ts";
export { installChromiumBundle, type ChromiumInstallInput } from "./chromium-install.ts";
export { captureDesktopBundle, type DesktopArtifact } from "./desktop-artifact.ts";
export { installDesignChecks, type DesignChecksPlan } from "./impeccable-install.ts";
export { runImpeccable, evaluateImpeccable, impeccableDefinitions, type ImpeccablePin, type ImpeccableOptions, type ImpeccableResult, type ImpeccableTarget } from "./impeccable.ts";
export { verifyImpeccableObservation } from "./impeccable-verify.ts";
