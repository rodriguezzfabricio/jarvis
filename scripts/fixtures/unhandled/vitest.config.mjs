import { defineConfig } from "vitest/config";
// Only for tests/unit/mutation-classify.test.ts: a run that mixes an assertion failure with an
// unhandled rejection. Never part of the normal suite.
export default defineConfig({ test: { include: ["scripts/fixtures/unhandled/*.fixture.mjs"], root: process.cwd() } });
