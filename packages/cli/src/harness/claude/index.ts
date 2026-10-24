/** The Claude Code adapter: the only Claude-specific code (architecture §10). */
export { BUILD_TOOLS, buildTaskArgs, assertSafeTaskArgs } from "./args.ts";
export { buildChildEnv, findForbiddenEnv } from "./env.ts";
export { runCanaryProbe, type ProbeOptions, type ProbeResult } from "./probe.ts";
export { EvidenceCaptureError } from "./session.ts";
export { runSession, type SessionOutcome, type SessionSpec } from "./session.ts";
export { buildTaskSettings, cacheEnv, makeSessionTmpDir, sessionTmpEnv, writeTaskSettings, type TaskSettingsInput } from "./settings.ts";
export { hitRateLimitError, initInfo, parseStreamJson, rateLimits, toolCalls, usageWaitUntil, type RateLimitInfo } from "./streamjson.ts";
