import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Runs the real git in place of macOS's /usr/bin/git shim (about 14 ms of CPU saved per spawn); see tests/setup/real-git.ts.
    globalSetup: ["./tests/setup/real-git-global.ts"],
    setupFiles: ["./tests/setup/real-git.ts"],
    // Live tests call the real, pinned Claude Code and use a little plan usage.
    // They only run when JARVIS_LIVE=1 (see tests/live/).
  },
});
