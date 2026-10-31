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
  ReleaseEvidence, ReleaseManifest, ReleaseProjectConfig, ReleaseState, SmokeInput, StateResult } from "./types.ts";
