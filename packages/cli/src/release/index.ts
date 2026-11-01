/** Runner-facing release API. Task sessions prepare manifests; they never write this evidence. */
export { artifactDigest, checkManifest, manifestHash, parseManifest, releaseRef } from "./manifest.ts";
export { copyDeploymentArtifacts } from "./artifacts.ts";
export { grantRelease, hasReleaseGrant } from "./grants.ts";
export { evidenceIntact, isReleaseReady, missingEvidence, reachState, recordObservation, recordPlan, releaseScope, releaseStatus, REQUIRED_FAILURE_SIGNAL_KIND, type ReleaseStatus, type ReleaseView } from "./states.ts";
export { acceptedManifest, latestAccepted, recordAcceptedManifest } from "./accepted.ts";
export { createDataSnapshot, runRehearsal } from "./rehearsal.ts";
export { dockerCopyExecutor, type DockerCopyOptions } from "./docker.ts";
export { recoverFailedSmoke, runSmoke } from "./smoke.ts";
export type { CopyCommands, CopyCommandSpec, Provider, ReachStateInput, RecoveryInput, RehearsalInput, ReleaseAction,
  ReleaseEvidence, ReleaseManifest, ReleaseProjectConfig, ReleaseState, WebReleaseState, SmokeInput, StateResult } from "./types.ts";

export { desktopReleasePlan, installDesktopRelease, missingDesktopEvidence, desktopReleaseView, runDesktopRelease, DESKTOP_ARTIFACT_TYPE, NATIVE_SMOKE_REASON, type DesktopReleaseView } from "./desktop.ts";
export { prepareRelease, runReleaseStep, type ReleaseRuntime, type ReleaseSeams, type ReleaseStepInput, type ReleaseStepOutcome } from "./run.ts";
export { loadReleaseSetup, parseReleaseSetup, saveReleaseSetup, type DesktopReleaseSetup, type WebReleaseSetup, type ReleaseSetup } from "./config.ts";
