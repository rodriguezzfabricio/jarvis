import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Cleanup hooks remove whole fixture trees (thousands of files, many git repos). Under the load of a
    // full suite plus a mutation run, removing ~4,000 entries took 14 s, past Vitest's 10 s default, and
    // the file-level "Hook timed out" made mutation verdicts ERROR (snapshot-scanner-backlog, Oct 25).
    hookTimeout: 60_000,
    // Inert context for the existing snapshot workers; process APIs remain native (decision 137).
    globalSetup: ["./tests/setup/real-git-global.ts"],
    // Decision 154: fsyncSync and fdatasyncSync keep native's checks and skip the device flush in test workers.
    setupFiles: ["./tests/setup/real-git.ts", "./tests/setup/nosync.ts"],
    // Live tests call the real, pinned Claude Code and use a little plan usage.
    // They only run when JARVIS_LIVE=1 (see tests/live/).
  },
});
