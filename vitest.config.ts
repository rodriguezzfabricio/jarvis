import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Live tests call the real, pinned Claude Code and use a little plan usage.
    // They only run when JARVIS_LIVE=1 (see tests/live/).
  },
});
