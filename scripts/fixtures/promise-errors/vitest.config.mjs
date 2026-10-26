import { defineConfig } from "vitest/config";
// Only for tests/unit/mutation-classify.test.ts: failures inside .rejects/.resolves chains, whose stacks
// Vitest rewrites to "Error: <message>". Never part of the normal suite.
export default defineConfig({ test: { include: ["scripts/fixtures/promise-errors/*.fixture.mjs"], root: process.cwd() } });
